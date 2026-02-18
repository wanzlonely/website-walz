const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn, exec } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const TelegramBot = require('node-telegram-bot-api');

const TG_TOKEN = process.env.TG_TOKEN || '8227444423:AAGJcCOkeZ0dVAWzQrbJ9J9auRzCvDHceWc';
const OWNER_ID = process.env.OWNER_ID || '8062935882';
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_LOG_BUFFER = 100;

let activeTokens = {};
let currentProc = null;
let isRunning = false;
let logBuffer = [];

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            activeTokens = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) { console.error("DB Error:", e); activeTokens = {}; }
}

function saveDB() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(activeTokens, null, 2)); } catch (e) { console.error("Save Error:", e); }
}

function generateToken(len = 24) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return 'WL-' + Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

loadDB();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });
const bot = new TelegramBot(TG_TOKEN, { polling: true });

app.use(express.static('public'));
app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    next();
});

const auth = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token || !activeTokens[token]) return res.status(401).json({ success: false, msg: 'Unauthorized' });
    
    if (Date.now() > activeTokens[token]) {
        delete activeTokens[token];
        saveDB();
        return res.status(401).json({ success: false, msg: 'Token Expired' });
    }
    next();
};

const getSystemStats = () => {
    const cpus = os.cpus();
    const load = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    const cpuPercent = cpus.length ? (load[0] / cpus.length) * 100 : 0;

    return {
        cpu: cpuPercent.toFixed(1),
        ram: (usedMem / 1024 / 1024).toFixed(0),
        totalRam: (totalMem / 1024 / 1024).toFixed(0),
        uptime: os.uptime()
    };
};

const broadcastLog = (msg) => {
    logBuffer.push(msg);
    if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
    io.emit('log', msg);
};

bot.on('polling_error', (err) => console.log('TG Polling Error:', err.message));

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `👋 <b>NEXUS SERVER CONTROL</b>\n\nID Anda: <code>${msg.chat.id}</code>\n\nGunakan /akses [hari] untuk membuat token.`, { parse_mode: 'HTML' });
});

bot.onText(/\/akses (\d+)/, (msg, match) => {
    if (String(msg.chat.id) !== String(OWNER_ID)) return;

    const days = parseInt(match[1]);
    const token = generateToken();
    const exp = Date.now() + (days * 24 * 3600 * 1000);

    activeTokens[token] = exp;
    saveDB();

    const date = new Date(exp).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    
    bot.sendMessage(msg.chat.id, 
        `✅ <b>AKSES PANEL DIBUKA</b>\n\n🔑 Token: <code>${token}</code>\n⏳ Durasi: ${days} Hari\n📅 Expired: ${date}\n\n<i>Jaga token ini baik-baik!</i>`,
        { parse_mode: 'HTML' }
    );
});

app.post('/login', (req, res) => {
    const { token } = req.body;
    if (activeTokens[token] && Date.now() < activeTokens[token]) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, msg: 'Invalid or Expired Token' });
    }
});

const securePath = (userPath) => {
    const resolved = path.resolve(UPLOAD_DIR, userPath);
    if (!resolved.startsWith(UPLOAD_DIR)) throw new Error("Access Denied");
    return resolved;
};

