const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const TelegramBot = require('node-telegram-bot-api');

const TG_TOKEN = process.env.TG_TOKEN || '8227444423:AAGJcCOkeZ0dVAWzQrbJ9J9auRzCvDHceWc';
const OWNER_ID = process.env.OWNER_ID || '8062935882';
const ADMIN_PASS = process.env.ADMIN_PASS || 'walzexploit';
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'tokens.json');

let activeTokens = {};

function loadTokens() {
    try { if (fs.existsSync(DB_FILE)) activeTokens = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || {}; } 
    catch (e) { activeTokens = {}; }
}

function saveTokens() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(activeTokens, null, 2)); return true; } 
    catch (e) { return false; }
}

function generateHardToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 16; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return `WL-${result}`;
}

loadTokens();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let bot = null;
try {
    bot = new TelegramBot(TG_TOKEN, { polling: true });
    bot.onText(/\/id/, (msg) => bot.sendMessage(msg.chat.id, `🆔 ID: <code>${msg.chat.id}</code>`, { parse_mode: 'HTML' }));
    bot.onText(/\/akses (\d+)/, (msg, match) => {
        const chatId = String(msg.chat.id);
        if (chatId !== String(OWNER_ID)) return;
        const days = parseInt(match[1]);
        if (!days) return;
        const token = generateHardToken();
        const expired = Date.now() + (days * 24 * 60 * 60 * 1000);
        activeTokens[token] = expired;
        saveTokens();
        bot.sendMessage(chatId, `✅ <b>AKSES DIBUAT</b>\n🔑: <code>${token}</code>\n⏳: ${days} Hari\n📅: ${new Date(expired).toLocaleDateString('id-ID')}\n\nLogin di Web Panel sekarang.`, { parse_mode: 'HTML' });
    });
} catch (e) {}

let currentProcess = null;
let isRunning = false;
let startTime = null;
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

app.use(express.static('public'));
app.use(express.json());

const checkAuth = (req, res, next) => {
    let token = String(req.headers['authorization'] || '').trim();
    if (token === ADMIN_PASS) return next();
    if (!token || !activeTokens[token]) return res.status(401).json({ success: false, msg: 'Token Invalid' });
    if (Date.now() > activeTokens[token]) {
        delete activeTokens[token];
        saveTokens();
        return res.status(401).json({ success: false, msg: 'Token Expired' });
    }
    next();
};

function getStats() {
    let uptimeStr = "00:00:00";
    if (startTime) {
        const diff = Math.floor((Date.now() - startTime) / 1000);
        uptimeStr = `\( {String(Math.floor(diff / 3600)).padStart(2, '0')}: \){String(Math.floor((diff % 3600) / 60)).padStart(2, '0')}:${String(diff % 60).padStart(2, '0')}`;
    }
    const ramUsed = Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);
    const cpuLoad = os.loadavg()[0].toFixed(2);
    return { ram: ramUsed.toFixed(0), cpu: cpuLoad, status: isRunning ? 'ONLINE' : 'OFFLINE', uptime: uptimeStr };
}

function broadcastStats() {
    io.emit('stats', getStats());
}

app.post('/api/login', (req, res) => {
    let token = String(req.body.token || '').trim();
    if (token === ADMIN_PASS) return res.json({ success: true });
    if (activeTokens[token] && Date.now() < activeTokens[token]) {
        return res.json({ success: true });
    }
    if (activeTokens[token]) {
        delete activeTokens[token];
        saveTokens();
        return res.json({ success: false, msg: 'Token Expired' });
    }
    res.json({ success: false, msg: 'Token Tidak Ditemukan' });
});

