const express = require('express');
const { useMultiFileAuthState, makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

const SESSIONS_DIR = '/tmp/snuggle-x-sessions';
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const activePairs = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function encodeSession(sessionFolder) {
  const files = {};
  function scan(dir, base = '') {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) scan(fp, base + name + '/');
      else {
        const buf = fs.readFileSync(fp);
        files[base + name] = buf.toString('base64');
      }
    }
  }
  scan(sessionFolder);
  return Buffer.from(JSON.stringify(files)).toString('base64');
}

// === Pairing flow (known-working config) ===
// Custom browser array avoids WhatsApp's bot detection on Browsers.windows()
// markOnlineOnConnect: true is REQUIRED for pairing to complete
app.post('/api/pair/start', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (phone.length < 11) {
    return res.status(400).json({ error: 'Include country code (e.g. 254712345678 for Kenya)' });
  }

  const sessionId = 'snuggle-' + crypto.randomUUID().slice(0, 8);
  const sessionFolder = path.join(SESSIONS_DIR, sessionId);
  fs.rmSync(sessionFolder, { recursive: true, force: true });
  fs.mkdirSync(sessionFolder, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[PAIR] Using WhatsApp protocol v${version.join('.')}`);

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      // Custom browser array — mimics real Chrome on Linux (not flagged by WhatsApp)
      browser: ['Chrome', 'Chrome', '120.0.6099.71'],
      logger: P({ level: 'warn' }),
      markOnlineOnConnect: true, // REQUIRED for pairing to complete
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      defaultQueryTimeoutMs: 120000,
      retryRequestDelayMs: 2500,
      emitOwnEvents: false,
    });

    const pairRecord = { sock, sessionFolder, phone, pairingCode: null, status: 'starting', error: null };
    activePairs.set(sessionId, pairRecord);

    sock.ev.on('creds.update', saveCreds);

    let codeRequested = false;
    sock.ev.on('connection.update', async (update) => {
      console.log(`[PAIR ${sessionId.slice(0,12)}]`, JSON.stringify({
        connection: update.connection,
        qr: !!update.qr,
        receivedHistory: update.receivedHistoryPlot,
        pairingCode: update.pairingCode,
      }));

      if (update.connection === 'connecting' && !codeRequested) {
        codeRequested = true;
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phone);
            pairRecord.pairingCode = code;
            pairRecord.status = 'code_sent';
            console.log(`[PAIR] ${phone}: code ${code}`);
          } catch (e) {
            console.error('[PAIR] requestPairingCode failed:', e.message);
            pairRecord.status = 'error';
            pairRecord.error = e.message;
          }
        }, 3000);
      }

      if (update.connection === 'open') {
        const ownerJid = sock.user.id;
        const ownerNumber = ownerJid.split(':')[0].split('@')[0];
        pairRecord.status = 'linked';
        console.log(`[PAIR] Linked as ${ownerJid}`);

        const sessionB64 = encodeSession(sessionFolder);
        const shortSession = 'yobbyx:~' + sessionB64;
        try {
          await sock.sendMessage(ownerJid, {
            text: `*SNUGGLE X SESSION ID* 🔑\n\n${shortSession}\n\n_Copy this session ID and send it to the admin to deploy your bot on the Snuggle X platform._`,
          });
          await sock.sendMessage(ownerJid, {
            text: '*`SUCCESSFUL & VERIFIED ✅`*\n> snuggle x bot\n`contact developer for deploying`\n> 0795314221 or 0181163563',
          });
        } catch (e) { console.error('[PAIR] sendMessage failed:', e.message); }

        setTimeout(() => {
          try { sock.logout(); } catch (e) {}
          activePairs.delete(sessionId);
          console.log(`[PAIR] ${ownerNumber} linked, session saved, disconnected`);
        }, 3000);
      }

      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        console.log(`[PAIR] closed, code=${code}, reason=${update.lastDisconnect?.error?.message}`);
        if (pairRecord.status !== 'linked') {
          pairRecord.status = 'failed';
          pairRecord.error = update.lastDisconnect?.error?.message || 'Connection closed before pairing could complete';
        }
        activePairs.delete(sessionId);
      }
    });

    res.json({ sessionId, pairingCode: null, message: 'Pairing code is being requested, poll /api/pair/status/:sessionId' });
  } catch (e) {
    console.error('Pair start error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pair/status/:sessionId', (req, res) => {
  const data = activePairs.get(req.params.sessionId);
  if (!data) return res.json({ linked: true });
  res.json({
    linked: !!data.sock?.user?.id,
    pairingCode: data.pairingCode || null,
    status: data.status,
    error: data.error || null,
    owner: data.sock?.user?.id ? data.sock.user.id.split(':')[0] : null,
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'snuggle-x-pair' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`[Snuggle X Pair] running on port ${PORT}`));
