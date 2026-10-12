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

// === Start socket (YOBBY MD's exact approach) ===
async function startSocket(sessionId, phone, sessionFolder, onOpen, onClose) {
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[PAIR ${sessionId.slice(0,12)}] Baileys v${version.join('.')} (latest=${isLatest})`);
  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.appropriate('Chrome'),
    defaultQueryTimeoutMs: 120000,
    connectTimeoutMs: 120000,
    qrTimeout: 120000,
    keepAliveIntervalMs: 30000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    retryRequestDelayMs: 2000,
    linkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(`[PAIR ${sessionId.slice(0,12)}] update:`, JSON.stringify({
      connection,
      statusCode: lastDisconnect?.error?.output?.statusCode,
      hasQr: !!qr,
    }));

    if (connection === 'open') {
      onOpen(sock);
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || 'unknown';
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[PAIR ${sessionId.slice(0,12)}] closed code=${statusCode} (${errorMsg}) loggedOut=${isLoggedOut}`);
      onClose(sock, statusCode, isLoggedOut, errorMsg);
    }
  });

  return sock;
}

// === Pairing flow ===
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
  let socketReady = false;
  let connectionFailed = false;

  // === Start the socket — first time ===
  let sock;
  try {
    sock = await startSocket(
      sessionId,
      phone,
      sessionFolder,
      // onOpen — user has linked their phone
      async (s) => {
        if (linkedResolved) return;
        linkedResolved = true;
        const ownerJid = s.user.id;
        const ownerNumber = ownerJid.split(':')[0].split('@')[0];
        pairRecord.status = 'linked';
        console.log(`[PAIR] ✅ Linked as ${ownerJid}`);

        try {
          const sessionB64 = encodeSession(sessionFolder);
          const shortSession = 'yobbyx:~' + sessionB64;
          await s.sendMessage(ownerJid, {
            text: `*SNUGGLE X SESSION ID* 🔑\n\n${shortSession}\n\n_Copy this session ID and send it to the admin to deploy your bot on the Snuggle X platform._`,
          });
          await s.sendMessage(ownerJid, {
            text: '*`SUCCESSFUL & VERIFIED ✅`*\n> snuggle x bot\n`contact developer for deploying`\n> 0795314221 or 0181163563',
          });
        } catch (e) { console.error('[PAIR] sendMessage failed:', e.message); }

        setTimeout(() => {
          try { s.logout(); } catch (e) {}
          activePairs.delete(sessionId);
        }, 3000);
      },
      // onClose — handle close (recreate socket on transient, fail on loggedOut)
      async (closedSock, statusCode, isLoggedOut, errorMsg) => {
        // Clean up old listeners to prevent duplicates on reconnect
        try {
          closedSock.ev.removeAllListeners('messages.upsert');
          closedSock.ev.removeAllListeners('connection.update');
          closedSock.ev.removeAllListeners('creds.update');
        } catch {}

        if (linkedResolved) return; // already linked, ignore

        if (isLoggedOut) {
          // 401 — pairing code expired/rejected, or user explicitly logged out
          if (!socketReady) {
            // Failed before we even got the pairing code out
            connectionFailed = true;
            pairRecord.status = 'failed';
            pairRecord.error = 'Pairing failed. Code expired or rejected. Please try again with a fresh code.';
            activePairs.delete(sessionId);
          }
          // If we already sent the code and user is still entering it, this is bad — they rejected
          pairRecord.status = 'failed';
          pairRecord.error = 'WhatsApp rejected the pairing. Try again.';
          activePairs.delete(sessionId);
          return;
        }

        // Other close reasons (network blip, restart) — try to recreate the socket
        if (!socketReady) {
          // Still trying to get a QR — retry
          console.log(`[PAIR ${sessionId.slice(0,12)}] Reconnecting in 3s...`);
          setTimeout(async () => {
            try {
              const newSock = await startSocket(sessionId, phone, sessionFolder,
                async (s) => {
                  if (linkedResolved) return;
                  linkedResolved = true;
                  const ownerJid = s.user.id;
                  const ownerNumber = ownerJid.split(':')[0].split('@')[0];
                  pairRecord.status = 'linked';
                  console.log(`[PAIR] ✅ Linked as ${ownerJid} (reconnect)`);
                  try {
                    const sessionB64 = encodeSession(sessionFolder);
                    const shortSession = 'yobbyx:~' + sessionB64;
                    await s.sendMessage(ownerJid, {
                      text: `*SNUGGLE X SESSION ID* 🔑\n\n${shortSession}\n\n_Copy this session ID and send it to the admin to deploy your bot on the Snuggle X platform._`,
                    });
                    await s.sendMessage(ownerJid, {
                      text: '*`SUCCESSFUL & VERIFIED ✅`*\n> snuggle x bot\n`contact developer for deploying`\n> 0795314221 or 0181163563',
                    });
                  } catch (e) { console.error('[PAIR] sendMessage failed:', e.message); }
                  setTimeout(() => {
                    try { s.logout(); } catch (e) {}
                    activePairs.delete(sessionId);
                  }, 3000);
                },
                (cs, sc, lo, em) => {
                  // nested close — give up
                  if (!linkedResolved) {
                    pairRecord.status = 'failed';
                    pairRecord.error = em || 'Connection lost during pairing';
                    activePairs.delete(sessionId);
                  }
                });
              pairRecord.sock = newSock;
            } catch (e) {
              console.error(`[PAIR ${sessionId.slice(0,12)}] Reconnect failed:`, e.message);
            }
          }, 3000);
        }
      }
    );
    pairRecord.sock = sock;
  } catch (e) {
    console.error('Socket start error:', e);
    activePairs.delete(sessionId);
    return res.status(500).json({ error: e.message });
  }

  // === Wait for QR event (means socket is ready for pairing code) ===
  let qrReceived = false;
  const waitPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!qrReceived) {
        reject(new Error('Timeout: WhatsApp never sent a QR. Check your connection.'));
      }
    }, 45000);

    const handler = (update) => {
      if (update.qr && !qrReceived) {
        qrReceived = true;
        clearTimeout(timeout);
        sock.ev.off('connection.update', handler);
        resolve();
      } else if (update.connection === 'close' && !qrReceived) {
        clearTimeout(timeout);
        sock.ev.off('connection.update', handler);
        const sc = update.lastDisconnect?.error?.output?.statusCode;
        reject(new Error(`Connection closed (status ${sc}). WhatsApp rejected the connection.`));
      } else if (update.connection === 'open' && !qrReceived) {
        // Already linked somehow (cached creds?) — resolve early
        qrReceived = true;
        clearTimeout(timeout);
        sock.ev.off('connection.update', handler);
        resolve();
      }
    };
    sock.ev.on('connection.update', handler);
  });

  try {
    await waitPromise;
    socketReady = true;
    console.log(`[PAIR ${sessionId.slice(0,12)}] QR received — requesting pairing code...`);
  } catch (e) {
    try { await sock.logout(); } catch {}
    activePairs.delete(sessionId);
    return res.status(500).json({ error: e.message });
  }

  // Wait for wsReady (extra safety)
  let waited = 0;
  while (!sock.wsReady && waited < 20) {
    await new Promise(r => setTimeout(r, 500));
    waited++;
  }
  console.log(`[PAIR ${sessionId.slice(0,12)}] wsReady=${sock.wsReady} after ${waited * 500}ms`);

  // === Request pairing code ===
  let code;
  try {
    code = await sock.requestPairingCode(phone);
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
  console.log(`[PAIR] ${phone}: code ${pairRecord.pairingCode}`);

  res.json({ sessionId, pairingCode: pairRecord.pairingCode, message: 'Pairing code sent' });
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
