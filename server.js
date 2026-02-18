const express = require('express');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'cyberpanel2025';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MONGO_URI = process.env.MONGO_URI;

if (MONGO_URI) {
  const mongoose = require('mongoose');
  mongoose.connect(MONGO_URI).catch(() => {});
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000, httpOnly: true, secure: false }
}));

const storageRoot = path.join(__dirname, 'storage');
if (!fs.existsSync(storageRoot)) fs.mkdirSync(storageRoot, { recursive: true });

const authMiddleware = (req, res, next) => {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

const safePath = (userPath) => {
  const normalized = path.normalize(userPath).replace(/^(\.\.(\/|\\|$))+/, '');
  return path.join(storageRoot, normalized);
};

app.post('/login', (req, res) => {
  if (req.body.password === ADMIN_PASS) {
    req.session.admin = true;
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

async function getDiskUsage() {
  try {
    const { stdout } = await execPromise('df -k ' + storageRoot);
    const lines = stdout.trim().split('\n');
    const parts = lines[1].split(/\s+/);
    const total = parseInt(parts[1]) * 1024;
    const used = parseInt(parts[2]) * 1024;
    const free = parseInt(parts[3]) * 1024;
    return { total, used, free };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const ram = process.memoryUsage().heapUsed / 1024 / 1024;
    const cpu = os.loadavg()[0];
    const uptime = os.uptime();
    const disk = await getDiskUsage();
    const network = os.networkInterfaces();
    res.json({
      ram: `${Math.round(ram)} MB`,
      cpu: cpu.toFixed(2),
      uptime,
      diskTotal: disk.total,
      diskFree: disk.free,
      diskUsed: disk.used,
      network: Object.keys(network).map(iface => ({
        interface: iface,
        addresses: network[iface].map(addr => addr.address)
      }))
    });
  } catch {
    res.status(500).json({ error: 'Stats error' });
  }
});

app.get('/api/files', authMiddleware, (req, res) => {
  try {
    const target = safePath(req.query.path || '');
    if (!fs.existsSync(target)) return res.json([]);
    const items = fs.readdirSync(target).map(name => {
      const full = path.join(target, name);
      const stat = fs.statSync(full);
      return {
        name,
        isDirectory: stat.isDirectory(),
        size: stat.size,
        modified: stat.mtimeMs
      };
    });
    res.json(items);
  } catch {
    res.status(500).json({ error: 'List failed' });
  }
});

app.get('/api/file', authMiddleware, (req, res) => {
  try {
    const target = safePath(req.query.path);
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      return res.status(400).json({ error: 'Not a file' });
    }
    const content = fs.readFileSync(target, 'utf-8');
    res.json({ content });
  } catch {
    res.status(500).json({ error: 'Read error' });
  }
});

app.post('/api/file', authMiddleware, (req, res) => {
  try {
    const target = safePath(req.body.path);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      return res.status(400).json({ error: 'Cannot write to directory' });
    }
    fs.writeFileSync(target, req.body.content, 'utf-8');
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Write error' });
  }
});

app.post('/api/mkdir', authMiddleware, (req, res) => {
  try {
    const target = safePath(req.body.path);
    fs.mkdirSync(target, { recursive: true });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Mkdir error' });
  }
});

app.post('/api/delete', authMiddleware, (req, res) => {
  try {
    const target = safePath(req.body.path);
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Delete error' });
  }
});

app.post('/api/rename', authMiddleware, (req, res) => {
  try {
    const oldPath = safePath(req.body.oldPath);
    const newPath = safePath(req.body.newPath);
    fs.renameSync(oldPath, newPath);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Rename error' });
  }
});

const upload = multer({ dest: path.join(storageRoot, '.tmp') });
app.post('/api/upload', authMiddleware, upload.array('files'), (req, res) => {
  try {
    const destDir = safePath(req.body.dest || '');
    req.files.forEach(file => {
      const target = path.join(destDir, file.originalname);
      fs.renameSync(file.path, target);
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Upload error' });
  }
});

app.post('/api/unzip', authMiddleware, (req, res) => {
  try {
    const target = safePath(req.body.path);
    const dest = safePath(req.body.dest || path.dirname(target));
    const zip = new AdmZip(target);
    zip.extractAllTo(dest, true);
    fs.unlinkSync(target);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Unzip error' });
  }
});

let botProcess = null;
let botRunning = false;

app.post('/api/bot/start', authMiddleware, async (req, res) => {
  if (botRunning) return res.json({ success: false, msg: 'Bot already running' });
  const workDir = storageRoot;
  let entry = null;
  const findEntry = (dir) => {
    const files = fs.readdirSync(dir);
    if (files.includes('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
        if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return path.join(dir, pkg.main);
      } catch {}
    }
    const candidates = ['index.js', 'main.js', 'bot.js', 'app.js'];
    for (const f of candidates) if (files.includes(f)) return path.join(dir, f);
    for (const f of files) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory() && f !== 'node_modules') {
        const found = findEntry(full);
        if (found) return found;
      }
    }
    return null;
  };
  entry = findEntry(workDir);
  if (!entry) return res.json({ success: false, msg: 'No entry script found' });
  const scriptDir = path.dirname(entry);
  if (fs.existsSync(path.join(scriptDir, 'package.json')) && !fs.existsSync(path.join(scriptDir, 'node_modules'))) {
    io.emit('bot-log', '\x1b[33m[INSTALL] npm install --omit=dev\x1b[0m\n');
    await new Promise((resolve) => {
      exec('npm install --omit=dev --no-audit --no-fund', { cwd: scriptDir }, () => resolve());
    });
  }
  botProcess = spawn('node', [entry], { cwd: scriptDir, env: { ...process.env, MONGO_URI } });
  botRunning = true;
  botProcess.stdout.on('data', d => io.emit('bot-log', d.toString()));
  botProcess.stderr.on('data', d => io.emit('bot-log', `\x1b[31m${d}\x1b[0m`));
  botProcess.on('close', code => {
    botRunning = false;
    botProcess = null;
    io.emit('bot-log', `\n\x1b[31m[STOPPED] code ${code}\x1b[0m\n`);
  });
  res.json({ success: true, msg: 'Bot started' });
});

app.post('/api/bot/stop', authMiddleware, (req, res) => {
  if (botProcess) {
    botProcess.kill();
    botRunning = false;
    botProcess = null;
    io.emit('bot-log', '\x1b[31m[STOP] killed by user\x1b[0m\n');
    res.json({ success: true, msg: 'Bot stopped' });
  } else {
    res.json({ success: false, msg: 'Bot not running' });
  }
});

app.post('/api/bot/restart', authMiddleware, (req, res) => {
  if (botProcess) {
    botProcess.kill();
    botProcess = null;
    botRunning = false;
  }
  setTimeout(() => {
    io.emit('bot-log', '\x1b[33m[RESTART] restarting...\x1b[0m\n');
  }, 500);
  res.json({ success: true, msg: 'Restart triggered' });
});

app.get('/api/bot/status', authMiddleware, (req, res) => {
  res.json({ running: botRunning });
});

let shellProcess = null;
io.on('connection', (socket) => {
  if (!shellProcess) {
    shellProcess = spawn(process.env.SHELL || 'bash', [], { cwd: storageRoot });
    shellProcess.stdout.on('data', d => io.emit('terminal-output', d.toString()));
    shellProcess.stderr.on('data', d => io.emit('terminal-output', `\x1b[31m${d}\x1b[0m`));
    shellProcess.on('close', () => { shellProcess = null; });
  }
  socket.on('terminal-input', (cmd) => {
    if (shellProcess) shellProcess.stdin.write(cmd + '\n');
  });
  socket.on('bot-input', (cmd) => {
    if (botProcess && botProcess.stdin) {
      botProcess.stdin.write(cmd + '\n');
      io.emit('bot-log', `\x1b[33m> ${cmd}\x1b[0m\n`);
    }
  });
  socket.on('disconnect', () => {});
});

setInterval(() => {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  const cpu = os.loadavg()[0];
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Jakarta' });
  io.emit('system-stats', {
    ram: `${Math.round(used)} MB`,
    cpu: cpu.toFixed(2),
    time,
    bot: botRunning ? 'ONLINE' : 'OFFLINE'
  });
}, 2000);

server.listen(PORT, '0.0.0.0', () => {});