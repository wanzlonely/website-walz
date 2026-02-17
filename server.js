const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn } = require('child_process');
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

let activeTokens = {};

function loadTokens() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      activeTokens = JSON.parse(data) || {};
    }
  } catch (e) {
    console.error('[DB LOAD ERR]', e.message);
    activeTokens = {};
  }
}

function saveTokens() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(activeTokens, null, 2));
    return true;
  } catch (e) {
    console.error('[DB SAVE ERR]', e.message);
    return false;
  }
}

function generateHardToken(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `WL-${result}`;
}

loadTokens();

let bot = null;
try {
  bot = new TelegramBot(TG_TOKEN, { polling: true });
  console.log(`[SYSTEM] Bot Panel Started. Owner ID: ${OWNER_ID}`);

  bot.onText(/\/id/, (msg) => {
    bot.sendMessage(msg.chat.id, `🆔 ID: <code>${msg.chat.id}</code>`, { parse_mode: 'HTML' });
  });

  bot.onText(/\/akses (\d+)/, (msg, match) => {
    const chatId = String(msg.chat.id);
    if (chatId !== String(OWNER_ID)) {
      return bot.sendMessage(chatId, '⛔ Akses Ditolak.');
    }

    const days = parseInt(match[1]);
    if (!days) return bot.sendMessage(chatId, '⚠ Format: `/akses 30`');

    const token = generateHardToken(16);
    const expired = Date.now() + (days * 24 * 60 * 60 * 1000);

    activeTokens[token] = expired;
    saveTokens();

    const dateStr = new Date(expired).toLocaleDateString('id-ID');
    bot.sendMessage(chatId,
      `✅ <b>AKSES DIBUAT</b>\n🔑: <code>${token}</code>\n⏳: ${days} Hari\n📅: ${dateStr}\n\nLogin di Web Panel sekarang.`,
      { parse_mode: 'HTML' }
    );
  });

  bot.on('polling_error', (error) => {
    if (error.code !== 'EFATAL') console.log(`[TG ERROR] ${error.message}`);
  });

} catch (e) {
  console.log('[TG INIT ERR] Cek Token Bot Telegram Anda.', e.message);
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let currentProcess = null;
let isRunning = false;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.static(__dirname));
app.use(express.json());

const checkAuth = (req, res, next) => {
  let token = req.headers['authorization'];
  token = token ? String(token).trim() : '';

  if (token === ADMIN_PASS) return next();

  if (!token || !activeTokens[token]) {
    return res.status(401).json({ success: false, msg: 'Token Invalid' });
  }
  if (Date.now() > activeTokens[token]) {
    delete activeTokens[token];
    saveTokens();
    return res.status(401).json({ success: false, msg: 'Token Expired' });
  }
  next();
};

function safePath(userPath) {
  const target = path.join(UPLOAD_DIR, userPath || '');
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) {
    throw new Error('Invalid path');
  }
  return resolved;
}

app.post('/login', (req, res) => {
  let { token } = req.body;
  token = String(token || '').trim();

  if (token === ADMIN_PASS) {
    return res.json({ success: true, msg: 'Welcome Admin', role: 'OWNER', expired: null });
  }

  if (activeTokens[token]) {
    if (Date.now() < activeTokens[token]) {
      res.json({ success: true, msg: 'Akses Diterima', role: 'PREMIUM', expired: activeTokens[token] });
    } else {
      delete activeTokens[token];
      saveTokens();
      res.json({ success: false, msg: 'Token Expired' });
    }
  } else {
    res.json({ success: false, msg: 'Token Tidak Ditemukan' });
  }
});

