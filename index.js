const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json({ limit: '10mb' }));

const CHATWOOT_URL = process.env.CHATWOOT_URL || 'https://chatwoot-production-a854.up.railway.app';
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || 'BfidqF6qHrqUww7Ym8BJwB9r';
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-7e02.up.railway.app';
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY || '709fc5814164a0db1eef262ec157a9e113979a650221785906ed72c9a33cfa0c';

const INSTANCE_MAP = {
  'casadafe-c01': { inbox_id: 5, inbox_identifier: 'b9JNEaVY73GARnoR6R2ieWvf', phone: '67991746143', label: 'C01' },
  'casadafe-c02': { inbox_id: 1, inbox_identifier: 'ecQSEiiryRXjt9mcZL7uNNGX', phone: '67992138572', label: 'C02' },
  'casadafe-c03': { inbox_id: 2, inbox_identifier: 'SZ5MYpuSnbN13jeRUL4oxNa6', phone: '67992132353', label: 'C03' },
  'casadafe-c04': { inbox_id: 3, inbox_identifier: 'nvbGe4V3rwGYfJAcvU1F18hT', phone: '67981021304', label: 'C04' },
  'casadafe-c05': { inbox_id: 4, inbox_identifier: 'XDHFCXxCGKMhEkB9RkjLDZth', phone: '67981259143', label: 'C05' }
};
var cache = {};
// Anti-loop: cache de msgs enviadas pelo Chatwoot->WA (guarda por 60s)
var sentFromChatwoot = {};

