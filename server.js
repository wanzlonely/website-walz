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
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'tokens.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

let activeTokens = {};
let currentProc = null;
let isRunning = false;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

function loadTokens() {
    try {
        if (fs.existsSync(DB_FILE)) {
            activeTokens = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || {};
        }
    } catch {
        activeTokens = {};
    }
}

function saveTokens() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(activeTokens, null, 2));
    } catch {}
}

function generateToken(len = 16) {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let r = '';
    for (let i = 0; i < len; i++) r += c.charAt(Math.floor(Math.random() * c.length));
    return `WL-${r}`;
}

loadTokens();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const bot = new TelegramBot(TG_TOKEN, { polling: true });

bot.on('polling_error', () => {});

bot.onText(/\/id/, (msg) => {
    bot.sendMessage(msg.chat.id, `🆔 ID: <code>${msg.chat.id}</code>`, { parse_mode: 'HTML' });
});

bot.onText(/\/akses (\d+)/, (msg, match) => {
    if (String(msg.chat.id) !== String(OWNER_ID)) return;
    
    const days = parseInt(match[1]);
    const token = generateToken();
    const exp = Date.now() + (days * 24 * 3600 * 1000);
    
    activeTokens[token] = exp;
    saveTokens();

    const date = new Date(exp).toLocaleDateString('id-ID');
    bot.sendMessage(msg.chat.id, 
        `✅ <b>AKSES DIBUAT</b>\n\n🔑: <code>${token}</code>\n⏳: ${days} Hari\n📅: ${date}\n\nLogin di Web Panel sekarang.`,
        { parse_mode: 'HTML' }
    );
});

app.use(express.static('public'));
app.use(express.json());

const auth = (req, res, next) => {
    const token = req.headers['authorization'];
    if (token && activeTokens[token]) {
        if (Date.now() < activeTokens[token]) {
            return next();
        } else {
            delete activeTokens[token];
            saveTokens();
        }
    }
    res.status(401).json({ success: false, msg: 'Sesi Habis / Token Invalid' });
};

app.post('/login', (req, res) => {
    const { token } = req.body;
    const cleanToken = String(token || '').trim();

    if (activeTokens[cleanToken]) {
        if (Date.now() < activeTokens[cleanToken]) {
            res.json({ success: true });
        } else {
            delete activeTokens[cleanToken];
            saveTokens();
            res.json({ success: false, msg: 'Token Expired' });
        }
    } else {
        res.json({ success: false, msg: 'Token Tidak Ditemukan' });
    }
});

app.post('/files/list', auth, (req, res) => {
    try {
        const files = fs.readdirSync(UPLOAD_DIR).map(f => {
            const stat = fs.statSync(path.join(UPLOAD_DIR, f));
            return { name: f, isDir: stat.isDirectory(), size: stat.size };
        });
        files.sort((a, b) => b.isDir - a.isDir);
        res.json({ success: true, data: files });
    } catch {
        res.json({ success: false, data: [] });
    }
});

app.post('/files/read', auth, (req, res) => {
    try {
        const target = path.join(UPLOAD_DIR, req.body.filename);
        if (!target.startsWith(UPLOAD_DIR)) throw new Error();
        const content = fs.readFileSync(target, 'utf8');
        res.json({ success: true, content });
    } catch {
        res.json({ success: false, msg: 'Gagal membaca file' });
    }
});

app.post('/files/save', auth, (req, res) => {
    try {
        const target = path.join(UPLOAD_DIR, req.body.filename);
        if (!target.startsWith(UPLOAD_DIR)) throw new Error();
        fs.writeFileSync(target, req.body.content);
        res.json({ success: true, msg: 'File berhasil disimpan' });
    } catch {
        res.json({ success: false, msg: 'Gagal menyimpan file' });
    }
});

app.post('/files/delete', auth, (req, res) => {
    try {
        const target = path.join(UPLOAD_DIR, req.body.filename);
        if (!target.startsWith(UPLOAD_DIR)) throw new Error();
        fs.rmSync(target, { recursive: true, force: true });
        res.json({ success: true, msg: 'File dihapus' });
    } catch {
        res.json({ success: false, msg: 'Gagal menghapus' });
    }
});

app.post('/files/unzip', auth, (req, res) => {
    try {
        const target = path.join(UPLOAD_DIR, req.body.filename);
        if (!target.startsWith(UPLOAD_DIR)) throw new Error();
        const zip = new AdmZip(target);
        zip.extractAllTo(UPLOAD_DIR, true);
        fs.unlinkSync(target);
        res.json({ success: true, msg: 'Extract Berhasil' });
    } catch {
        res.json({ success: false, msg: 'Gagal Extract File' });
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
    if (isRunning) return res.json({ success: false, msg: 'Bot Sedang Berjalan' });

    let mainFile = 'index.js';
    try {
        if (fs.existsSync(path.join(UPLOAD_DIR, 'package.json'))) {
            const pkg = require(path.join(UPLOAD_DIR, 'package.json'));
            if (pkg.main) mainFile = pkg.main;
        }
    } catch {}

    const target = path.join(UPLOAD_DIR, mainFile);
    if (!fs.existsSync(target)) return res.json({ success: false, msg: `File ${mainFile} tidak ditemukan` });

    isRunning = true;
    io.emit('status', true);
    io.emit('log', `\x1b[36m[SYSTEM] Memulai ${mainFile}...\x1b[0m\n`);

    currentProc = spawn('node', [mainFile], { cwd: UPLOAD_DIR, stdio: ['pipe', 'pipe', 'pipe'] });

    currentProc.stdout.on('data', d => io.emit('log', d.toString()));
    currentProc.stderr.on('data', d => io.emit('log', `\x1b[31m${d.toString()}\x1b[0m`));
    
    currentProc.on('close', c => {
        isRunning = false;
        currentProc = null;
        io.emit('status', false);
        io.emit('log', `\n\x1b[33m[SYSTEM] Proses berhenti (Code: ${c})\x1b[0m\n`);
    });

    res.json({ success: true, msg: 'Bot Dimulai' });
});

app.post('/proc/stop', auth, (req, res) => {
    if (currentProc) {
        currentProc.kill();
        currentProc = null;
        isRunning = false;
        io.emit('status', false);
        res.json({ success: true, msg: 'Bot Dimatikan' });
    } else {
        res.json({ success: false, msg: 'Bot tidak berjalan' });
    }
});

io.on('connection', (socket) => {
    socket.emit('status', isRunning);
    
    socket.on('cmd', (cmd) => {
        if (!cmd) return;
        io.emit('log', `\x1b[30m\x1b[47m $ ${cmd} \x1b[0m\n`);

        if (isRunning && currentProc) {
            try {
                currentProc.stdin.write(cmd + '\n');
            } catch {
                io.emit('log', `\x1b[31m[ERROR] Gagal mengirim input ke bot\x1b[0m\n`);
            }
        } else {
            exec(cmd, { cwd: UPLOAD_DIR }, (error, stdout, stderr) => {
                if (stdout) io.emit('log', stdout);
                if (stderr) io.emit('log', `\x1b[31m${stderr}\x1b[0m`);
            });
        }
    });
});

setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024;
    io.emit('usage', { ram: Math.round(used) });
}, 2000);

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
