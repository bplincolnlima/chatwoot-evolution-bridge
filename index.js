const express = require('express');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

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

var cwApi = axios.create({
  baseURL: CHATWOOT_URL + '/api/v1/accounts/' + ACCOUNT_ID,
  headers: {
    'api_access_token': CHATWOOT_API_TOKEN,
    'Content-Type': 'application/json'
  },
  timeout: 20000
});

async function getOrCreateContact(num, name, inboxId) {
  var k = inboxId + ':' + num;
  if (cache[k] && cache[k].contact_id) return cache[k].contact_id;

  try {
    var s = await cwApi.get('/contacts/search?q=' + encodeURIComponent(num));
    var c = s.data.payload || [];
    if (c.length > 0) {
      cache[k] = cache[k] || {};
      cache[k].contact_id = c[0].id;
      return c[0].id;
    }
  } catch (e) {}

  var r = await cwApi.post('/contacts', {
    name: name,
    phone_number: '+' + num,
    identifier: 'whatsapp:' + num
  });

  var id = r.data.payload.contact.id;
  cache[k] = cache[k] || {};
  cache[k].contact_id = id;
  return id;
}

async function getOrCreateConv(contactId, inboxId, num) {
  var k = inboxId + ':' + num;

  if (cache[k] && cache[k].conv_id) {
    try {
      var cv = await cwApi.get('/conversations/' + cache[k].conv_id);
      if (cv.data.status === 'open' || cv.data.status === 'pending') return cache[k].conv_id;
    } catch (e) {}
  }

  try {
    var cs = await cwApi.get('/contacts/' + contactId + '/conversations');
    var convs = cs.data.payload || [];
    for (var i = 0; i < convs.length; i++) {
      if (convs[i].inbox_id === inboxId && (convs[i].status === 'open' || convs[i].status === 'pending')) {
        cache[k] = cache[k] || {};
        cache[k].conv_id = convs[i].id;
        return convs[i].id;
      }
    }
  } catch (e) {}

  var r = await cwApi.post('/conversations', {
    contact_id: contactId,
    inbox_id: inboxId,
    status: 'open'
  });

  cache[k] = cache[k] || {};
  cache[k].conv_id = r.data.id;
  return r.data.id;
}

function extractContent(msg) {
  if (!msg) return '[Msg]';
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage && msg.extendedTextMessage.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage) return msg.imageMessage.caption ? '[Imagem] ' + msg.imageMessage.caption : '[Imagem]';
  if (msg.videoMessage) return msg.videoMessage.caption ? '[Video] ' + msg.videoMessage.caption : '[Video]';
  if (msg.audioMessage) return '[Audio]';
  if (msg.documentMessage) return msg.documentMessage.fileName ? '[Doc] ' + msg.documentMessage.fileName : '[Doc]';
  if (msg.stickerMessage) return '[Sticker]';
  if (msg.protocolMessage) return null;
  return '[Msg]';
}

function getMediaInfo(msg) {
  if (!msg) return null;

  if (msg.audioMessage) {
    return {
      url: msg.audioMessage.url,
      mimetype: msg.audioMessage.mimetype || 'audio/ogg',
      filename: 'audio.ogg',
      type: 'audio',
      convertToMp3: true
    };
  }

  if (msg.imageMessage) {
    return {
      url: msg.imageMessage.url,
      mimetype: msg.imageMessage.mimetype || 'image/jpeg',
      filename: 'imagem.jpg',
      type: 'image',
      convertToMp3: false
    };
  }

  if (msg.videoMessage) {
    return {
      url: msg.videoMessage.url,
      mimetype: msg.videoMessage.mimetype || 'video/mp4',
      filename: 'video.mp4',
      type: 'video',
      convertToMp3: false
    };
  }

  if (msg.documentMessage) {
    return {
      url: msg.documentMessage.url,
      mimetype: msg.documentMessage.mimetype || 'application/octet-stream',
      filename: msg.documentMessage.fileName || 'documento',
      type: 'document',
      convertToMp3: false
    };
  }

  return null;
}

