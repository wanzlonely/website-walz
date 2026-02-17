const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn, exec } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const TelegramBot = require('node-telegram-bot-api');

const TG_TOKEN = process.env.TG_TOKEN || '8227444423:AAGJcCOkeZ0dVAWzQrbJ9J9auRzCvDHceWc';
const OWNER_ID = process.env.OWNER_ID || '8062935882';
const ADMIN_PASS = process.env.ADMIN_PASS || 'walzexploit';
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'tokens.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

let activeTokens = {};
let currentProcess = null;
let isRunning = false;
let bot = null;

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
  } catch (e) {
    console.log('DB Error');
  }
}

function generateToken(len = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let res = 'WL-';
  for (let i = 0; i < len; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
  return res;
}

loadTokens();

try {
  bot = new TelegramBot(TG_TOKEN, { polling: true });
  console.log(`[SYSTEM] Bot Telegram Active. Owner: ${OWNER_ID}`);

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
  });
  
  bot.on('polling_error', () => {});
} catch (e) {
  console.log('[SYSTEM] Telegram Bot Error');
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static(__dirname));

const checkAuth = (req, res, next) => {
  const token = req.headers['authorization'];
  if (token === ADMIN_PASS) return next();
  
  loadTokens();
  
  if (!token || !activeTokens[token]) return res.status(401).json({ success: false, msg: 'Invalid Token' });
  if (Date.now() > activeTokens[token]) {
    delete activeTokens[token];
    saveTokens();
    return res.status(401).json({ success: false, msg: 'Expired' });
  }
  next();
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/login', (req, res) => {
  let { token } = req.body;
  token = String(token || '').trim();
  
  loadTokens();

  if (token === ADMIN_PASS) {
    return res.json({ success: true, role: 'OWNER', expired: null });
  }

  if (activeTokens[token]) {
    if (Date.now() < activeTokens[token]) {
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

app.post('/files', checkAuth, (req, res) => {
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
        return { name: f, isDir: s.isDirectory(), path: path.relative(UPLOAD_DIR, fp).replace(/\\/g, '/') };
      } catch { return null; }
    }).filter(Boolean);
    
    data.sort((a, b) => b.isDir - a.isDir);
    res.json({ success: true, data, currentPath: reqPath });
  } catch {
    res.json({ success: false, data: [] });
  }
});

app.post('/read', checkAuth, (req, res) => {
  try {
    const target = path.join(UPLOAD_DIR, req.body.path);
    if (!path.resolve(target).startsWith(path.resolve(UPLOAD_DIR))) throw new Error();
    
    const stats = fs.statSync(target);
    if (stats.size > 2 * 1024 * 1024) return res.json({ success: false, msg: 'File too large' });

    const content = fs.readFileSync(target, 'utf8');
    res.json({ success: true, content });
  } catch (e) {
    res.json({ success: false, msg: 'Read Error' });
  }
});

app.post('/save', checkAuth, (req, res) => {
  try {
    const target = path.join(UPLOAD_DIR, req.body.path);
    if (!path.resolve(target).startsWith(path.resolve(UPLOAD_DIR))) throw new Error();
    
    fs.writeFileSync(target, req.body.content);
    res.json({ success: true, msg: 'Saved' });
  } catch (e) {
    res.json({ success: false, msg: 'Save Error' });
  }
});

app.post('/delete', checkAuth, (req, res) => {
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
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, file.originalname)
  })
});

app.post('/upload', upload.single('file'), (req, res) => res.json({ success: true }));

app.post('/unzip', checkAuth, (req, res) => {
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

app.post('/start', checkAuth, (req, res) => {
  if (isRunning) return res.json({ success: false, msg: 'Bot Running' });

  const findEntry = (dir) => {
    try {
      const files = fs.readdirSync(dir);
      if (files.includes('package.json')) {
        try {
          const pkg = require(path.join(dir, 'package.json'));
          if (pkg.main) return path.join(dir, pkg.main);
        } catch {}
      }
      const candidates = ['index.js', 'main.js', 'bot.js', 'server.js'];
      for (const c of candidates) if (files.includes(c)) return path.join(dir, c);
      for (const f of files) {
        const sub = path.join(dir, f);
        if (fs.statSync(sub).isDirectory() && f !== 'node_modules') {
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
        spawnBot(entry, cwd);
      } else {
        io.emit('log', `\x1b[31m[FAIL] Install error.\x1b[0m\n`);
      }
    });
  } else {
    spawnBot(entry, cwd);
  }
  res.json({ success: true });
});

function spawnBot(file, cwd) {
  if (isRunning) return;
  isRunning = true;
  currentProcess = spawn('node', [file], { cwd, stdio: 'pipe' });
  
  currentProcess.stdout.on('data', d => io.emit('log', d.toString()));
  currentProcess.stderr.on('data', d => io.emit('log', `\x1b[31m${d.toString()}\x1b[0m`));
  
  currentProcess.on('close', (code) => {
    isRunning = false;
    currentProcess = null;
    io.emit('log', `\n\x1b[31m[STOP] Exit Code: ${code}\x1b[0m\n`);
  });
}

app.post('/stop', checkAuth, (req, res) => {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
    isRunning = false;
    io.emit('log', `\x1b[31m[STOP] Process Killed.\x1b[0m\n`);
    res.json({ success: true });
  } else {
    res.json({ success: false, msg: 'Not Running' });
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
      if (cmd.startsWith('sudo') || cmd.includes('rm -rf /')) return io.emit('log', `\x1b[31m[DENIED]\x1b[0m\n`);
      
      exec(cmd, { cwd: UPLOAD_DIR }, (err, stdout, stderr) => {
        if (err) io.emit('log', `\x1b[31m${err.message}\x1b[0m\n`);
        if (stderr) io.emit('log', `\x1b[33m${stderr}\x1b[0m\n`);
        if (stdout) io.emit('log', stdout);
      });
    }
  });
});

function emitStats() {
  const ram = Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB';
  io.emit('stats', { ram, status: isRunning ? 'ONLINE' : 'OFFLINE' });
}
setInterval(emitStats, 2000);

server.listen(PORT, () => console.log(`[SERVER] Running on Port ${PORT}`));
