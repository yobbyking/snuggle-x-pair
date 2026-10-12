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

// === Pairing flow — minimal config, no manual reconnect ===
// Let Baileys handle the connection entirely. We only:
//   1) create the socket
//   2) wait for the 'connecting' event (means WS is up + noise handshake starting)
//   3) call requestPairingCode (Baileys queues it internally and sends when ready)
//   4) wait for 'open' event (user entered the code on their phone)
//   5) send session ID + success message, then disconnect
app.post('/api/pair/start', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (phone.length < 11) {
    return res.status(400).json({ error: 'Include country code (e.g. 254712345678)' });
  }

  const sessionId = 'snuggle-' + crypto.randomUUID().slice(0, 8);
  const sessionFolder = path.join(SESSIONS_DIR, sessionId);
  fs.rmSync(sessionFolder, { recursive: true, force: true });
  fs.mkdirSync(sessionFolder, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[PAIR] Baileys v${version.join('.')} for ${phone}`);

    // Minimal config — let Baileys use defaults for everything else
    // Browsers.ubuntu('Chrome') is a known-working fingerprint
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      logger: P({ level: 'warn' }),
    });

    const pairRecord = { sock, sessionFolder, phone, pairingCode: null, status: 'starting', error: null };
    activePairs.set(sessionId, pairRecord);

    sock.ev.on('creds.update', saveCreds);

    let codeRequested = false;
    let connectionAttempts = 0;

    sock.ev.on('connection.update', async (update) => {
      connectionAttempts++;
      console.log(`[PAIR ${sessionId.slice(0,12)}#${connectionAttempts}]`, update.connection || '(empty)');

      // First connecting event — request the pairing code
      if (update.connection === 'connecting' && !codeRequested) {
        codeRequested = true;
        // Wait for the noise handshake to settle — Baileys' sendNode will queue the IQ
        // until the socket is ready, but we give it a beat to start the handshake
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
        }, 2000);
      }

      // === USER LINKED THEIR PHONE ===
      if (update.connection === 'open') {
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

        // Disconnect after sending messages — bot will be deployed separately
        setTimeout(() => {
          try { sock.logout(); } catch (e) {}
          activePairs.delete(sessionId);
        }, 3000);
      }

      // Connection closed — record the failure but DON'T auto-reconnect (Baileys does this itself if appropriate)
      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        const reason = update.lastDisconnect?.error?.message;
        console.log(`[PAIR] closed code=${code} reason=${reason}`);
        if (code === DisconnectReason.loggedOut) {
          pairRecord.status = 'failed';
          pairRecord.error = 'Session logged out';
          activePairs.delete(sessionId);
        } else if (pairRecord.status !== 'linked') {
          // If we haven't linked yet and the connection drops, don't immediately fail —
          // Baileys will auto-reconnect for transient errors. Wait briefly.
          // Only mark as failed if we never even got the pairing code out
          if (!pairRecord.pairingCode && codeRequested) {
            // We attempted but never got a code — likely a real failure
            setTimeout(() => {
              if (!activePairs.has(sessionId)) return;
              if (pairRecord.status !== 'linked' && !pairRecord.pairingCode) {
                pairRecord.status = 'failed';
                pairRecord.error = reason || 'Connection closed before pairing code was sent';
              }
            }, 5000);
          }
          // Otherwise — keep the record alive so Baileys can auto-reconnect
          // The user might still be entering the code
        }
      }
    });

    res.json({ sessionId, pairingCode: null, message: 'Pairing in progress' });
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