app.post('/api/files', checkAuth, (req, res) => {
    const reqPath = req.body.path || '';
    const target = path.join(uploadDir, reqPath);
    if (!path.resolve(target).startsWith(path.resolve(uploadDir))) return res.json({ success: false, data: [] });
    try {
        const files = fs.readdirSync(target);
        const data = files.map(f => {
            const fp = path.join(target, f);
            try {
                const s = fs.statSync(fp);
                return { name: f, isDir: s.isDirectory(), path: path.relative(uploadDir, fp).replace(/\\/g, '/'), size: s.size };
            } catch { return null; }
        }).filter(Boolean);
        data.sort((a, b) => b.isDir - a.isDir);
        res.json({ success: true, data });
    } catch { res.json({ success: false, data: [] }); }
});

app.post('/api/delete', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.filename);
        if (!path.resolve(target).startsWith(path.resolve(uploadDir))) throw new Error();
        fs.rmSync(target, { recursive: true, force: true });
        res.json({ success: true });
    } catch { res.json({ success: false }); }
});

app.post('/api/read', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.filename);
        if (!path.resolve(target).startsWith(path.resolve(uploadDir))) throw new Error();
        const content = fs.readFileSync(target, 'utf8');
        res.json({ success: true, content });
    } catch { res.json({ success: false }); }
});

app.post('/api/save', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.filename);
        if (!path.resolve(target).startsWith(path.resolve(uploadDir))) throw new Error();
        fs.writeFileSync(target, req.body.content, 'utf8');
        res.json({ success: true });
    } catch { res.json({ success: false }); }
});

const upload = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, uploadDir), filename: (req, file, cb) => cb(null, file.originalname) }) });
app.post('/api/upload', checkAuth, upload.single('file'), (req, res) => res.json({ success: true }));

app.post('/api/unzip', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.filename);
        if (!path.resolve(target).startsWith(path.resolve(uploadDir))) throw new Error();
        new AdmZip(target).extractAllTo(path.dirname(target), true);
        fs.unlinkSync(target);
        res.json({ success: true });
    } catch { res.json({ success: false }); }
});

app.post('/api/start', checkAuth, (req, res) => {
    if (isRunning) return res.json({ success: false, msg: 'Server is already running' });
    const cmd = String(req.body.command || 'npm install && npm start').trim();
    if (!cmd) return res.json({ success: false, msg: 'Invalid command' });
    
    isRunning = true;
    startTime = Date.now();
    broadcastStats();
    
    currentProcess = spawn(cmd, { cwd: uploadDir, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    currentProcess.stdout.on('data', (data) => io.emit('log', data.toString()));
    currentProcess.stderr.on('data', (data) => io.emit('log', `\x1b[31m${data.toString()}\x1b[0m`));
    currentProcess.on('close', (code) => {
        isRunning = false;
        startTime = null;
        currentProcess = null;
        broadcastStats();
        io.emit('log', `\n\x1b[31m[SYSTEM]\x1b[0m Process terminated (Code: ${code})\n`);
    });
    res.json({ success: true });
});

app.post('/api/stop', checkAuth, (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        isRunning = false;
        startTime = null;
        broadcastStats();
        res.json({ success: true });
    } else res.json({ success: false });
});

io.on('connection', (socket) => {
    const emitStats = () => socket.emit('stats', getStats());
    emitStats();
    const interval = setInterval(emitStats, 2000);
    socket.on('disconnect', () => clearInterval(interval));
    socket.on('input', (data) => {
        const cmd = String(data || '').trim();
        if (!cmd) return;
        if (currentProcess && isRunning) {
            try { currentProcess.stdin.write(cmd + '\n'); io.emit('log', `\x1b[32m> ${cmd}\x1b[0m\n`); } catch (e) {}
        } else {
            io.emit('log', `\x1b[32m$ ${cmd}\x1b[0m\n`);
            if (cmd.includes('rm -rf /') || cmd.startsWith('sudo')) return;
            const shell = spawn(cmd, { cwd: uploadDir, shell: true });
            shell.stdout.on('data', d => io.emit('log', d.toString()));
            shell.stderr.on('data', d => io.emit('log', `\x1b[31m${d.toString()}\x1b[0m`));
        }
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT);
