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
const uploadDir = path.join(__dirname, 'uploads');

function loadTokens() {
    try {
        if (fs.existsSync(DB_FILE)) activeTokens = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || {};
    } catch (e) {
        activeTokens = {};
    }
}

function saveTokens() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(activeTokens, null, 2));
    } catch (e) {}
}

function generateHardToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'WL-';
    for (let i = 0; i < 16; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

loadTokens();
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

let bot = null;
try {
    bot = new TelegramBot(TG_TOKEN, { polling: true });
    
    bot.on('polling_error', (error) => {
        if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
            if (bot) bot.stopPolling().catch(() => {});
        }
    });

    bot.onText(/\/id/, (msg) => {
        bot.sendMessage(msg.chat.id, `🆔 ID: <code>${msg.chat.id}</code>`, { parse_mode: 'HTML' });
    });

    bot.onText(/\/akses (\d+)/, (msg, match) => {
        const chatId = String(msg.chat.id);
        if (chatId !== String(OWNER_ID)) return;
        
        const days = parseInt(match[1]);
        if (!days) return;
        
        const token = generateHardToken();
        const expired = Date.now() + (days * 86400000);
        
        activeTokens[token] = expired;
        saveTokens();
        
        bot.sendMessage(chatId, `✅ <b>AKSES DIBUAT</b>\n🔑: <code>${token}</code>\n⏳: ${days} Hari\n📅: ${new Date(expired).toLocaleDateString('id-ID')}`, { parse_mode: 'HTML' });
    });

    bot.onText(/\/list/, (msg) => {
        const chatId = String(msg.chat.id);
        if (chatId !== String(OWNER_ID)) return;
        
        const tokens = Object.keys(activeTokens);
        if (tokens.length === 0) {
            return bot.sendMessage(chatId, `⚠️ <b>KOSONG</b>\nTidak ada token yang aktif.`, { parse_mode: 'HTML' });
        }
        
        let reply = `✅ <b>DAFTAR TOKEN AKTIF:</b>\n\n`;
        tokens.forEach(t => reply += `<code>${t}</code>\n`);
        bot.sendMessage(chatId, reply, { parse_mode: 'HTML' });
    });
} catch (e) {}

let currentProcess = null;
let isRunning = false;
let startTime = null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const checkAuth = (req, res, next) => {
    const rawToken = String(req.headers.authorization || '');
    const token = rawToken.replace(/[^a-zA-Z0-9-]/g, '');

    if (token === ADMIN_PASS) return next();
    
    if (!token || !activeTokens[token]) return res.status(401).json({ success: false, msg: 'Token Invalid' });
    
    if (Date.now() > activeTokens[token]) {
        delete activeTokens[token];
        saveTokens();
        return res.status(401).json({ success: false, msg: 'Token Expired' });
    }
    
    next();
};

const getStats = () => {
    let uptimeStr = "00:00:00";
    if (startTime) {
        const diff = Math.floor((Date.now() - startTime) / 1000);
        const h = String(Math.floor(diff / 3600)).padStart(2, '0');
        const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
        const s = String(diff % 60).padStart(2, '0');
        uptimeStr = `${h}:${m}:${s}`;
    }
    const ramUsed = Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);
    
    return {
        cpu: os.loadavg()[0].toFixed(2),
        ram: ramUsed.toString(),
        status: isRunning ? 'ONLINE' : 'OFFLINE',
        uptime: uptimeStr
    };
};

const broadcastStats = () => io.emit('stats', getStats());

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => cb(null, file.originalname)
    }),
    limits: { fileSize: 200 * 1024 * 1024 }
});

app.post('/api/login', (req, res) => {
    const rawToken = String(req.body.token || '');
    const token = rawToken.replace(/[^a-zA-Z0-9-]/g, '');

    if (token === ADMIN_PASS) {
        return res.json({ success: true });
    }
    
    if (activeTokens[token]) {
        if (Date.now() > activeTokens[token]) {
            delete activeTokens[token];
            saveTokens();
            return res.json({ success: false, msg: 'Token Expired' });
        }
        return res.json({ success: true });
    }
    
    res.json({ success: false, msg: 'Token Invalid' });
});

app.post('/api/files', checkAuth, (req, res) => {
    let reqPath = String(req.body.path || '').trim();
    if (reqPath.startsWith('/root/home')) reqPath = reqPath.replace('/root/home', '');
    
    const target = path.join(uploadDir, reqPath);
    if (!path.resolve(target).startsWith(path.resolve(uploadDir))) return res.json({ success: false, data: [] });
    
    try {
        if (!fs.existsSync(target)) return res.json({ success: true, data: [] });
        
        const files = fs.readdirSync(target);
        const data = files.map(f => {
            const fp = path.join(target, f);
            const s = fs.statSync(fp);
            return { 
                name: f, 
                isDir: s.isDirectory(), 
                path: path.relative(uploadDir, fp).replace(/\\/g, '/'), 
                size: s.size 
            };
        }).filter(Boolean);
        
        data.sort((a, b) => b.isDir - a.isDir);
        res.json({ success: true, data });
    } catch (e) {
        res.json({ success: false, data: [] });
    }
});

