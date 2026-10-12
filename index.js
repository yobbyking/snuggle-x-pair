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

        // === Don't reconnect if we've already linked ===
        // We close the WS intentionally after sending the session ID — that's not a failure.
        if (opts.isLinked && opts.isLinked()) {
          console.log(`[PAIR ${sessionId.slice(0,12)}] closed after link — not reconnecting (session preserved for VPS)`);
          return;
        }

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
      // === isLinked — let the close handler know we've already linked (don't reconnect) ===
      isLinked: () => linkedResolved,
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

        // === DON'T logout — just close the WebSocket ===
        // logout() would invalidate the session on WhatsApp's side, making the session
        // ID we just sent unusable. We only need to close the WS connection so the
        // pairing portal doesn't keep holding the session.
        // The auth state files remain valid — the bot on the VPS will reconnect using them.
        setTimeout(() => {
          try {
            // ws.close() terminates the WebSocket without telling WhatsApp to log out
            if (s.ws && typeof s.ws.close === 'function') {
              s.ws.close();
            } else if (typeof s.end === 'function') {
              s.end();
            }
          } catch (e) { console.log('[PAIR] ws close error (ok):', e.message); }
          activePairs.delete(sessionId);
          console.log(`[PAIR] ${ownerNumber} session captured, WS closed (session still valid for VPS deploy)`);
        }, 5000);
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

// === /scan — QR scan alternative (placeholder page) ===
app.get('/scan', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SNUGGLE X · QR Scan</title><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Outfit', -apple-system, system-ui, sans-serif; background: #04040a; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; text-align: center; }
.card { background: linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)); border: 1px solid rgba(255,255,255,0.06); border-radius: 24px; padding: 40px 30px; max-width: 420px; backdrop-filter: blur(30px); }
.logo { font-size: 48px; margin-bottom: 16px; }
h1 { font-size: 22px; font-weight: 700; color: #00FFB3; margin-bottom: 8px; }
p { color: #C8C8E0; font-size: 14px; line-height: 1.6; margin-bottom: 20px; }
a { display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #00B380, #00FFB3); color: #04040a; text-decoration: none; border-radius: 12px; font-weight: 700; font-size: 13px; letter-spacing: 1px; text-transform: uppercase; }
a:hover { transform: translateY(-2px); }
.coming { color: #FFB800; font-size: 12px; margin-top: 20px; font-family: monospace; letter-spacing: 1px; }
</style></head><body><div class="card"><div class="logo">📷</div><h1>QR Scan Pairing</h1><p>QR code pairing is coming soon. For now, please use the phone number pairing method on the main portal.</p><a href="/">← Back to Pairing Portal</a><div class="coming">Coming Soon · Use Phone Number Method</div></div></body></html>`);
});

// === /download — download instructions / latest info ===
app.get('/download', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="snuggle-x-info.txt"');
  res.send(`SNUGGLE X — WhatsApp Bot Platform
================================

Created by: Yobby King
Instagram: @yobby_mking
Contact: 0795314221 / 0181163563

HOW TO DEPLOY YOUR BOT:
1. Visit the pairing portal
2. Enter your WhatsApp number (with country code)
3. Click "Generate Pair Code"
4. Open WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number
5. Enter the pairing code shown on the portal
6. You'll receive your Session ID in WhatsApp (3 messages)
7. Forward the Session ID to the admin to deploy your bot

SUPPORTED:
- Pairing via phone number
- Session ID-based bot deployment
- Multi-user (each user gets their own bot)
- Private mode (only owner can command)

BOT COMMANDS:
.menu — show the main menu
.all — show full command list
.alive — bot status
.owner — owner info
.ping — latency check
.sticker — image to sticker

Made with ❤️ by Yobby King
> Instagram @yobby_mking
> Contact dev: 0795314221 or 0181163563
`);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`[Snuggle X Pair] running on port ${PORT}`));
