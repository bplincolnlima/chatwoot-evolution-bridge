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

// ROTA 1: Evolution -> Chatwoot
app.post('/webhook/:instance', async (req, res) => {
  const instance = req.params.instance;
  const config = INSTANCE_MAP[instance];
  const ts = new Date().toISOString();
  if (!config) return res.status(200).json({ status: 'unknown_instance' });
  const event = req.body.event;
  const data = req.body.data;
  if (event !== 'MESSAGES_UPSERT') return res.status(200).json({ status: 'ignored_event' });
  const key = data?.key;
  const msg = data?.message;
  if (key?.fromMe) return res.status(200).json({ status: 'ignored_own_message' });
  const remoteJid = key?.remoteJid || '';
  if (remoteJid.endsWith('@g.us')) return res.status(200).json({ status: 'ignored_group' });
  if (remoteJid === 'status@broadcast') return res.status(200).json({ status: 'ignored_broadcast' });
  const senderNumber = remoteJid.replace('@s.whatsapp.net', '');
  const senderName = data?.pushName || senderNumber;
  let content = '';
  if (msg?.conversation) content = msg.conversation;
  else if (msg?.extendedTextMessage?.text) content = msg.extendedTextMessage.text;
  else if (msg?.imageMessage) content = msg?.imageMessage?.caption ? '[Imagem] ' + msg.imageMessage.caption : '[Imagem]';
  else if (msg?.videoMessage) content = '[Video]';
  else if (msg?.audioMessage) content = msg?.audioMessage?.ptt ? '[Audio de voz]' : '[Audio]';
  else if (msg?.documentMessage) content = '[Documento] ' + (msg.documentMessage.fileName || 'arquivo');
  else if (msg?.stickerMessage) content = '[Sticker]';
  else if (msg?.contactMessage) content = '[Contato]';
  else if (msg?.locationMessage) content = '[Localizacao]';
  else if (msg?.reactionMessage) content = '[Reacao: ' + msg.reactionMessage.text + ']';
  else if (msg?.protocolMessage) return res.status(200).json({ status: 'ignored_protocol' });
  else content = '[Mensagem nao suportada]';
  const identifier = 'whatsapp:' + senderNumber;
  console.log('[' + ts + '] [' + config.label + '] ' + senderName + ' (' + senderNumber + '): ' + content.substring(0, 80));
  try {
    let sourceId = contactCache[identifier]?.source_id;
    if (!sourceId) {
      const contactResp = await axios.post(
        CHATWOOT_URL + '/public/api/v1/inboxes/' + config.inbox_identifier + '/contacts',
        { identifier: identifier, name: senderName, phone_number: '+' + senderNumber },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      sourceId = contactResp.data.source_id;
      contactCache[identifier] = { source_id: sourceId, contact_id: contactResp.data.id };
    }
    const convResp = await axios.post(
      CHATWOOT_URL + '/public/api/v1/inboxes/' + config.inbox_identifier + '/contacts/' + sourceId + '/conversations',
      { content: content },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log('[' + ts + '] [' + config.label + '] Msg enviada ao Chatwoot conv ' + convResp.data.id);
  } catch (err) {
    if (err.response?.status === 422) {
      try {
        const searchResp = await axios.get(
          CHATWOOT_URL + '/api/v1/accounts/' + ACCOUNT_ID + '/contacts/search?q=' + senderNumber,
          { headers: { 'api_access_token': CHATWOOT_API_TOKEN }, timeout: 10000 }
        );
        const contacts = searchResp.data?.payload || [];
        if (contacts.length > 0) {
          await axios.post(
            CHATWOOT_URL + '/api/v1/accounts/' + ACCOUNT_ID + '/conversations',
            { inbox_id: config.inbox_id, contact_id: contacts[0].id, message: { content: content } },
            { headers: { 'api_access_token': CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' }, timeout: 10000 }
          );
        }
      } catch (innerErr) { console.error('Fallback erro:', innerErr.message); }
    } else { console.error('Erro:', err.response?.data || err.message); }
  }
  res.status(200).json({ status: 'ok' });
});

// ROTA 2: Chatwoot -> Evolution (respostas dos agentes)
app.post('/chatwoot-webhook', async (req, res) => {
  const ts = new Date().toISOString();
  if (req.body.event !== 'message_created') return res.status(200).json({ status: 'ignored' });
  const message = req.body;
  if (message.message_type !== 'outgoing') return res.status(200).json({ status: 'not_outgoing' });
  if (!message.content || message.content_type === 'activity' || message.private) return res.status(200).json({ status: 'ignored_activity' });
  const inboxId = message.conversation?.inbox_id;
  let evolutionInstance = null;
  let instanceConfig = null;
  for (const [inst, cfg] of Object.entries(INSTANCE_MAP)) {
    if (cfg.inbox_id === inboxId) { evolutionInstance = inst; instanceConfig = cfg; break; }
  }
  if (!evolutionInstance) return res.status(200).json({ status: 'no_mapping' });
  const senderMeta = message.conversation?.meta?.sender || {};
  let phoneNumber = (senderMeta.phone_number || '').replace(/[^0-9]/g, '');
  if (!phoneNumber) phoneNumber = (senderMeta.identifier || '').replace('whatsapp:', '').replace(/[^0-9]/g, '');
  if (!phoneNumber && message.sender) phoneNumber = (message.sender.phone_number || '').replace(/[^0-9]/g, '');
  if (!phoneNumber) return res.status(200).json({ status: 'no_phone' });
  console.log('[' + ts + '] [' + instanceConfig.label + '] Chatwoot->WA: ' + phoneNumber);
  try {
    await axios.post(EVOLUTION_URL + '/message/sendText/' + evolutionInstance,
      { number: phoneNumber, text: message.content },
      { headers: { 'apikey': EVOLUTION_APIKEY, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    console.log('[' + ts + '] Enviado via WA para ' + phoneNumber);
  } catch (err) { console.error('Falha WA:', err.response?.data || err.message); }
  res.status(200).json({ status: 'ok' });
});

app.get('/health', (req, res) => {
  const instances = {};
  for (const [name, cfg] of Object.entries(INSTANCE_MAP)) instances[name] = { label: cfg.label, inbox_id: cfg.inbox_id, phone: cfg.phone };
  res.json({ status: 'running', timestamp: new Date().toISOString(), chatwoot: CHATWOOT_URL, evolution: EVOLUTION_URL, instances: instances });
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log('Bridge rodando na porta ' + PORT);
  for (const [name, cfg] of Object.entries(INSTANCE_MAP)) console.log('  ' + cfg.label + ' | ' + name + ' (' + cfg.phone + ') -> inbox ' + cfg.inbox_id);
});
