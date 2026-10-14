/* === SNUGGLE X — Pairing Portal Logic === */
const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  pairCode: null,
  pollTimer: null,
  startTime: Date.now(),
  stats: { visitors: 0, requests: 0, success: 0, failed: 0 },
};

// === Init ===
consoleLog('[BOOT]', 'SNUGGLE X portal initialized.');
consoleLog('[INFO]', 'Ready for pairing request...');

// Load stats from localStorage
const saved = localStorage.getItem('snuggle-x-stats');
if (saved) {
  try { state.stats = JSON.parse(saved); updateStats(); } catch (e) {}
}
// Track a visit
state.stats.visitors++;
saveStats();
updateStats();

// === Starfield animation ===
const canvas = $('stars');
const ctx = canvas.getContext('2d');
let stars = [];

function initStars() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  stars = [];
  const count = Math.floor((canvas.width * canvas.height) / 12000);
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.4,
      o: Math.random(),
      s: Math.random() * 0.5 + 0.2,
      color: Math.random() > 0.7 ? '#B026FF' : Math.random() > 0.6 ? '#FFB800' : '#00FFB3',
    });
  }
}

function drawStars() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of stars) {
    s.y += s.s * 0.3;
    if (s.y > canvas.height) s.y = 0;
    s.o += (Math.random() - 0.5) * 0.05;
    s.o = Math.max(0.1, Math.min(1, s.o));
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.globalAlpha = s.o * 0.7;
    ctx.fill();
    ctx.shadowColor = s.color;
    ctx.shadowBlur = s.r * 4;
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  requestAnimationFrame(drawStars);
}

initStars();
drawStars();
window.addEventListener('resize', initStars);