app.post('/files', checkAuth, (req, res) => {
  try {
    const target = safePath(req.body.path);
    const items = fs.readdirSync(target).map(name => {
      const full = path.join(target, name);
      try {
        const stat = fs.statSync(full);
        return {
          name,
          isDir: stat.isDirectory(),
          path: path.relative(UPLOAD_DIR, full).replace(/\\/g, '/')
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    items.sort((a, b) => b.isDir - a.isDir);
    res.json({
      success: true,
      data: items,
      currentPath: req.body.path || ''
    });
  } catch (e) {
    res.json({ success: false, data: [], msg: e.message });
  }
});

app.post('/read', checkAuth, (req, res) => {
  try {
    const target = safePath(req.body.path);
    const content = fs.readFileSync(target, 'utf8');
    res.json({ success: true, content });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

app.post('/save', checkAuth, (req, res) => {
  try {
    const target = safePath(req.body.path);
    fs.writeFileSync(target, req.body.content);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

app.post('/delete', checkAuth, (req, res) => {
  try {
    const target = safePath(req.body.filename);
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
  })
});

app.post('/upload', checkAuth, upload.single('file'), (req, res) => {
  res.json({ success: true, msg: 'Upload berhasil' });
});

const uploadToFolder = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const folder = req.body.folder || '';
      const dest = path.join(UPLOAD_DIR, folder);
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
  })
});

app.post('/upload/folder', checkAuth, uploadToFolder.single('file'), (req, res) => {
  res.json({ success: true, msg: 'Upload ke folder berhasil' });
});

app.post('/unzip', checkAuth, (req, res) => {
  try {
    const target = safePath(req.body.filename);
    const zip = new AdmZip(target);
    const extractPath = path.dirname(target);
    zip.extractAllTo(extractPath, true);
    fs.unlinkSync(target);
    res.json({ success: true, msg: 'Extract completed' });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

app.post('/mkdir', checkAuth, (req, res) => {
  try {
    const folderPath = safePath(req.body.path);
    fs.mkdirSync(folderPath, { recursive: true });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

app.post('/rename', checkAuth, (req, res) => {
  try {
    const oldPath = safePath(req.body.old);
    const newPath = safePath(req.body.new);
    fs.renameSync(oldPath, newPath);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, msg: e.message });
  }
});

app.post('/start', checkAuth, (req, res) => {
  if (isRunning) return res.json({ success: false, msg: 'Bot Sedang Berjalan!' });

  const findEntry = (dir) => {
    try {
      const files = fs.readdirSync(dir);
      if (files.includes('package.json')) {
        try {
          const pkg = require(path.join(dir, 'package.json'));
          if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return path.join(dir, pkg.main);
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
  if (!entry) return res.json({ success: false, msg: 'File Bot Tidak Ditemukan!' });

  const workingDir = path.dirname(entry);
  io.emit('log', `\x1b[36m[SYSTEM] Menyiapkan: ${path.basename(entry)}\x1b[0m\n`);

  if (fs.existsSync(path.join(workingDir, 'package.json')) && !fs.existsSync(path.join(workingDir, 'node_modules'))) {
    io.emit('log', `\x1b[33m[AUTO-INSTALL] Mendeteksi package.json, menjalankan npm install...\x1b[0m\n`);

    const install = spawn('npm', ['install'], { cwd: workingDir, shell: true });

    install.stdout.on('data', d => io.emit('log', d.toString()));
    install.stderr.on('data', d => io.emit('log', `\x1b[33m${d.toString()}\x1b[0m`));

    install.on('close', (code) => {
      if (code === 0) {
        io.emit('log', `\x1b[32m[INSTALL] Sukses. Memulai Bot...\x1b[0m\n`);
        startProcess(entry, workingDir);
      } else {
        io.emit('log', `\x1b[31m[INSTALL FAIL] Gagal. Kode: ${code}. Coba jalankan 'npm install' manual di console.\x1b[0m\n`);
      }
    });
  } else {
    startProcess(entry, workingDir);
  }

  res.json({ success: true, msg: 'Memulai bot...' });
});

function startProcess(file, cwd) {
  if (isRunning) return;
  isRunning = true;
  io.emit('status_update', true);

  currentProcess = spawn('node', [file], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

  currentProcess.stdout.on('data', (data) => io.emit('log', data.toString()));
  currentProcess.stderr.on('data', (data) => io.emit('log', `\x1b[31m${data.toString()}\x1b[0m`));

  currentProcess.on('close', (code) => {
    isRunning = false;
    io.emit('status_update', false);
    io.emit('log', `\n\x1b[31m[STOP] Proses berhenti dengan kode: ${code}\x1b[0m\n`);
    currentProcess = null;
  });
}

app.post('/stop', checkAuth, (req, res) => {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
    isRunning = false;
    io.emit('status_update', false);
    res.json({ success: true, msg: 'Bot Dimatikan.' });
  } else {
    res.json({ success: false, msg: 'Bot sudah mati.' });
  }
});

io.on('connection', (socket) => {
  emitStats(socket);

  socket.on('input', (data) => {
    if (!data || typeof data !== 'string') return;
    const cmd = data.trim();
    if (!cmd) return;

    if (currentProcess && isRunning) {
      try {
        currentProcess.stdin.write(cmd + '\n');
        io.emit('log', `\x1b[30m\x1b[47m > ${cmd} \x1b[0m\n`);
      } catch (e) {
        io.emit('log', `\x1b[31m[ERROR] Gagal mengirim perintah ke bot.\x1b[0m\n`);
      }
    } else {
      io.emit('log', `\x1b[36m$ ${cmd}\x1b[0m\n`);

      if (cmd.includes('rm -rf /') || cmd.startsWith('sudo')) {
        return io.emit('log', `\x1b[31m[DENIED] Perintah tidak diizinkan.\x1b[0m\n`);
      }

      const shell = spawn(cmd, { cwd: UPLOAD_DIR, shell: true });

      let timeout = setTimeout(() => {
        shell.kill();
        io.emit('log', `\x1b[31m[ERROR] Perintah terlalu lama, dihentikan.\x1b[0m\n`);
      }, 30000);

      shell.stdout.on('data', d => {
        io.emit('log', d.toString());
      });

      shell.stderr.on('data', d => {
        io.emit('log', `\x1b[33m${d.toString()}\x1b[0m`);
      });

      shell.on('error', (err) => {
        io.emit('log', `\x1b[31m[SHELL ERR] ${err.message}\x1b[0m\n`);
      });

      shell.on('close', (code) => {
        clearTimeout(timeout);
        io.emit('log', `\x1b[90m[selesai dengan kode ${code}]\x1b[0m\n`);
      });
    }
  });
});

function emitStats(socket = io) {
  const ramUsed = Math.round(process.memoryUsage().rss / 1024 / 1024);
  socket.emit('stats', {
    ram: `${ramUsed} MB`,
    status: isRunning ? 'ONLINE' : 'OFFLINE'
  });
}

setInterval(() => emitStats(), 2000);

server.listen(PORT, () => {
  console.log(`[SERVER] Panel berjalan di port ${PORT}`);
});