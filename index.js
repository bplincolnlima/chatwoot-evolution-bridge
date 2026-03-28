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
  'casadafe-c02': { inbox_id: 1, inbox_identifier: 'ecQSEiiryRXjt9mcZL7uNNGX', phone: '67992138572', label: 'C02' },
  'casadafe-c03': { inbox_id: 2, inbox_identifier: 'SZ5MYpuSnbN13jeRUL4oxNa6', phone: '67992132353', label: 'C03' },
  'casadafe-c04': { inbox_id: 3, inbox_identifier: 'nvbGe4V3rwGYfJAcvU1F18hT', phone: '67981021304', label: 'C04' },
  'casadafe-c05': { inbox_id: 4, inbox_identifier: 'XDHFCXxCGKMhEkB9RkjLDZth', phone: '67981259143', label: 'C05' }
};
const contactCache = {};

app.post('/webhook/:instance', async (req, res) => {
  const instance = req.params.instance;
  const config = INSTANCE_MAP[instance];
  const ts = new Date().toISOString();
  if (!config) return res.status(200).json({ status: 'unknown' });

  const body = req.body;
  // DEBUG: log raw payload keys
  console.log('[' + ts + '] [' + config.label + '] RAW event=' + body.event + ' keys=' + Object.keys(body).join(','));

  // Evolution v2.x: event pode ser body.event, data pode ser body.data ou body direto
  const event = body.event;
  if (!event) {
    console.log('[' + ts + '] [' + config.label + '] No event field, ignoring');
    return res.status(200).json({ status: 'no_event' });
  }
  if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') {
    console.log('[' + ts + '] [' + config.label + '] Event: ' + event + ' (ignored)');
    return res.status(200).json({ status: 'ignored_event' });
  }

  // Evolution v2.x: data pode estar em body.data ou direto no body
  const data = body.data || body;
  const key = data.key;
  const msg = data.message;

  // Se nao tem key, tentar formato alternativo
  if (!key) {
    console.log('[' + ts + '] [' + config.label + '] No key in data. Data keys: ' + Object.keys(data).join(','));
    return res.status(200).json({ status: 'no_key' });
  }

  if (key.fromMe) return res.status(200).json({ status: 'own_msg' });
  var remoteJid = key.remoteJid || '';
  if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return res.status(200).json({ status: 'ignored' });

  var senderNumber = remoteJid.replace('@s.whatsapp.net', '');
  var senderName = data.pushName || senderNumber;
  var content = '';
  if (msg && msg.conversation) content = msg.conversation;
  else if (msg && msg.extendedTextMessage && msg.extendedTextMessage.text) content = msg.extendedTextMessage.text;
  else if (msg && msg.imageMessage) content = msg.imageMessage.caption ? '[Img] ' + msg.imageMessage.caption : '[Imagem]';
  else if (msg && msg.videoMessage) content = '[Video]';
  else if (msg && msg.audioMessage) content = '[Audio]';
  else if (msg && msg.documentMessage) content = '[Doc] ' + (msg.documentMessage.fileName || '');
  else if (msg && msg.stickerMessage) content = '[Sticker]';
  else if (msg && msg.contactMessage) content = '[Contato]';
  else if (msg && msg.locationMessage) content = '[Localizacao]';
  else if (msg && msg.reactionMessage) content = '[Reacao]';
  else if (msg && msg.protocolMessage) return res.status(200).json({ status: 'protocol' });
  else content = '[Msg]';

  var identifier = 'whatsapp:' + senderNumber;
  console.log('[' + ts + '] [' + config.label + '] MSG de ' + senderName + ' (' + senderNumber + '): ' + content);

  try {
    var sourceId = contactCache[identifier] && contactCache[identifier].source_id;
    if (!sourceId) {
      var cResp = await axios.post(CHATWOOT_URL + '/public/api/v1/inboxes/' + config.inbox_identifier + '/contacts', {
        identifier: identifier, name: senderName, phone_number: '+' + senderNumber
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
      sourceId = cResp.data.source_id;
      contactCache[identifier] = { source_id: sourceId };
      console.log('[' + ts + '] [' + config.label + '] Contato criado: ' + sourceId);
    }
    var convResp = await axios.post(CHATWOOT_URL + '/public/api/v1/inboxes/' + config.inbox_identifier + '/contacts/' + sourceId + '/conversations', {
      content: content
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
    console.log('[' + ts + '] [' + config.label + '] Enviado ao Chatwoot conv=' + convResp.data.id);
  } catch (err) {
    console.error('[' + ts + '] [' + config.label + '] ERRO: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
    // Fallback: buscar contato existente
    if (err.response && err.response.status === 422) {
      try {
        var sResp = await axios.get(CHATWOOT_URL + '/api/v1/accounts/' + ACCOUNT_ID + '/contacts/search?q=' + senderNumber, {
          headers: { 'api_access_token': CHATWOOT_API_TOKEN }, timeout: 10000
        });
        var contacts = sResp.data.payload || [];
        if (contacts.length > 0) {
          await axios.post(CHATWOOT_URL + '/api/v1/accounts/' + ACCOUNT_ID + '/conversations', {
            inbox_id: config.inbox_id, contact_id: contacts[0].id, message: { content: content }
          }, { headers: { 'api_access_token': CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' }, timeout: 10000 });
          console.log('[' + ts + '] [' + config.label + '] Fallback OK');
        }
      } catch (e2) { console.error('[' + ts + '] Fallback erro: ' + e2.message); }
    }
  }
  res.status(200).json({ status: 'ok' });
});

app.post('/chatwoot-webhook', async (req, res) => {
  var ts = new Date().toISOString();
  if (req.body.event !== 'message_created') return res.status(200).json({ status: 'ignored' });
  var message = req.body;
  if (message.message_type !== 'outgoing') return res.status(200).json({ status: 'not_outgoing' });
  if (!message.content || message.content_type === 'activity' || message.private) return res.status(200).json({ status: 'skip' });
  var inboxId = message.conversation && message.conversation.inbox_id;
  var evolutionInstance = null, instanceConfig = null;
  for (var inst in INSTANCE_MAP) {
    if (INSTANCE_MAP[inst].inbox_id === inboxId) { evolutionInstance = inst; instanceConfig = INSTANCE_MAP[inst]; break; }
  }
  if (!evolutionInstance) return res.status(200).json({ status: 'no_map' });
  var meta = (message.conversation && message.conversation.meta && message.conversation.meta.sender) || {};
  var phone = (meta.phone_number || '').replace(/[^0-9]/g, '');
  if (!phone) phone = (meta.identifier || '').replace('whatsapp:', '').replace(/[^0-9]/g, '');
  if (!phone && message.sender) phone = (message.sender.phone_number || '').replace(/[^0-9]/g, '');
  if (!phone) return res.status(200).json({ status: 'no_phone' });
  console.log('[' + ts + '] [' + instanceConfig.label + '] CW->WA: ' + phone);
  try {
    await axios.post(EVOLUTION_URL + '/message/sendText/' + evolutionInstance, {
      number: phone, text: message.content
    }, { headers: { 'apikey': EVOLUTION_APIKEY, 'Content-Type': 'application/json' }, timeout: 15000 });
    console.log('[' + ts + '] Sent to WA ' + phone);
  } catch (err) { console.error('WA send err: ' + (err.response ? JSON.stringify(err.response.data) : err.message)); }
  res.status(200).json({ status: 'ok' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'running', ts: new Date().toISOString(), instances: Object.keys(INSTANCE_MAP) });
});

var PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log('Bridge v2 porta ' + PORT);
  for (var n in INSTANCE_MAP) console.log('  ' + INSTANCE_MAP[n].label + ' | ' + n + ' (' + INSTANCE_MAP[n].phone + ') -> inbox ' + INSTANCE_MAP[n].inbox_id);
});