var cwApi = axios.create({ baseURL: CHATWOOT_URL + '/api/v1/accounts/' + ACCOUNT_ID, headers: { 'api_access_token': CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' }, timeout: 15000 });

async function getOrCreateContact(num, name, inboxId) {
  var k = inboxId + ':' + num;
  if (cache[k] && cache[k].contact_id) return cache[k].contact_id;
  try {
    var s = await cwApi.get('/contacts/search?q=' + num);
    var c = s.data.payload || [];
    if (c.length > 0) { cache[k] = cache[k] || {}; cache[k].contact_id = c[0].id; return c[0].id; }
  } catch(e) {}
  var r = await cwApi.post('/contacts', { name: name, phone_number: '+' + num, identifier: 'whatsapp:' + num });
  var id = r.data.payload.contact.id;
  cache[k] = cache[k] || {}; cache[k].contact_id = id;
  return id;
}

async function getOrCreateConv(contactId, inboxId, num) {
  var k = inboxId + ':' + num;
  if (cache[k] && cache[k].conv_id) {
    try { var cv = await cwApi.get('/conversations/' + cache[k].conv_id); if (cv.data.status === 'open' || cv.data.status === 'pending') return cache[k].conv_id; } catch(e) {}
  }
  try {
    var cs = await cwApi.get('/contacts/' + contactId + '/conversations');
    var convs = cs.data.payload || [];
    for (var i = 0; i < convs.length; i++) {
      if (convs[i].inbox_id === inboxId && (convs[i].status === 'open' || convs[i].status === 'pending')) {
        cache[k] = cache[k] || {}; cache[k].conv_id = convs[i].id; return convs[i].id;
      }
    }
  } catch(e) {}
  var r = await cwApi.post('/conversations', { contact_id: contactId, inbox_id: inboxId, status: 'open' });
  cache[k] = cache[k] || {}; cache[k].conv_id = r.data.id;
  return r.data.id;
}

function extractContent(msg) {
  if (!msg) return '[Msg]';
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage && msg.extendedTextMessage.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage) return msg.imageMessage.caption ? '[Img] ' + msg.imageMessage.caption : '[Imagem]';
  if (msg.videoMessage) return '[Video]';
  if (msg.audioMessage) return '[Audio]';
  if (msg.documentMessage) return '[Doc]';
  if (msg.stickerMessage) return '[Sticker]';
  if (msg.protocolMessage) return null;
  return '[Msg]';
}

app.post('/webhook/:instance', async (req, res) => {
  var inst = req.params.instance, cfg = INSTANCE_MAP[inst], ts = new Date().toISOString();
  if (!cfg) return res.status(200).json({ s: 'unknown' });
  var body = req.body, ev = body.event;
  if (!ev || (ev !== 'messages.upsert' && ev !== 'MESSAGES_UPSERT')) return res.status(200).json({ s: 'skip' });
  var data = body.data || body, key = data.key, msg = data.message;
  if (!key) return res.status(200).json({ s: 'skip' });
  var jid = key.remoteJid || '';
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return res.status(200).json({ s: 'skip' });
  var num = jid.replace('@s.whatsapp.net', '');
  var content = extractContent(msg);
  if (content === null) return res.status(200).json({ s: 'protocol' });

  if (key.fromMe) {
    // ANTI-LOOP: se essa msg foi enviada pelo Chatwoot, ignora
    var cacheKey = cfg.label + ':' + num + ':' + content.substring(0, 50);
    if (sentFromChatwoot[cacheKey]) {
      console.log('[' + ts + '] [' + cfg.label + '] Anti-loop: msg do Chatwoot, ignorando');
      delete sentFromChatwoot[cacheKey];
      return res.status(200).json({ s: 'anti_loop' });
    }
    // Msg do Zapped/celular - registrar no Chatwoot como outgoing
    console.log('[' + ts + '] [' + cfg.label + '] ZAPPED->CW (' + num + '): ' + content.substring(0, 80));
    try {
      var name = data.pushName || num;
      var cid = await getOrCreateContact(num, name, cfg.inbox_id);
      var convId = await getOrCreateConv(cid, cfg.inbox_id, num);
      await cwApi.post('/conversations/' + convId + '/messages', { content: content, message_type: 'outgoing', private: false });
      console.log('[' + ts + '] [' + cfg.label + '] OUTGOING registrada conv=' + convId);
    } catch(err) {
      console.error('[' + ts + '] [' + cfg.label + '] ERR outgoing: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
    }
    return res.status(200).json({ s: 'outgoing_registered' });
  }

  // Msg de cliente (incoming)
  var name = data.pushName || num;
  console.log('[' + ts + '] [' + cfg.label + '] ' + name + ' (' + num + '): ' + content);
  try {
    var cid = await getOrCreateContact(num, name, cfg.inbox_id);
    var convId = await getOrCreateConv(cid, cfg.inbox_id, num);
    await cwApi.post('/conversations/' + convId + '/messages', { content: content, message_type: 'incoming', private: false });
    console.log('[' + ts + '] [' + cfg.label + '] INCOMING conv=' + convId);
  } catch(err) {
    console.error('[' + ts + '] [' + cfg.label + '] ERR: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
  }
  res.status(200).json({ s: 'ok' });
});

app.post('/chatwoot-webhook', async (req, res) => {
  var ts = new Date().toISOString();
  if (req.body.event !== 'message_created') return res.status(200).json({ s: 'skip' });
  var m = req.body;
  if (m.message_type !== 'outgoing' || !m.content || m.content_type === 'activity' || m.private) return res.status(200).json({ s: 'skip' });
  var iid = m.conversation && m.conversation.inbox_id;
  var eInst = null, eCfg = null;
  for (var i in INSTANCE_MAP) { if (INSTANCE_MAP[i].inbox_id === iid) { eInst = i; eCfg = INSTANCE_MAP[i]; break; } }
  if (!eInst) return res.status(200).json({ s: 'no_map' });
  var meta = (m.conversation && m.conversation.meta && m.conversation.meta.sender) || {};
  var ph = (meta.phone_number || '').replace(/[^0-9]/g, '');
  if (!ph) ph = (meta.identifier || '').replace('whatsapp:', '').replace(/[^0-9]/g, '');
  if (!ph && m.sender) ph = (m.sender.phone_number || '').replace(/[^0-9]/g, '');
  if (!ph) return res.status(200).json({ s: 'no_ph' });
  // ANTI-LOOP: marcar que essa msg foi enviada pelo Chatwoot
  var cacheKey = eCfg.label + ':' + ph + ':' + m.content.substring(0, 50);
  sentFromChatwoot[cacheKey] = true;
  setTimeout(function() { delete sentFromChatwoot[cacheKey]; }, 60000);
  console.log('[' + ts + '] [' + eCfg.label + '] CW->WA: ' + ph);
  try {
    await axios.post(EVOLUTION_URL + '/message/sendText/' + eInst, { number: ph, text: m.content }, { headers: { 'apikey': EVOLUTION_APIKEY, 'Content-Type': 'application/json' }, timeout: 15000 });
    console.log('[' + ts + '] Sent to WA ' + ph);
  } catch(err) { console.error('WA err: ' + (err.response ? JSON.stringify(err.response.data) : err.message)); }
  res.status(200).json({ s: 'ok' });
});

app.get('/health', (req, res) => { res.json({ status: 'running', v: 5, instances: Object.keys(INSTANCE_MAP) }); });
var PORT = process.env.PORT || 3100;
app.listen(PORT, () => { console.log('Bridge v5 porta ' + PORT); for (var n in INSTANCE_MAP) console.log('  ' + INSTANCE_MAP[n].label + ' -> inbox ' + INSTANCE_MAP[n].inbox_id); });
