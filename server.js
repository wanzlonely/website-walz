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
const ADMIN_PASS = process.env.ADMIN_PASS || 'walzy2009';
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'tokens.json');

function loadTokens() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || {};
        }
    } catch (e) {
        console.error('[DB LOAD ERR]', e.message);
    }
    return {};
}

function saveTokens(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
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

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
let activeTokens = loadTokens();
let bot = null;

try {
    bot = new TelegramBot(TG_TOKEN, { polling: true });
    console.log(`[SYSTEM] Bot Telegram Started. Menunggu perintah dari ID: ${OWNER_ID}`);

    bot.onText(/\/id/, (msg) => {
        bot.sendMessage(msg.chat.id, `🆔 ID Telegram Anda: <code>${msg.chat.id}</code>`, { parse_mode: 'HTML' });
    });

    bot.onText(/\/akses (\d+)/, (msg, match) => {
        const chatId = String(msg.chat.id);

        if (chatId !== String(OWNER_ID)) {
            console.log(`[UNAUTHORIZED] Akses ditolak dari ID: ${chatId}`);
            return bot.sendMessage(chatId, '⛔ <b>Akses Ditolak.</b> Anda bukan pemilik server ini.', { parse_mode: 'HTML' });
        }

        const days = parseInt(match[1]);
        if (!days) return bot.sendMessage(chatId, '⚠ Format salah. Gunakan: `/akses 30` (untuk 30 hari)');

        const token = generateHardToken(16);
        const expired = Date.now() + (days * 24 * 60 * 60 * 1000);

        activeTokens = loadTokens();
        activeTokens[token] = expired;

        if (saveTokens(activeTokens)) {
            const dateStr = new Date(expired).toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

            bot.sendMessage(chatId,
                `✅ <b>AKSES DIBUAT SUKSES</b>\n\n` +
                `🔑 Token: <code>${token}</code>\n` +
                `⏳ Durasi: ${days} Hari\n` +
                `📅 Expired: ${dateStr}\n\n` +
                `<i>Silakan login di web panel sekarang.</i>`,
                { parse_mode: 'HTML' }
            );
            console.log(`[TOKEN CREATED] Token baru dibuat untuk ${days} hari.`);
        } else {
            bot.sendMessage(chatId, '❌ Gagal menyimpan ke database server.');
        }
    });

    bot.on('polling_error', (error) => {
        if (error.code !== 'EFATAL') {
            console.log(`[TG POLLING] Koneksi berkedip... (Auto Reconnect)`);
        } else {
            console.log(`[TG ERR] ${error.code}`);
        }
    });

} catch (e) {
    console.log('[TG INIT ERR] Bot Telegram Gagal Dimulai (Cek Token di Variabel).', e.message);
}

let currentProcess = null;
let isRunning = false;
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

app.use(express.static('public'));
app.use(express.json());

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

const checkAuth = (req, res, next) => {
    let token = req.headers['authorization'];
    token = token ? String(token).trim() : '';

    if (token === ADMIN_PASS) return next();

    activeTokens = loadTokens();
    if (!token || !activeTokens[token]) {
        return res.status(401).json({ success: false, msg: 'Token Invalid' });
    }

    if (Date.now() > activeTokens[token]) {
        delete activeTokens[token];
        saveTokens(activeTokens);
        return res.status(401).json({ success: false, msg: 'Token Expired' });
    }

    next();
};

app.post('/login', (req, res) => {
    let { token } = req.body;
    token = String(token || '').trim();

    console.log(`[LOGIN ATTEMPT] Token: ${token}`);

    if (token === ADMIN_PASS) {
        return res.json({ success: true, msg: 'Welcome Admin' });
    }

    activeTokens = loadTokens();
    if (activeTokens[token]) {
        if (Date.now() < activeTokens[token]) {
            res.json({ success: true, msg: 'Akses Diterima' });
        } else {
            delete activeTokens[token];
            saveTokens(activeTokens);
            res.json({ success: false, msg: 'Token Sudah Expired' });
        }
    } else {
        res.json({ success: false, msg: 'Token Tidak Ditemukan' });
    }
});

app.post('/files', checkAuth, (req, res) => {
    const reqPath = req.body.path || '';
    const target = path.join(uploadDir, reqPath);

    if (!target.startsWith(uploadDir)) return res.json({ success: false, data: [] });

    try {
        const files = fs.readdirSync(target);
        const data = files.map(f => {
            const fp = path.join(target, f);
            try {
                const s = fs.statSync(fp);
                return {
                    name: f,
                    isDir: s.isDirectory(),
                    path: path.relative(uploadDir, fp).replace(/\\/g, '/')
                };
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
        const target = path.join(uploadDir, req.body.path);
        const content = fs.readFileSync(target, 'utf8');
        res.json({ success: true, content });
    } catch {
        res.json({ success: false, msg: 'Gagal membaca file' });
    }
});

app.post('/save', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.path);
        fs.writeFileSync(target, req.body.content);
        res.json({ success: true, msg: 'File Berhasil Disimpan' });
    } catch {
        res.json({ success: false, msg: 'Gagal menyimpan' });
    }
});

app.post('/delete', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.filename);
        fs.rmSync(target, { recursive: true, force: true });
        res.json({ success: true, msg: 'Terhapus' });
    } catch {
        res.json({ success: false, msg: 'Gagal hapus' });
    }
});

