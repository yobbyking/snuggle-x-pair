const express = require('express');
const { useMultiFileAuthState, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
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

// Use a stable Chrome on Windows browser identity — most reliable for pairing
function getBrowserConfig() {
  return Browsers.ubuntu('Chrome');
  // returns ['Ubuntu', 'Chrome', '22.04.4']
}

// === Start pairing — phone number flow ===
app.post('/api/pair/start', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (phone.length < 10) return res.status(400).json({ error: 'Invalid phone number' });
  // Remove leading zeros (common when user types 0712345678 instead of 254712345678)
  phone = phone.replace(/^0+/, '');

  const sessionId = 'snuggle-' + crypto.randomUUID().slice(0, 8);
  const sessionFolder = path.join(SESSIONS_DIR, sessionId);
  // Always start fresh — never reuse a folder
  fs.rmSync(sessionFolder, { recursive: true, force: true });
  fs.mkdirSync(sessionFolder, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[PAIR] Using Baileys v${version.join('.')} (latest=${isLatest})`);

    const logger = P({ level: 'warn' }); // we want to see warnings

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: getBrowserConfig(),
      logger,
      markOnlineOnConnect: false,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: 60000,
    });

    const pairRecord = { sock, sessionFolder, saveCreds, phone, pairingCode: null, status: 'starting' };
    activePairs.set(sessionId, pairRecord);

    sock.ev.on('creds.update', saveCreds);

    let codeRequested = false;
    sock.ev.on('connection.update', async (update) => {
      console.log(`[PAIR ${sessionId.slice(0,12)}] conn update:`, update.connection, update.receivedHistoryPlot || '', update.lastDisconnect?.error?.message || '');

      if (update.connection === 'connecting' && !codeRequested) {
        codeRequested = true;
        // Wait for the noise handshake to settle
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
        }, 2500);
      }

      if (update.connection === 'open') {
        const ownerJid = sock.user.id;
        const ownerNumber = ownerJid.split(':')[0].split('@')[0];
        pairRecord.status = 'linked';

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
        console.log(`[PAIR] closed, code=${code}`);
        if (code !== DisconnectReason.loggedOut && pairRecord.status !== 'linked') {
          // If we haven't linked yet, try reconnecting ONCE
          if (codeRequested && !pairRecord.pairingCode && pairRecord.status !== 'error') {
            // Already attempted, don't loop forever
            pairRecord.status = 'failed';
          }
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
  if (!data) return res.json({ linked: true }); // session gone = linked or expired
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
