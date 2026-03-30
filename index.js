const express = require('express');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FormData = require('form-data');

let ffmpeg, ffmpegPath;
try {
  ffmpeg = require('fluent-ffmpeg');
  ffmpegPath = require('ffmpeg-static');
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log('ffmpeg loaded OK');
} catch (e) {
  console.log('ffmpeg not available, audio sent as-is');
  ffmpeg = null;
}

const app = express();
app.use(express.json({ limit: '25mb' }));

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
var sentFromChatwoot = {};
var cwApi = axios.create({ baseURL: CHATWOOT_URL + '/api/v1/accounts/' + ACCOUNT_ID, headers: { 'api_access_token': CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' }, timeout: 20000 });

async function getOrCreateContact(num, name, inboxId) {
  var k = inboxId + ':' + num;
  if (cache[k] && cache[k].contact_id) return cache[k].contact_id;
  try { var s = await cwApi.get('/contacts/search?q=' + encodeURIComponent(num)); var c = s.data.payload || []; if (c.length > 0) { cache[k] = cache[k] || {}; cache[k].contact_id = c[0].id; return c[0].id; } } catch (e) {}
  var r = await cwApi.post('/contacts', { name: name, phone_number: '+' + num, identifier: 'whatsapp:' + num });
  var id = r.data.payload.contact.id; cache[k] = cache[k] || {}; cache[k].contact_id = id; return id;
}

async function getOrCreateConv(contactId, inboxId, num) {
  var k = inboxId + ':' + num;
  if (cache[k] && cache[k].conv_id) { try { var cv = await cwApi.get('/conversations/' + cache[k].conv_id); if (cv.data.status === 'open' || cv.data.status === 'pending') return cache[k].conv_id; } catch (e) {} }
  try { var cs = await cwApi.get('/contacts/' + contactId + '/conversations'); var convs = cs.data.payload || []; for (var i = 0; i < convs.length; i++) { if (convs[i].inbox_id === inboxId && (convs[i].status === 'open' || convs[i].status === 'pending')) { cache[k] = cache[k] || {}; cache[k].conv_id = convs[i].id; return convs[i].id; } } } catch (e) {}
  var r = await cwApi.post('/conversations', { contact_id: contactId, inbox_id: inboxId, status: 'open' }); cache[k] = cache[k] || {}; cache[k].conv_id = r.data.id; return r.data.id;
}

function extractContent(msg) {
  if (!msg) return '[Msg]';
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage && msg.extendedTextMessage.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage) return msg.imageMessage.caption || '';
  if (msg.videoMessage) return msg.videoMessage.caption || '';
  if (msg.audioMessage) return '';
  if (msg.documentMessage) return msg.documentMessage.fileName ? '[Doc] ' + msg.documentMessage.fileName : '[Doc]';
  if (msg.stickerMessage) return '[Sticker]';
  if (msg.protocolMessage) return null;
  return '[Msg]';
}

function getMediaType(msg) {
  if (!msg) return null;
  if (msg.audioMessage) return { type: 'audio', mimetype: msg.audioMessage.mimetype || 'audio/ogg; codecs=opus', ext: '.ogg' };
  if (msg.imageMessage) return { type: 'image', mimetype: msg.imageMessage.mimetype || 'image/jpeg', ext: '.jpg' };
  if (msg.videoMessage) return { type: 'video', mimetype: msg.videoMessage.mimetype || 'video/mp4', ext: '.mp4' };
  if (msg.documentMessage) return { type: 'document', mimetype: msg.documentMessage.mimetype || 'application/octet-stream', ext: path.extname(msg.documentMessage.fileName || '.bin') };
  if (msg.stickerMessage) return { type: 'sticker', mimetype: 'image/webp', ext: '.webp' };
  return null;
}

async function downloadMediaFromEvolution(instanceName, messageKey, msgObj) {
  try {
    var resp = await axios.post(EVOLUTION_URL + '/chat/getBase64FromMediaMessage/' + instanceName, { message: { key: messageKey, message: msgObj } }, { headers: { apikey: EVOLUTION_APIKEY, 'Content-Type': 'application/json' }, timeout: 30000 });
    if (resp.data && resp.data.base64) return Buffer.from(resp.data.base64, 'base64');
  } catch (e) { console.error('getBase64 err: ' + (e.response ? e.response.status : e.message)); }
  return null;
}

function writeTempFile(buffer, ext) { var f = path.join(os.tmpdir(), 'cw-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext); fs.writeFileSync(f, buffer); return f; }
function removeFile(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {} }

function convertOggToMp3(inputPath) {
  return new Promise(function (resolve, reject) {
    if (!ffmpeg) return reject(new Error('ffmpeg not available'));
    var out = inputPath.replace(/\.[^.]+$/, '.mp3');
    ffmpeg(inputPath).audioCodec('libmp3lame').audioBitrate('64k').audioChannels(1).audioFrequency(22050).format('mp3').on('end', function () { resolve(out); }).on('error', function (err) { reject(err); }).save(out);
  });
}

async function prepareMediaBuffer(mediaType, mediaBuffer) {
  if (mediaType.type === 'audio' && ffmpeg) {
    var inp = null, outp = null;
    try { inp = writeTempFile(mediaBuffer, '.ogg'); outp = await convertOggToMp3(inp); var mp3 = fs.readFileSync(outp); return { buffer: mp3, filename: 'audio.mp3', mimetype: 'audio/mpeg' }; }
    catch (e) { console.log('ffmpeg fail, sending ogg: ' + e.message); }
    finally { removeFile(inp); removeFile(outp); }
  }
  return { buffer: mediaBuffer, filename: mediaType.type + Date.now() + mediaType.ext, mimetype: mediaType.mimetype };
}

async function sendToChatwoot(convId, content, messageType, mediaAttachment) {
  if (!mediaAttachment) { await cwApi.post('/conversations/' + convId + '/messages', { content: content || '[Msg]', message_type: messageType, private: false }); return; }
  var form = new FormData();
  form.append('content', content || '');
  form.append('message_type', messageType);
  form.append('private', 'false');
  form.append('attachments[]', mediaAttachment.buffer, { filename: mediaAttachment.filename, contentType: mediaAttachment.mimetype });
  await axios.post(CHATWOOT_URL + '/api/v1/accounts/' + ACCOUNT_ID + '/conversations/' + convId + '/messages', form, { headers: { ...form.getHeaders(), 'api_access_token': CHATWOOT_API_TOKEN }, timeout: 60000, maxContentLength: 50*1024*1024, maxBodyLength: 50*1024*1024 });
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
  var mediaType = getMediaType(msg);
  var mediaAttachment = null;
  if (mediaType) {
    try {
      var mediaBuffer = await downloadMediaFromEvolution(inst, key, msg);
      if (mediaBuffer) { mediaAttachment = await prepareMediaBuffer(mediaType, mediaBuffer); console.log('[' + ts + '] [' + cfg.label + '] media ' + mediaType.type + ' ' + mediaAttachment.buffer.length + 'b -> ' + mediaAttachment.filename); }
      else { console.log('[' + ts + '] [' + cfg.label + '] media download failed'); if (!content) content = '[' + mediaType.type.charAt(0).toUpperCase() + mediaType.type.slice(1) + ']'; }
    } catch (e) { console.error('[' + ts + '] [' + cfg.label + '] media err: ' + e.message); if (!content) content = '[' + mediaType.type.charAt(0).toUpperCase() + mediaType.type.slice(1) + ']'; }
  }
  if (!content && !mediaAttachment) content = '[Msg]';
  if (key.fromMe) {
    var ck = cfg.label + ':' + num + ':' + (content || '').substring(0, 50);
    if (sentFromChatwoot[ck]) { delete sentFromChatwoot[ck]; return res.status(200).json({ s: 'anti_loop' }); }
    console.log('[' + ts + '] [' + cfg.label + '] ZAPPED->CW (' + num + '): ' + (content || '[media]').substring(0, 80));
    try { var on = data.pushName || num; var oc = await getOrCreateContact(num, on, cfg.inbox_id); var ov = await getOrCreateConv(oc, cfg.inbox_id, num); await sendToChatwoot(ov, content, 'outgoing', mediaAttachment); console.log('[' + ts + '] [' + cfg.label + '] OUT conv=' + ov + (mediaAttachment ? ' +media' : '')); }
    catch (err) { console.error('[' + ts + '] [' + cfg.label + '] ERR out: ' + (err.response ? JSON.stringify(err.response.data).substring(0, 200) : err.message)); }
    return res.status(200).json({ s: 'ok' });
  }
  var name = data.pushName || num;
  console.log('[' + ts + '] [' + cfg.label + '] ' + name + ' (' + num + '): ' + (content || '[media]').substring(0, 80));
  try { var cid = await getOrCreateContact(num, name, cfg.inbox_id); var convId = await getOrCreateConv(cid, cfg.inbox_id, num); await sendToChatwoot(convId, content, 'incoming', mediaAttachment); console.log('[' + ts + '] [' + cfg.label + '] IN conv=' + convId + (mediaAttachment ? ' +media' : '')); }
  catch (err) { console.error('[' + ts + '] [' + cfg.label + '] ERR: ' + (err.response ? JSON.stringify(err.response.data).substring(0, 200) : err.message)); }
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
  var ck = eCfg.label + ':' + ph + ':' + m.content.substring(0, 50);
  sentFromChatwoot[ck] = true;
  setTimeout(function () { delete sentFromChatwoot[ck]; }, 60000);
  console.log('[' + ts + '] [' + eCfg.label + '] CW->WA: ' + ph);
  try { await axios.post(EVOLUTION_URL + '/message/sendText/' + eInst, { number: ph, text: m.content }, { headers: { apikey: EVOLUTION_APIKEY, 'Content-Type': 'application/json' }, timeout: 15000 }); console.log('[' + ts + '] Sent to WA ' + ph); }
  catch (err) { console.error('WA err: ' + (err.response ? JSON.stringify(err.response.data) : err.message)); }
  res.status(200).json({ s: 'ok' });
});

app.get('/health', (req, res) => { res.json({ status: 'running', v: 9, ffmpeg: !!ffmpeg, instances: Object.keys(INSTANCE_MAP) }); });

var PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log('Bridge v9 porta ' + PORT + ' | ffmpeg=' + !!ffmpeg);
  for (var n in INSTANCE_MAP) console.log('  ' + INSTANCE_MAP[n].label + ' -> inbox ' + INSTANCE_MAP[n].inbox_id);
});

