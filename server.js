const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn, exec } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const TelegramBot = require('node-telegram-bot-api');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');

const TG_TOKEN = process.env.TG_TOKEN || '8227444423:AAGJcCOkeZ0dVAWzQrbJ9J9auRzCvDHceWc';
const OWNER_ID = process.env.OWNER_ID || '8062935882';
const ADMIN_PASS = process.env.ADMIN_PASS || 'walzexploit';
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const MAX_RESTARTS = 5;

const DB_FILE = path.join(__dirname, 'tokens.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_FILE = path.join(__dirname, 'activity.log');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

let activeTokens = {};
let currentProcess = null;
let isRunning = false;
let startTime = null;
let bot = null;
let restartCount = 0;
let restartTimer = null;

const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_REGEX = /^WL-[A-Z2-9]{10}$/;

function logActivity(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  console.log(message);
  fs.appendFile(LOG_FILE, logLine, () => {});
}

function loadTokens() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      activeTokens = JSON.parse(raw) || {};
    }
  } catch (e) {
    activeTokens = {};
  }
}

function saveTokens() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(activeTokens, null, 2));
    fs.writeFileSync(DB_FILE + '.backup', JSON.stringify(activeTokens, null, 2));
  } catch (e) {}
}

function generateToken(len = 10) {
  let res = 'WL-';
  for (let i = 0; i < len; i++) {
    res += TOKEN_CHARS.charAt(Math.floor(Math.random() * TOKEN_CHARS.length));
  }
  return res;
}

loadTokens();
setInterval(() => {
  try {
    fs.copyFileSync(DB_FILE, DB_FILE + '.backup');
  } catch (e) {}
}, 60000);

try {
  bot = new TelegramBot(TG_TOKEN, { polling: true });
  logActivity(`[SYSTEM] Bot Telegram Active. Owner: ${OWNER_ID}`);

  bot.onText(/\/id/, (msg) => {
    bot.sendMessage(msg.chat.id, `🆔: <code>${msg.chat.id}</code>`, { parse_mode: 'HTML' });
  });

  bot.onText(/\/akses (\d+)/, (msg, match) => {
    if (String(msg.chat.id) !== String(OWNER_ID)) return;
    loadTokens();
    const days = parseInt(match[1]);
    const token = generateToken();
    const exp = Date.now() + (days * 86400000);
    activeTokens[token] = exp;
    saveTokens();
    bot.sendMessage(msg.chat.id, `✅ <b>AKSES DIBUAT</b>\n🔑: <code>${token}</code>\n⏳: ${days} Hari`, { parse_mode: 'HTML' });
    logActivity(`[BOT] Token created: ${token} for ${days} days by ${msg.chat.id}`);
  });

  bot.on('polling_error', (err) => {
    logActivity(`[BOT] Polling error: ${err.message}`);
  });
} catch (e) {
  logActivity(`[SYSTEM] Telegram Bot Error: ${e.message}`);
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(PUBLIC_DIR));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, msg: 'Too many attempts, try later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { success: false, msg: 'Too many requests.' },
});

const checkAuth = (req, res, next) => {
  let token = req.headers['authorization'];
  if (!token) return res.status(401).json({ success: false, msg: 'No token provided' });
  token = token.trim();
  if (token === ADMIN_PASS) {
    req.isOwner = true;
    return next();
  }
  token = token.toUpperCase();
  if (!TOKEN_REGEX.test(token)) {
    return res.status(401).json({ success: false, msg: 'Invalid token format' });
  }
  loadTokens();
  if (!activeTokens[token]) return res.status(401).json({ success: false, msg: 'Invalid Token' });
  if (Date.now() > activeTokens[token]) {
    delete activeTokens[token];
    saveTokens();
    return res.status(401).json({ success: false, msg: 'Token Expired' });
  }
  next();
};

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.post('/login', authLimiter, (req, res) => {
  let { token } = req.body;
  token = String(token || '').trim();
  if (token === ADMIN_PASS) {
    logActivity(`[LOGIN] Owner login from ${req.ip}`);
    return res.json({ success: true, role: 'OWNER', expired: null });
  }
  token = token.toUpperCase();
  if (!TOKEN_REGEX.test(token)) {
    return res.json({ success: false, msg: 'Invalid token format' });
  }
  loadTokens();
  if (activeTokens[token]) {
    if (Date.now() < activeTokens[token]) {
      logActivity(`[LOGIN] Token used: ${token} from ${req.ip}`);
      res.json({ success: true, role: 'PREMIUM', expired: activeTokens[token] });
    } else {
      delete activeTokens[token];
      saveTokens();
      res.json({ success: false, msg: 'Token Expired' });
    }
  } else {
    res.json({ success: false, msg: 'Invalid Token' });
  }
});

