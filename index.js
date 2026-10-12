const express = require('express');
const {
  useMultiFileAuthState,
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

const SESSIONS_DIR = '/tmp/snuggle-x-sessions';
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const activePairs = new Map();
const logger = P({ level: 'warn' }, P.destination({ sync: true }));

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

/**
 * Normalize a phone number to international format (digits only, no leading 0).
 */
function normalizePhone(input) {
  if (!input) return null;
  let p = String(input).replace(/[^\d]/g, '');
  if (!p) return null;
  if (p.length > 10 && p.startsWith('0')) p = p.slice(1);
  if (!/^\d{8,15}$/.test(p)) return null;
  return p;
}

/**
 * Format pairing code as "ABCD-EFGH".
 */
function formatPairCode(code) {
  if (!code) return code;
  const c = String(code).replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (c.length === 8) return c.slice(0, 4) + '-' + c.slice(4);
  return c;
}

// === Start pairing flow (same approach as YOBBY MD) ===
app.post('/api/pair/start', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Invalid phone number. Use country code (e.g. 254712345678). No +, no spaces, no leading 0.' });
  }

  const sessionId = 'snuggle-' + crypto.randomUUID().slice(0, 8);
  const sessionFolder = path.join(SESSIONS_DIR, sessionId);
  fs.rmSync(sessionFolder, { recursive: true, force: true });
  fs.mkdirSync(sessionFolder, { recursive: true });

  const pairRecord = { sock: null, sessionFolder, phone, pairingCode: null, status: 'starting', error: null };
  activePairs.set(sessionId, pairRecord);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[PAIR] Baileys v${version.join('.')} (latest=${isLatest}) for ${phone}`);

    // === Create socket — exact same config as YOBBY MD (known working) ===
    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.appropriate('Chrome'), // critical — don't change
      defaultQueryTimeoutMs: 120000,
      connectTimeoutMs: 120000,
      qrTimeout: 120000,
      keepAliveIntervalMs: 30000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      retryRequestDelayMs: 2000,
      linkPreview: false,
    });

    pairRecord.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    // === Wait for QR event (means socket is fully ready for pairing) ===
    let connectionResolved = false;
    const connectionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!connectionResolved) {
          connectionResolved = true;
          reject(new Error('Connection timeout after 45s. WhatsApp may be blocking the connection.'));
        }
      }, 45000);

      const handler = async (update) => {
        const { connection, lastDisconnect, qr } = update;
        console.log(`[PAIR ${sessionId.slice(0,12)}] wait:`, JSON.stringify({ connection, hasQr: !!qr, statusCode: lastDisconnect?.error?.output?.statusCode }));

        if (qr && !connectionResolved) {
          connectionResolved = true;
          clearTimeout(timeout);
          sock.ev.off('connection.update', handler);
          console.log(`[PAIR ${sessionId.slice(0,12)}] QR received — socket ready for pairing code`);
          resolve();
        } else if (connection === 'open' && !connectionResolved) {
          connectionResolved = true;
          clearTimeout(timeout);
          sock.ev.off('connection.update', handler);
          resolve();
        } else if (connection === 'close' && !connectionResolved) {
          connectionResolved = true;
          clearTimeout(timeout);
          sock.ev.off('connection.update', handler);
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          reject(new Error(`Connection closed (status ${statusCode}). WhatsApp rejected the connection.`));
        }
      };
      sock.ev.on('connection.update', handler);
    });

    try {
      await connectionPromise;
    } catch (e) {
      try { await sock.logout(); } catch {}
      activePairs.delete(sessionId);
      return res.status(500).json({ error: e.message });
    }

    // Wait for sock.wsReady to become true (extra safety)
    let waited = 0;
    while (!sock.wsReady && waited < 20) {
      await new Promise(r => setTimeout(r, 500));
      waited++;
    }
    console.log(`[PAIR ${sessionId.slice(0,12)}] wsReady=${sock.wsReady} after ${waited * 500}ms`);

    // === Request the pairing code ===
    let code;
    try {
      code = await sock.requestPairingCode(phone);
      console.log(`[PAIR] ${phone}: code ${code}`);
    } catch (e) {
      try { await sock.logout(); } catch {}
      activePairs.delete(sessionId);
      return res.status(500).json({ error: `Failed to get pairing code: ${e.message}` });
    }

    if (!code || code.length < 4) {
      try { await sock.logout(); } catch {}
      activePairs.delete(sessionId);
      return res.status(500).json({ error: 'WhatsApp returned invalid pairing code. Try again.' });
    }

    pairRecord.pairingCode = formatPairCode(code);
    pairRecord.status = 'code_sent';

    // === Now wait for the user to actually enter the code on their phone ===
    let linkedResolved = false;
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      console.log(`[PAIR ${sessionId.slice(0,12)}] live:`, JSON.stringify({ connection, statusCode: lastDisconnect?.error?.output?.statusCode }));

      if (connection === 'open' && !linkedResolved) {
        linkedResolved = true;
        const ownerJid = sock.user.id;
        const ownerNumber = ownerJid.split(':')[0].split('@')[0];
        pairRecord.status = 'linked';
        console.log(`[PAIR] ✅ Linked as ${ownerJid}`);

        try {
          const sessionB64 = encodeSession(sessionFolder);
          const shortSession = 'yobbyx:~' + sessionB64;
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
        }, 3000);
      }

      if (connection === 'close' && !linkedResolved) {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[PAIR] closed, code=${statusCode}, reason=${lastDisconnect?.error?.message}`);
        if (statusCode === DisconnectReason.loggedOut) {
          pairRecord.status = 'failed';
          pairRecord.error = 'Pairing failed — code expired or rejected. Try again.';
          activePairs.delete(sessionId);
        }
        // Otherwise: transient, Baileys will auto-reconnect
      }
    });

    res.json({ sessionId, pairingCode: pairRecord.pairingCode, message: 'Pairing code sent' });
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
