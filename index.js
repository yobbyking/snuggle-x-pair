const express = require('express');
const { useMultiFileAuthState, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// === Session storage ===
// Each pairing session gets its own folder under /tmp/snuggle-x-sessions
const SESSIONS_DIR = '/tmp/snuggle-x-sessions';
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Active pairing sockets keyed by sessionId
const activePairs = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === Helper: base64 encode a folder's auth state ===
function encodeSession(sessionFolder) {
  // We only need creds.json and app-state-sync-key-*.json files
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

// === Pairing route: starts a Baileys socket, returns QR code ===
app.post('/api/pair/start', async (req, res) => {
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

    activePairs.set(sessionId, { sock, sessionFolder, saveCreds });

    sock.ev.on('creds.update', saveCreds);

    // When connection opens (user scanned QR or entered pairing code)
    sock.ev.on('connection.update', async (update) => {
      if (update.qr) {
        // Generate QR PNG and broadcast to SSE listeners
        const qrDataUrl = await QRCode.toDataURL(update.qr, { width: 320, margin: 2 });
        if (activePairs.has(sessionId)) {
          activePairs.get(sessionId).qrDataUrl = qrDataUrl;
          activePairs.get(sessionId).pairingCode = update.pairingCode;
        }
      }
      if (update.connection === 'open') {
        // === User linked! Generate session ID + send messages ===
        const ownerJid = sock.user.id;
        const ownerNumber = ownerJid.split(':')[0].split('@')[0];

        // Send the session ID to the user's own WhatsApp
        const sessionB64 = encodeSession(sessionFolder);
        const shortSession = 'yobbyx:~' + sessionB64;
        await sock.sendMessage(ownerJid, {
          text: `*SNUGGLE X SESSION ID* 🔑\n\n${shortSession}\n\n_Copy this session ID and send it to the admin to deploy your bot on the Snuggle X platform._`,
        });

        // Send the success message
        await sock.sendMessage(ownerJid, {
          text: '*`SUCCESSFUL & VERIFIED ✅`*\n> snuggle x bot\n`contact developer for deploying`\n> 0795314221 or 0181163563',
        });

        // Save owner number with the session for the VPS to know who is the owner
        const ownerFile = path.join(sessionFolder, 'owner.txt');
        fs.writeFileSync(ownerFile, ownerNumber);

        // Disconnect — bot will go live when deployed on VPS
        setTimeout(() => {
          try { sock.logout(); } catch (e) {}
          activePairs.delete(sessionId);
          console.log(`[PAIR] ${ownerNumber} linked, session saved, disconnected`);
        }, 3000);
      }
      if (update.connection === 'close') {
        if (update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
          // Could reconnect, but we explicitly logged out
        }
        activePairs.delete(sessionId);
      }
    });

    // Wait a bit, then return sessionId + first QR (if available)
    setTimeout(async () => {
      const data = activePairs.get(sessionId);
      if (data && data.qrDataUrl) {
        res.json({ sessionId, qr: data.qrDataUrl });
      } else {
        res.json({ sessionId, qr: null, message: 'QR not ready yet, poll /api/pair/qr/:sessionId' });
      }
    }, 2000);
  } catch (e) {
    console.error('Pair start error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Poll for latest QR
app.get('/api/pair/qr/:sessionId', (req, res) => {
  const data = activePairs.get(req.params.sessionId);
  if (!data) return res.status(404).json({ error: 'session not found' });
  res.json({
    qr: data.qrDataUrl || null,
    pairingCode: data.pairingCode || null,
    linked: !data.qrDataUrl && data.sock?.user?.id ? true : false,
    owner: data.sock?.user?.id ? data.sock.user.id.split(':')[0] : null,
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'snuggle-x-pair' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`[Snuggle X Pair] running on port ${PORT}`));
