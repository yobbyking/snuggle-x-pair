const express = require('express');
const { useMultiFileAuthState, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
      if (stat.isDirectory()) {
        scan(fp, base + name + '/');
      } else {
        const buf = fs.readFileSync(fp);
        files[base + name] = buf.toString('base64');
      }
    }
  }
  scan(sessionFolder);
  return Buffer.from(JSON.stringify(files)).toString('base64');
}

// === Start pairing — phone number flow ===
app.post('/api/pair/start', async (req, res) => {
  const phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (phone.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

  const sessionId = 'snuggle-' + crypto.randomUUID().slice(0, 8);
  const sessionFolder = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(sessionFolder, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.appropriate('Chrome'),
      logger: require('pino')({ level: 'silent' }),
    });

    activePairs.set(sessionId, { sock, sessionFolder, saveCreds, phone });
    sock.ev.on('creds.update', saveCreds);

    let pairingCodeSent = false;
    sock.ev.on('connection.update', async (update) => {
      // When the socket opens its first WS connection, request the pairing code
      if (update.connection === 'connecting' && !pairingCodeSent) {
        try {
          // Give Baileys a moment to finish the noise handshake
          await new Promise(r => setTimeout(r, 1500));
          const pairingCode = await sock.requestPairingCode(phone);
          pairingCodeSent = true;
          if (activePairs.has(sessionId)) {
            activePairs.get(sessionId).pairingCode = pairingCode;
          }
          console.log(`[PAIR] ${phone}: code ${pairingCode} sent to WhatsApp servers`);
        } catch (e) {
          console.error('requestPairingCode failed:', e.message);
        }
      }

      if (update.connection === 'open') {
        const ownerJid = sock.user.id;
        const ownerNumber = ownerJid.split(':')[0].split('@')[0];

        const sessionB64 = encodeSession(sessionFolder);
        const shortSession = 'yobbyx:~' + sessionB64;
        await sock.sendMessage(ownerJid, {
          text: `*SNUGGLE X SESSION ID* 🔑\n\n${shortSession}\n\n_Copy this session ID and send it to the admin to deploy your bot on the Snuggle X platform._`,
        });

        await sock.sendMessage(ownerJid, {
          text: '*`SUCCESSFUL & VERIFIED ✅`*\n> snuggle x bot\n`contact developer for deploying`\n> 0795314221 or 0181163563',
        });

        const ownerFile = path.join(sessionFolder, 'owner.txt');
        fs.writeFileSync(ownerFile, ownerNumber);

        setTimeout(() => {
          try { sock.logout(); } catch (e) {}
          activePairs.delete(sessionId);
          console.log(`[PAIR] ${ownerNumber} linked, session saved, disconnected`);
        }, 3000);
      }
      if (update.connection === 'close') {
        activePairs.delete(sessionId);
      }
    });

    // Respond immediately with sessionId — the pairing code arrives async
    res.json({ sessionId, pairingCode: null, message: 'Pairing code is being requested, poll /api/pair/status/:sessionId' });
  } catch (e) {
    console.error('Pair start error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pair/status/:sessionId', (req, res) => {
  const data = activePairs.get(req.params.sessionId);
  if (!data) return res.json({ linked: true }); // session gone = either linked or expired
  res.json({
    linked: !!data.sock?.user?.id,
    pairingCode: data.pairingCode || null,
    owner: data.sock?.user?.id ? data.sock.user.id.split(':')[0] : null,
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'snuggle-x-pair' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`[Snuggle X Pair] running on port ${PORT}`));