async function downloadMediaBuffer(url) {
  var r = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { apikey: EVOLUTION_APIKEY },
    timeout: 30000
  });
  return Buffer.from(r.data);
}

function writeTempFile(buffer, ext) {
  var filePath = path.join(
    os.tmpdir(),
    'cw-bridge-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext
  );
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function removeFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

function convertOggToMp3(inputPath) {
  return new Promise(function(resolve, reject) {
    var outputPath = inputPath.replace(/\.ogg$/i, '.mp3');

    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .format('mp3')
      .on('end', function() {
        resolve(outputPath);
      })
      .on('error', function(err) {
        reject(err);
      })
      .save(outputPath);
  });
}

async function prepareAttachment(mediaInfo) {
  var originalBuffer = await downloadMediaBuffer(mediaInfo.url);

  if (mediaInfo.type === 'audio' && mediaInfo.convertToMp3) {
    var inputPath = null;
    var outputPath = null;

    try {
      inputPath = writeTempFile(originalBuffer, '.ogg');
      outputPath = await convertOggToMp3(inputPath);
      var mp3Buffer = fs.readFileSync(outputPath);

      return {
        buffer: mp3Buffer,
        filename: 'audio.mp3',
        mimetype: 'audio/mpeg'
      };
    } finally {
      removeFileSafe(inputPath);
      removeFileSafe(outputPath);
    }
  }

  return {
    buffer: originalBuffer,
    filename: mediaInfo.filename,
    mimetype: mediaInfo.mimetype
  };
}

async function sendMessageToChatwoot(convId, content, messageType, mediaInfo) {
  if (!mediaInfo || !mediaInfo.url) {
    await cwApi.post('/conversations/' + convId + '/messages', {
      content: content,
      message_type: messageType,
      private: false
    });
    return;
  }

  var attachment = await prepareAttachment(mediaInfo);

  var form = new FormData();
  form.append('content', content || '');
  form.append('message_type', messageType);
  form.append('private', 'false');
  form.append(
    'attachments[]',
    new Blob([attachment.buffer], { type: attachment.mimetype }),
    attachment.filename
  );

  var resp = await fetch(
    CHATWOOT_URL + '/api/v1/accounts/' + ACCOUNT_ID + '/conversations/' + convId + '/messages',
    {
      method: 'POST',
      headers: {
        api_access_token: CHATWOOT_API_TOKEN
      },
      body: form
    }
  );

  if (!resp.ok) {
    var txt = await resp.text();
    throw new Error('Chatwoot attachment upload failed: ' + txt);
  }
}

app.post('/webhook/:instance', async (req, res) => {
  var inst = req.params.instance;
  var cfg = INSTANCE_MAP[inst];
  var ts = new Date().toISOString();

  if (!cfg) return res.status(200).json({ s: 'unknown' });

  var body = req.body;
  var ev = body.event;
  if (!ev || (ev !== 'messages.upsert' && ev !== 'MESSAGES_UPSERT')) {
    return res.status(200).json({ s: 'skip' });
  }

  var data = body.data || body;
  var key = data.key;
  var msg = data.message;

  if (!key) return res.status(200).json({ s: 'skip' });

  var jid = key.remoteJid || '';
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') {
    return res.status(200).json({ s: 'skip' });
  }

  var num = jid.replace('@s.whatsapp.net', '');
  var content = extractContent(msg);
  var mediaInfo = getMediaInfo(msg);

  if (content === null) return res.status(200).json({ s: 'protocol' });

  if (key.fromMe) {
    var cacheKey = cfg.label + ':' + num + ':' + content.substring(0, 50);
    if (sentFromChatwoot[cacheKey]) {
      console.log('[' + ts + '] [' + cfg.label + '] Anti-loop: msg do Chatwoot, ignorando');
      delete sentFromChatwoot[cacheKey];
      return res.status(200).json({ s: 'anti_loop' });
    }

    console.log('[' + ts + '] [' + cfg.label + '] ZAPPED->CW (' + num + '): ' + content.substring(0, 80));
    try {
      var outName = data.pushName || num;
      var outCid = await getOrCreateContact(num, outName, cfg.inbox_id);
      var outConvId = await getOrCreateConv(outCid, cfg.inbox_id, num);
      await sendMessageToChatwoot(outConvId, content, 'outgoing', mediaInfo);
      console.log('[' + ts + '] [' + cfg.label + '] OUTGOING registrada conv=' + outConvId + (mediaInfo ? ' media=' + mediaInfo.type : ''));
    } catch (err) {
      console.error('[' + ts + '] [' + cfg.label + '] ERR outgoing: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
    }

    return res.status(200).json({ s: 'outgoing_registered' });
  }

  var name = data.pushName || num;
  console.log('[' + ts + '] [' + cfg.label + '] ' + name + ' (' + num + '): ' + content);

  try {
    var cid = await getOrCreateContact(num, name, cfg.inbox_id);
    var convId = await getOrCreateConv(cid, cfg.inbox_id, num);
    await sendMessageToChatwoot(convId, content, 'incoming', mediaInfo);
    console.log('[' + ts + '] [' + cfg.label + '] INCOMING conv=' + convId + (mediaInfo ? ' media=' + mediaInfo.type : ''));
  } catch (err) {
    console.error('[' + ts + '] [' + cfg.label + '] ERR: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
  }

  res.status(200).json({ s: 'ok' });
});

app.post('/chatwoot-webhook', async (req, res) => {
  var ts = new Date().toISOString();

  if (req.body.event !== 'message_created') return res.status(200).json({ s: 'skip' });

  var m = req.body;
  if (m.message_type !== 'outgoing' || !m.content || m.content_type === 'activity' || m.private) {
    return res.status(200).json({ s: 'skip' });
  }

  var iid = m.conversation && m.conversation.inbox_id;
  var eInst = null;
  var eCfg = null;

  for (var i in INSTANCE_MAP) {
    if (INSTANCE_MAP[i].inbox_id === iid) {
      eInst = i;
      eCfg = INSTANCE_MAP[i];
      break;
    }
  }

  if (!eInst) return res.status(200).json({ s: 'no_map' });

  var meta = (m.conversation && m.conversation.meta && m.conversation.meta.sender) || {};
  var ph = (meta.phone_number || '').replace(/[^0-9]/g, '');
  if (!ph) ph = (meta.identifier || '').replace('whatsapp:', '').replace(/[^0-9]/g, '');
  if (!ph && m.sender) ph = (m.sender.phone_number || '').replace(/[^0-9]/g, '');
  if (!ph) return res.status(200).json({ s: 'no_ph' });

  var cacheKey = eCfg.label + ':' + ph + ':' + m.content.substring(0, 50);
  sentFromChatwoot[cacheKey] = true;
  setTimeout(function() { delete sentFromChatwoot[cacheKey]; }, 60000);

  console.log('[' + ts + '] [' + eCfg.label + '] CW->WA: ' + ph);

  try {
    await axios.post(
      EVOLUTION_URL + '/message/sendText/' + eInst,
      { number: ph, text: m.content },
      {
        headers: {
          apikey: EVOLUTION_APIKEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    console.log('[' + ts + '] Sent to WA ' + ph);
  } catch (err) {
    console.error('WA err: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
  }

  res.status(200).json({ s: 'ok' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'running', v: 7, instances: Object.keys(INSTANCE_MAP) });
});

var PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log('Bridge v7 porta ' + PORT);
  for (var n in INSTANCE_MAP) {
    console.log('  ' + INSTANCE_MAP[n].label + ' -> inbox ' + INSTANCE_MAP[n].inbox_id);
  }
});