app.post('/files', apiLimiter, checkAuth, (req, res) => {
  const reqPath = req.body.path || '';
  const target = path.join(UPLOAD_DIR, reqPath);
  if (!path.resolve(target).startsWith(path.resolve(UPLOAD_DIR))) {
    return res.json({ success: false, data: [] });
  }
  try {
    const files = fs.readdirSync(target);
    const data = files.map(f => {
      const fp = path.join(target, f);
      try {
        const s = fs.statSync(fp);
        return {
          name: f,
          isDir: s.isDirectory(),
          size: s.isFile() ? s.size : null,
          path: path.relative(UPLOAD_DIR, fp).replace(/\\/g, '/')
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
    data.sort((a, b) => b.isDir - a.isDir);
    res.json({ success: true, data, currentPath: reqPath });
  } catch {
    res.json({ success: false, data: [] });
  }
});

app.post('/read', apiLimiter, checkAuth, (req, res) => {
  try {
    const target = path.join(UPLOAD_DIR, req.body.path);
    if (!path.resolve(target).startsWith(path.resolve(UPLOAD_DIR))) throw new Error();
    const stats = fs.statSync(target);
    if (stats.size > 5 * 1024 * 1024) {
      return res.json({ success: false, msg: 'File too large (max 5MB)' });
    }
    const content = fs.readFileSync(target, 'utf8');
    res.json({ success: true, content });
  } catch (e) {
    res.json({ success: false, msg: 'Read Error' });
  }
});

app.post('/save', apiLimiter, checkAuth, (req, res) => {
  try {
    const target = path.join(UPLOAD_DIR, req.body.path);
    if (!path.resolve(target).startsWith(path.resolve(UPLOAD_DIR))) throw new Error();
    fs.writeFileSync(target, req.body.content);
    res.json({ success: true, msg: 'Saved' });
  } catch (e) {
    res.json({ success: false, msg: 'Save Error' });
  }
});

app.post('/delete', apiLimiter, checkAuth, (req, res) => {
  try {
    const target = path.join(UPLOAD_DIR, req.body.filename);
    if (!path.resolve(target).startsWith(path.resolve(UPLOAD_DIR))) throw new Error();
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ success: true });
  } catch {
    res.json({ success: false });
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext);
      let filename = file.originalname;
      let counter = 1;
      while (fs.existsSync(path.join(UPLOAD_DIR, filename))) {
        filename = `${base} (${counter})${ext}`;
        counter++;
      }
      cb(null, filename);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.post('/upload', apiLimiter, checkAuth, upload.single('file'), (req, res) => {
  res.json({ success: true, filename: req.file.filename });
});

app.post('/unzip', apiLimiter, checkAuth, (req, res) => {
  try {
    const target = path.join(UPLOAD_DIR, req.body.filename);
    const zip = new AdmZip(target);
    zip.extractAllTo(UPLOAD_DIR, true);
    fs.unlinkSync(target);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

function spawnBotWithRestart(file, cwd) {
  if (isRunning) return;
  isRunning = true;
  startTime = Date.now();
  restartCount = 0;
  currentProcess = spawn('node', [file], { cwd, stdio: 'pipe' });

  currentProcess.stdout.on('data', d => io.emit('log', d.toString()));
  currentProcess.stderr.on('data', d => io.emit('log', `\x1b[31m${d.toString()}\x1b[0m`));

  currentProcess.on('close', (code) => {
    isRunning = false;
    currentProcess = null;
    startTime = null;
    io.emit('log', `\n\x1b[31m[STOP] Exit Code: ${code}\x1b[0m\n`);
    logActivity(`[BOT] Process exited with code ${code}`);
    if (code !== 0 && restartCount < MAX_RESTARTS) {
      restartCount++;
      io.emit('log', `\x1b[33m[SYSTEM] Restarting (${restartCount}/${MAX_RESTARTS})...\x1b[0m\n`);
      setTimeout(() => {
        if (!isRunning) spawnBotWithRestart(file, cwd);
      }, 3000);
    }
  });
}

app.post('/start', apiLimiter, checkAuth, (req, res) => {
  if (isRunning) return res.json({ success: false, msg: 'Bot Running' });

  const findEntry = (dir) => {
    try {
      const files = fs.readdirSync(dir);
      if (files.includes('package.json')) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
          if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return path.join(dir, pkg.main);
        } catch {}
      }
      const candidates = ['index.js', 'main.js', 'bot.js', 'server.js'];
      for (const c of candidates) {
        if (files.includes(c)) return path.join(dir, c);
      }
      for (const f of files) {
        const sub = path.join(dir, f);
        if (fs.statSync(sub).isDirectory() && f !== 'node_modules' && !f.startsWith('.')) {
          const found = findEntry(sub);
          if (found) return found;
        }
      }
    } catch {}
    return null;
  };

  const entry = findEntry(UPLOAD_DIR);
  if (!entry) return res.json({ success: false, msg: 'No Bot File Found' });

  const cwd = path.dirname(entry);
  io.emit('log', `\x1b[36m[SYSTEM] Starting: ${path.basename(entry)}\x1b[0m\n`);

  if (!fs.existsSync(path.join(cwd, 'node_modules')) && fs.existsSync(path.join(cwd, 'package.json'))) {
    io.emit('log', `\x1b[33m[INSTALL] npm install...\x1b[0m\n`);
    const install = spawn('npm', ['install'], { cwd, shell: true });
    install.stdout.on('data', d => io.emit('log', d.toString()));
    install.stderr.on('data', d => io.emit('log', d.toString()));
    install.on('close', (code) => {
      if (code === 0) {
        io.emit('log', `\x1b[32m[OK] Install done. Starting...\x1b[0m\n`);
        spawnBotWithRestart(entry, cwd);
      } else {
        io.emit('log', `\x1b[31m[FAIL] Install error.\x1b[0m\n`);
      }
    });
  } else {
    spawnBotWithRestart(entry, cwd);
  }
  res.json({ success: true });
});

app.post('/stop', apiLimiter, checkAuth, (req, res) => {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
    isRunning = false;
    startTime = null;
    restartCount = MAX_RESTARTS;
    io.emit('log', `\x1b[31m[STOP] Process Killed.\x1b[0m\n`);
    res.json({ success: true });
  } else {
    res.json({ success: false, msg: 'Not Running' });
  }
});

app.post('/token/list', apiLimiter, checkAuth, (req, res) => {
  if (!req.isOwner) return res.status(403).json({ success: false, msg: 'Forbidden' });
  loadTokens();
  const tokens = Object.entries(activeTokens).map(([token, exp]) => ({
    token,
    expires: new Date(exp).toISOString(),
    remaining: Math.max(0, exp - Date.now())
  }));
  res.json({ success: true, tokens });
});

app.post('/token/revoke', apiLimiter, checkAuth, (req, res) => {
  if (!req.isOwner) return res.status(403).json({ success: false, msg: 'Forbidden' });
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.json({ success: false, msg: 'Invalid token' });
  loadTokens();
  if (activeTokens[token]) {
    delete activeTokens[token];
    saveTokens();
    res.json({ success: true });
  } else {
    res.json({ success: false, msg: 'Token not found' });
  }
});

io.on('connection', (socket) => {
  emitStats();
  socket.on('input', (cmd) => {
    if (!cmd) return;
    if (isRunning && currentProcess) {
      currentProcess.stdin.write(cmd + '\n');
    } else {
      io.emit('log', `\x1b[36m$ ${cmd}\x1b[0m\n`);
      if (cmd.startsWith('sudo') || cmd.includes('rm -rf /')) {
        return io.emit('log', `\x1b[31m[DENIED]\x1b[0m\n`);
      }
      exec(cmd, { cwd: UPLOAD_DIR, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) io.emit('log', `\x1b[31m${err.message}\x1b[0m\n`);
        if (stderr) io.emit('log', `\x1b[33m${stderr}\x1b[0m\n`);
        if (stdout) io.emit('log', stdout);
      });
    }
  });
});

function formatUptime(ms) {
  const s = Math.floor((ms / 1000) % 60);
  const m = Math.floor((ms / 1000 / 60) % 60);
  const h = Math.floor((ms / 1000 / 3600));
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function emitStats() {
  const ram = Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB';
  let uptime = '00:00:00';
  if (isRunning && startTime) {
    uptime = formatUptime(Date.now() - startTime);
  }
  const ping = Math.floor(Math.random() * 20 + 5) + ' ms';
  io.emit('stats', {
    ram,
    status: isRunning ? 'ONLINE' : 'OFFLINE',
    uptime,
    ping
  });
}

setInterval(emitStats, 1000);

server.listen(PORT, () => {
  logActivity(`[SERVER] Running on Port ${PORT} (${NODE_ENV} mode)`);
});

process.on('uncaughtException', (err) => {
  logActivity(`[FATAL] Uncaught Exception: ${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logActivity(`[FATAL] Unhandled Rejection at: ${promise}, reason: ${reason}`);
});