// === Uptime ===
function updateUptime() {
  const sec = Math.floor((Date.now() - state.startTime) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  $('uptime').textContent = `${h}h ${m}m ${s}s`;
}
setInterval(updateUptime, 1000);
updateUptime();

// === Stats ===
function updateStats() {
  $('visitors').textContent = state.stats.visitors;
  $('requests').textContent = state.stats.requests;
  $('success').textContent = state.stats.success;
  $('failed').textContent = state.stats.failed;
}
function saveStats() { localStorage.setItem('snuggle-x-stats', JSON.stringify(state.stats)); }
function bumpStat(key) { state.stats[key]++; saveStats(); updateStats(); }

// === Console log ===
function consoleLog(tag, msg, type = '') {
  const log = $('consoleLog');
  const line = document.createElement('div');
  line.className = 'log-line' + (type ? ' ' + type : '');
  line.innerHTML = `<span class="t">${tag}</span>${msg}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 30) log.removeChild(log.firstChild);
}

// === Live status ===
function setLiveStatus(text, type = '') {
  const el = $('liveStatus');
  el.className = 'oz-alert' + (type ? ' ' + type : '');
  el.querySelector('span').textContent = text;
}

// === Phone validation ===
function validatePhone(raw) {
  const phone = String(raw || '').replace(/[^\d]/g, '');
  if (phone.length < 11) return null;
  if (phone.startsWith('0') && phone.length > 10) return phone.slice(1);
  return phone;
}

// === Generate pairing code ===
async function generatePair() {
  const raw = $('number').value.trim();
  const phone = validatePhone(raw);

  if (!phone) {
    $('error').classList.add('show');
    consoleLog('[ERROR]', 'Invalid phone number entered.', 'error');
    bumpStat('failed');
    return;
  }
  $('error').classList.remove('show');

  // UI: show loading
  $('submit').disabled = true;
  $('stickyGenerate').disabled = true;
  $('btn-text').textContent = 'Generating...';
  $('loading').style.display = 'block';
  $('result').style.display = 'none';
  $('resetBtn').style.display = 'block';
  $('stickyBar').classList.add('show');

  $('loading-msg').textContent = 'Spinning up the web...';
  $('loading-sub').textContent = 'Connecting to WhatsApp servers via Baileys';
  setLiveStatus('Connecting to WhatsApp...', '');
  consoleLog('[PAIR]', `Requesting pairing code for +${phone}...`);
  bumpStat('requests');

  try {
    const res = await axios.post('/api/pair/start', { phone });
    if (res.data.error) throw new Error(res.data.error);

    state.sessionId = res.data.sessionId;
    state.pairCode = res.data.pairingCode;

    $('loading-msg').textContent = 'Code generated. Enter in WhatsApp...';
    $('loading-sub').textContent = 'Open WhatsApp → Settings → Linked Devices → Link with phone number';
    setLiveStatus('Pairing code generated — enter in WhatsApp', '');

    if (state.pairCode) {
      showCode(state.pairCode);
    }
    startPolling();
  } catch (e) {
    consoleLog('[ERROR]', e.response?.data?.error || e.message, 'error');
    bumpStat('failed');
    $('loading').style.display = 'none';
    $('loading-msg').textContent = '';
    $('submit').disabled = false;
    $('stickyGenerate').disabled = false;
    $('btn-text').textContent = 'Generate Pair Code';
    setLiveStatus('Pairing failed: ' + (e.response?.data?.error || e.message), 'error');
    // Show error in hint area
    $('result').style.display = 'block';
    $('generated-code').textContent = 'ERROR';
    $('session-status').style.display = 'block';
    $('session-status').className = 'oz-hint error';
    $('session-status').textContent = e.response?.data?.error || e.message;
  }
}

// === Show code ===
function showCode(code) {
  state.pairCode = code;
  $('loading').style.display = 'none';
  $('result').style.display = 'block';
  $('generated-code').textContent = code;
  $('stickyCopy').disabled = false;
  consoleLog('[CODE]', `Pairing code: ${code}`, 'success');
}

// === Poll for status ===
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (!state.sessionId) return;
    try {
      const res = await axios.get(`/api/pair/status/${state.sessionId}`);
      const data = res.data;
      if (data.pairingCode && !state.pairCode) {
        showCode(data.pairingCode);
      }
      if (data.error) {
        clearInterval(state.pollTimer);
        bumpStat('failed');
        setLiveStatus('Error: ' + data.error, 'error');
        $('session-status').style.display = 'block';
        $('session-status').className = 'oz-hint error';
        $('session-status').textContent = data.error;
        $('submit').disabled = false;
        $('stickyGenerate').disabled = false;
        $('btn-text').textContent = 'Try Again';
        consoleLog('[ERROR]', data.error, 'error');
      }
      if (data.linked) {
        clearInterval(state.pollTimer);
        bumpStat('success');
        setLiveStatus('✅ Session ID sent to your WhatsApp!', 'linked');
        $('session-status').style.display = 'block';
        $('session-status').className = 'oz-hint success';
        $('session-status').textContent = '✅ Linked! Session ID has been sent to your WhatsApp. Send it to the admin to deploy your bot.';
        $('submit').textContent = 'Linked ✅';
        $('btn-text').textContent = 'Linked ✅';
        $('downloadBtn').disabled = false;
        $('downloadBtn').style.display = '';
        $('modalDownload').disabled = false;
        $('modalDownload').style.display = '';
        consoleLog('[OK]', 'Pairing successful! Session ID sent.', 'success');
      }
    } catch (e) { /* ignore transient errors */ }
  }, 2000);
}

// === Copy code ===
function copyCode() {
  if (!state.pairCode) return;
  navigator.clipboard.writeText(state.pairCode).then(() => {
    const btn = $('copy-btn-text');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
    consoleLog('[COPY]', 'Pairing code copied to clipboard.');
  });
}

// === Download session info ===
function downloadSession() {
  if (!state.sessionId) return;
  const blob = new Blob([`SNUGGLE X SESSION\n================\n\nPhone: +${validatePhone($('number').value)}\nPairing Code: ${state.pairCode || 'N/A'}\nSession ID: ${state.sessionId}\nStatus: Linked ✅\n\nGenerated at: ${new Date().toISOString()}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `snuggle-x-${state.sessionId}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  consoleLog('[DL]', 'Session info downloaded.');
}

// === Modal ===
function openModal() {
  $('modal').classList.add('show');
  $('modal').setAttribute('aria-hidden', 'false');
  $('modalInfo').textContent = state.pairCode ? `Pair Code: ${state.pairCode}` : 'No pair code yet.';
  $('modalText').value = state.pairCode || 'No code generated yet.';
}
function closeModal() {
  $('modal').classList.remove('show');
  $('modal').setAttribute('aria-hidden', 'true');
}

// === Reset ===
function resetAll() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.sessionId = null;
  state.pairCode = null;
  $('number').value = '';
  $('loading').style.display = 'none';
  $('result').style.display = 'none';
  $('resetBtn').style.display = 'none';
  $('stickyBar').classList.remove('show');
  $('submit').disabled = false;
  $('stickyGenerate').disabled = false;
  $('stickyCopy').disabled = true;
  $('btn-text').textContent = 'Generate Pair Code';
  $('session-status').style.display = 'none';
  setLiveStatus('Ready for pairing request.', '');
  consoleLog('[RESET]', 'Portal reset.');
}

// === Event listeners ===
$('submit').addEventListener('click', generatePair);
$('stickyGenerate').addEventListener('click', generatePair);
$('stickyCopy').addEventListener('click', copyCode);
$('copy-btn').addEventListener('click', copyCode);
$('generated-code').addEventListener('click', copyCode);
$('generated-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') copyCode(); });
$('downloadBtn').addEventListener('click', downloadSession);
$('resetBtn').addEventListener('click', resetAll);
$('openModalBtn').addEventListener('click', openModal);
$('modalClose').addEventListener('click', closeModal);
$('modalBackdrop').addEventListener('click', closeModal);
$('modalCopy').addEventListener('click', () => {
  navigator.clipboard.writeText($('modalText').value);
});
$('modalDownload').addEventListener('click', downloadSession);
$('number').addEventListener('keydown', (e) => { if (e.key === 'Enter') generatePair(); });
$('number').addEventListener('input', () => $('error').classList.remove('show'));

// === Health check (server online pill) ===
async function checkHealth() {
  try {
    await axios.get('/api/health');
    // pill stays green
  } catch (e) {
    document.querySelector('.pill-text').textContent = 'OFFLINE';
    document.querySelector('.oz-pill').style.background = 'rgba(255, 71, 87, 0.1)';
    document.querySelector('.oz-pill').style.borderColor = 'rgba(255, 71, 87, 0.3)';
    document.querySelector('.pill-dot').style.background = '#FF4757';
    document.querySelector('.pill-dot').style.boxShadow = '0 0 8px #FF4757';
  }
}
checkHealth();
setInterval(checkHealth, 30000);