app.post('/api/read', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.filename);
        if (!path.resolve(target).startsWith(path.resolve(uploadDir))) throw new Error();
        const content = fs.readFileSync(target, 'utf8');
        res.json({ success: true, content });
    } catch {
        res.json({ success: false, msg: 'Cannot read file' });
    }
});

app.post('/api/save', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.filename);
        if (!path.resolve(target).startsWith(path.resolve(uploadDir))) throw new Error();
        fs.writeFileSync(target, req.body.content || '');
        res.json({ success: true, msg: 'Saved successfully' });
    } catch {
        res.json({ success: false, msg: 'Save failed' });
    }
});

app.post('/api/delete', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.filename);
        if (!path.resolve(target).startsWith(path.resolve(uploadDir))) throw new Error();
        fs.rmSync(target, { recursive: true, force: true });
        res.json({ success: true, msg: 'File deleted' });
    } catch {
        res.json({ success: false, msg: 'Delete failed' });
    }
});

app.post('/api/upload', checkAuth, upload.single('file'), (req, res) => res.json({ success: true, msg: 'Upload berhasil' }));

app.post('/api/unzip', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.filename);
        if (!path.resolve(target).startsWith(path.resolve(uploadDir))) throw new Error();
        new AdmZip(target).extractAllTo(path.dirname(target), true);
        fs.unlinkSync(target);
        res.json({ success: true, msg: 'Unzip berhasil' });
    } catch {
        res.json({ success: false, msg: 'Unzip gagal' });
    }
});

app.post('/api/start', checkAuth, (req, res) => {
    if (isRunning) return res.json({ success: false, msg: 'Server sudah berjalan' });
    
    const cmd = String(req.body.command || 'npm install && npm start').trim();
    if (!cmd) return res.json({ success: false, msg: 'Command tidak valid' });
    
    isRunning = true;
    startTime = Date.now();
    broadcastStats();
    
    currentProcess = spawn(cmd, { 
        cwd: uploadDir, 
        shell: true,
        detached: true 
    });
    
    currentProcess.stdout.on('data', d => io.emit('log', d.toString()));
    currentProcess.stderr.on('data', d => io.emit('log', `\x1b[31m${d.toString()}\x1b[0m`));
    
    currentProcess.on('close', (code) => {
        isRunning = false;
        startTime = null;
        currentProcess = null;
        broadcastStats();
        io.emit('log', `\n\x1b[31m[SYSTEM] Process terminated (Code: ${code})\x1b[0m\n`);
    });
    
    res.json({ success: true, msg: 'Server started' });
});

app.post('/api/stop', checkAuth, (req, res) => {
    if (currentProcess) {
        try {
            process.kill(-currentProcess.pid);
        } catch (e) {
            try {
                currentProcess.kill();
            } catch (err) {}
        }
        
        currentProcess = null;
        isRunning = false;
        startTime = null;
        broadcastStats();
        res.json({ success: true, msg: 'Server stopped' });
    } else {
        res.json({ success: false, msg: 'Server tidak berjalan' });
    }
});

app.get('/api/expiry', checkAuth, (req, res) => {
    const rawToken = String(req.headers.authorization || '');
    const token = rawToken.replace(/[^a-zA-Z0-9-]/g, '');

    if (token === ADMIN_PASS) {
        return res.json({ success: true, expired: false, remainingSeconds: 30 * 86400, totalSeconds: 30 * 86400 });
    }
    
    const expiredTime = activeTokens[token];
    if (!expiredTime) return res.json({ success: false, msg: 'Token tidak ditemukan' });
    
    const now = Date.now();
    const remaining = Math.max(0, Math.floor((expiredTime - now) / 1000));
    const total = 30 * 86400;
    
    res.json({
        success: true,
        expired: remaining <= 0,
        remainingSeconds: remaining,
        totalSeconds: total
    });
});

io.on('connection', (socket) => {
    socket.emit('stats', getStats());
    const interval = setInterval(() => socket.emit('stats', getStats()), 2000);
    
    socket.on('disconnect', () => clearInterval(interval));
    
    socket.on('input', (data) => {
        const cmd = String(data || '').trim();
        if (!cmd) return;
        
        if (currentProcess && isRunning) {
            currentProcess.stdin.write(cmd + '\n');
            io.emit('log', `\x1b[32m> ${cmd}\x1b[0m\n`);
        } else {
            io.emit('log', `\x1b[32m$ ${cmd}\x1b[0m\n`);
            const shell = spawn(cmd, { cwd: uploadDir, shell: true });
            
            shell.stdout.on('data', d => io.emit('log', d.toString()));
            shell.stderr.on('data', d => io.emit('log', `\x1b[31m${d.toString()}\x1b[0m`));
        }
    });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => {});
