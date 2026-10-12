const express = require('express');
const {
  useMultiFileAuthState,
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DEFAULT_CONNECTION_CONFIG,
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const P = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

const SESSIONS_DIR = '/tmp/snuggle-x-sessions';
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const activePairs = new Map();

// Logger — match official example (trace level for debugging)
const logger = P({ level: 'warn' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function encodeSession(sessionFolder) {
  // Read all auth files as a flat map (name → base64 content)
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

  // Compact JSON, gzip, then base64 — much smaller than raw base64 of JSON
  const json = JSON.stringify(files);
  const gzipped = zlib.gzipSync(Buffer.from(json, 'utf-8'), { level: 9 });
  return gzipped.toString('base64');
}

function decodeSession(b64) {
  // Reverse: base64 → gunzip → JSON → files map
  const gzipped = Buffer.from(b64, 'base64');
  const json = zlib.gunzipSync(gzipped).toString('utf-8');
  return JSON.parse(json);
}

function normalizePhone(input) {
  if (!input) return null;
  let p = String(input).replace(/[^\d]/g, '');
  if (!p) return null;
  if (p.length > 10 && p.startsWith('0')) p = p.slice(1);
  if (!/^\d{8,15}$/.test(p)) return null;
  return p;
}

function formatPairCode(code) {
  if (!code) return code;
  const c = String(code).replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (c.length === 8) return c.slice(0, 4) + '-' + c.slice(4);
  return c;
}

// Simple in-memory message cache for retries (per official example)
const msgRetryCounterCache = new Map();

// === Start socket — official Baileys pattern ===
async function startSock(opts) {
  const { sessionId, phone, sessionFolder, onPairingCode, onLinked, onError } = opts;

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[PAIR ${sessionId.slice(0,12)}] Baileys v${version.join('.')} (latest=${isLatest})`);

  const sock = makeWASocket({
    version,
    logger,
    waWebSocketUrl: DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    // Use Chrome on Ubuntu (realistic device fingerprint)
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.process(async (events) => {
    if (events['connection.update']) {
      const update = events['connection.update'];
      const { connection, lastDisconnect, qr } = update;
      console.log(`[PAIR ${sessionId.slice(0,12)}] update:`, JSON.stringify({
        connection,
        statusCode: lastDisconnect?.error?.output?.statusCode,
        hasQr: !!qr,
      }));

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || 'unknown';
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(`[PAIR ${sessionId.slice(0,12)}] closed code=${statusCode} (${errorMsg}) loggedOut=${isLoggedOut}`);
        // Clean up
        try {
          sock.ev.removeAllListeners();
        } catch {}

        if (isLoggedOut) {
          // Can't reconnect — user rejected or code expired
          onError('Connection closed. You are logged out. Try again with a fresh code.');
        } else {
          // Reconnect (official Baileys pattern — just restart the socket)
          console.log(`[PAIR ${sessionId.slice(0,12)}] Reconnecting in 2s...`);
          setTimeout(async () => {
            try {
              await startSock(opts);
            } catch (e) {
              console.error(`[PAIR ${sessionId.slice(0,12)}] Reconnect failed:`, e.message);
              onError(e.message);
            }
          }, 2000);
        }
      }

      if (qr) {
        // === OFFICIAL PATTERN: request pairing code immediately on QR (no setTimeout, no wsReady wait) ===
        if (!sock.authState.creds.registered && phone) {
          try {
            const code = await sock.requestPairingCode(phone);
            console.log(`[PAIR] ${phone}: code ${code}`);
            onPairingCode(formatPairCode(code));
          } catch (e) {
            console.error(`[PAIR ${sessionId.slice(0,12)}] requestPairingCode failed:`, e.message);
            onError(`Failed to get pairing code: ${e.message}`);
          }
        }
      }

      if (connection === 'open') {
        const ownerJid = sock.user.id;
        const ownerNumber = ownerJid.split(':')[0].split('@')[0];
        console.log(`[PAIR] ✅ Linked as ${ownerJid}`);
        onLinked(sock, ownerJid, ownerNumber);
      }
    }

    if (events['creds.update']) {
      await saveCreds();
    }
  });

  return sock;
}

// === Pairing flow — official Baileys pattern ===
app.post('/api/pair/start', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Invalid phone number. Use country code (e.g. 254712345678). No +, no spaces, no leading 0.' });
  }

  const sessionId = 'snuggle-' + crypto.randomUUID().slice(0, 8);
  const sessionFolder = path.join(SESSIONS_DIR, sessionId);
  fs.rmSync(sessionFolder, { recursive: true, force: true });
  fs.mkdirSync(sessionFolder, { recursive: true });

  const pairRecord = {
    sock: null,
    sessionFolder,
    phone,
    pairingCode: null,
    status: 'starting',
    error: null,
  };
  activePairs.set(sessionId, pairRecord);

  let linkedResolved = false;

  try {
    const sock = await startSock({
      sessionId,
      phone,
      sessionFolder,
      // === onPairingCode — code returned, tell the frontend ===
      onPairingCode: (code) => {
        pairRecord.pairingCode = code;
        pairRecord.status = 'code_sent';
      },
      // === onLinked — user paired on their phone ===
      onLinked: async (s, ownerJid, ownerNumber) => {
        if (linkedResolved) return;
        linkedResolved = true;
        pairRecord.status = 'linked';
        pairRecord.sock = s;
        console.log(`[PAIR] ✅ Linked as ${ownerJid}`);

        try {
          const sessionB64 = encodeSession(sessionFolder);
          const shortSession = 'yobbyx:~' + sessionB64;

          // === Message 1: Header ===
          await s.sendMessage(ownerJid, {
            text: '*SNUGGLE X SESSION ID* 🔑',
          });

          // === Message 2: Just the session ID (for easy copying) ===
          const sentMsg = await s.sendMessage(ownerJid, {
            text: shortSession,
          });

          // === Message 3: Reply to message 2 with success ===
          await s.sendMessage(ownerJid, {
            text: '*`SUCCESSFUL & VERIFIED ✅`*\n> snuggle x bot\n`contact developer for deploying`\n> 0795314221 or 0181163563',
          }, {
            quoted: sentMsg,
          });
        } catch (e) { console.error('[PAIR] sendMessage failed:', e.message); }

        setTimeout(() => {
          try { s.logout(); } catch (e) {}
          activePairs.delete(sessionId);
        }, 3000);
      },
      // === onError — pairing failed ===
      onError: (msg) => {
        if (linkedResolved) return;
        pairRecord.status = 'failed';
        pairRecord.error = msg;
        activePairs.delete(sessionId);
      },
    });
    pairRecord.sock = sock;

    // Wait briefly for the QR event (so we can return the code in the response if it arrives fast)
    // The frontend will poll /api/pair/status/:sessionId for the code if it doesn't arrive in this window
    await new Promise(r => setTimeout(r, 6000));

    res.json({
      sessionId,
      pairingCode: pairRecord.pairingCode || null,
      message: pairRecord.pairingCode ? 'Code sent' : 'Pairing in progress, poll for code',
    });
  } catch (e) {
    console.error('Pair start error:', e);
    activePairs.delete(sessionId);
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