app.post('/files/list', auth, (req, res) => {
    try {
        const items = fs.readdirSync(UPLOAD_DIR).map(name => {
            const fullPath = path.join(UPLOAD_DIR, name);
            try {
                const stat = fs.statSync(fullPath);
                return {
                    name,
                    isDir: stat.isDirectory(),
                    size: stat.size,
                    mtime: stat.mtime
                };
            } catch { return null; }
        }).filter(Boolean);

        items.sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1));
        res.json({ success: true, data: items });
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

app.post('/files/read', auth, (req, res) => {
    try {
        const target = securePath(req.body.filename);
        if (fs.statSync(target).isDirectory()) throw new Error("Cannot read directory");
        const content = fs.readFileSync(target, 'utf8');
        res.json({ success: true, content });
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

app.post('/files/save', auth, (req, res) => {
    try {
        const target = securePath(req.body.filename);
        fs.writeFileSync(target, req.body.content);
        res.json({ success: true, msg: 'Saved successfully' });
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

app.post('/files/delete', auth, (req, res) => {
    try {
        const target = securePath(req.body.filename);
        fs.rmSync(target, { recursive: true, force: true });
        res.json({ success: true, msg: 'Deleted successfully' });
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

app.post('/files/rename', auth, (req, res) => {
    try {
        const oldPath = securePath(req.body.oldName);
        const newPath = securePath(req.body.newName);
        fs.renameSync(oldPath, newPath);
        res.json({ success: true, msg: 'Renamed successfully' });
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

app.post('/files/unzip', auth, (req, res) => {
    try {
        const target = securePath(req.body.filename);
        const zip = new AdmZip(target);
        zip.extractAllTo(UPLOAD_DIR, true);
        fs.unlinkSync(target);
        res.json({ success: true, msg: 'Extracted successfully' });
    } catch (e) {
        res.status(500).json({ success: false, msg: 'Failed to extract' });
    }
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

app.post('/upload', upload.single('file'), (req, res) => {
    res.json({ success: true });
});

app.post('/proc/start', auth, (req, res) => {
    if (isRunning) return res.json({ success: false, msg: 'Process is already running' });

    let cmd = 'node';
    let args = ['index.js'];

    if (fs.existsSync(path.join(UPLOAD_DIR, 'package.json'))) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, 'package.json')));
            if (pkg.scripts && pkg.scripts.start) {
                cmd = 'npm';
                args = ['start'];
            } else if (pkg.main) {
                args = [pkg.main];
            }
        } catch {}
    }

    isRunning = true;
    io.emit('status', true);
    broadcastLog(`\x1b[32m[SYSTEM] Starting process with: ${cmd} ${args.join(' ')}\x1b[0m\n`);

    currentProc = spawn(cmd, args, { 
        cwd: UPLOAD_DIR, 
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '1' }
    });

    currentProc.stdout.on('data', d => broadcastLog(d.toString()));
    currentProc.stderr.on('data', d => broadcastLog(`\x1b[31m${d.toString()}\x1b[0m`));

    currentProc.on('close', code => {
        isRunning = false;
        currentProc = null;
        io.emit('status', false);
        broadcastLog(`\n\x1b[33m[SYSTEM] Process exited with code ${code}\x1b[0m\n`);
    });

    res.json({ success: true, msg: 'Started' });
});

app.post('/proc/stop', auth, (req, res) => {
    if (currentProc) {
        currentProc.kill('SIGINT');
        setTimeout(() => {
            if (currentProc) currentProc.kill('SIGKILL');
        }, 2000);
        
        currentProc = null;
        isRunning = false;
        io.emit('status', false);
        res.json({ success: true, msg: 'Stopped' });
    } else {
        res.json({ success: false, msg: 'Not running' });
    }
});

io.on('connection', (socket) => {
    socket.emit('status', isRunning);
    
    logBuffer.forEach(line => socket.emit('log', line));

    socket.on('cmd', (command) => {
        if (!command) return;
        
        broadcastLog(`\x1b[30m\x1b[47m $ ${command} \x1b[0m\n`);

        if (isRunning && currentProc) {
            try {
                currentProc.stdin.write(command + '\n');
            } catch (e) {
                broadcastLog(`\x1b[31m[ERROR] Input stream closed\x1b[0m\n`);
            }
        } else {
            exec(command, { cwd: UPLOAD_DIR }, (err, stdout, stderr) => {
                if (stdout) broadcastLog(stdout);
                if (stderr) broadcastLog(`\x1b[31m${stderr}\x1b[0m`);
            });
        }
    });
});

setInterval(() => {
    const stats = getSystemStats();
    io.emit('usage', stats);
}, 2000);

server.listen(PORT, () => {
    console.log(`
    🚀 NEXUS SERVER V2.0 STARTED
    ----------------------------
    🌐 Port    : ${PORT}
    📂 Root    : ${UPLOAD_DIR}
    🤖 Bot ID  : ${TG_TOKEN.split(':')[0]}
    👑 Owner   : ${OWNER_ID}
    ----------------------------
    `);
});