app.post('/upload', upload.single('file'), (req, res) => {
    res.json({ success: true, msg: 'Upload Sukses' });
});

app.post('/unzip', checkAuth, (req, res) => {
    try {
        const target = path.join(uploadDir, req.body.filename);
        const zip = new AdmZip(target);
        zip.extractAllTo(path.dirname(target), true);
        fs.unlinkSync(target);
        res.json({ success: true, msg: 'Extract Berhasil' });
    } catch (e) {
        res.json({ success: false, msg: 'Gagal Extract: ' + e.message });
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
            const candidates = ['index.js', 'main.js', 'bot.js', 'app.js', 'server.js'];
            for (const c of candidates) {
                if (files.includes(c)) return path.join(dir, c);
            }
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

    const entry = findEntry(uploadDir);
    if (!entry) return res.json({ success: false, msg: 'File Bot Tidak Ditemukan (Upload dulu!)' });

    const workingDir = path.dirname(entry);
    io.emit('log', `\x1b[36m[SYSTEM] Menjalankan: ${path.basename(entry)}\x1b[0m\n`);

    if (!fs.existsSync(path.join(workingDir, 'node_modules')) && fs.existsSync(path.join(workingDir, 'package.json'))) {
        io.emit('log', `\x1b[33m[INSTALL] Mendeteksi package.json, menginstall modul...\x1b[0m\n`);
        exec('npm install', { cwd: workingDir }, (err) => {
            if (err) io.emit('log', `\x1b[31m[NPM ERR] ${err.message}\x1b[0m\n`);
            startProcess(entry, workingDir);
        });
    } else {
        startProcess(entry, workingDir);
    }

    res.json({ success: true });
});

function startProcess(file, cwd) {
    if (isRunning) return;

    isRunning = true;
    io.emit('status_update', true);
    io.emit('log', `\x1b[32m[START] Proses dimulai...\x1b[0m\n`);

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
        res.json({ success: true, msg: 'Bot Dimatikan paksa.' });
    } else {
        res.json({ success: false, msg: 'Bot sudah mati.' });
    }
});

io.on('connection', (socket) => {
    socket.emit('stats', {
        ram: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
        status: isRunning ? 'ONLINE' : 'OFFLINE'
    });

    socket.on('input', (data) => {
        if (currentProcess) currentProcess.stdin.write(data + '\n');
    });
});

setInterval(() => {
    io.emit('stats', {
        ram: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
        status: isRunning ? 'ONLINE' : 'OFFLINE'
    });
}, 2000);

server.listen(PORT, () => {
    console.log(`[SERVER] Panel berjalan di port ${PORT}`);
});