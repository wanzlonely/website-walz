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

const DB_FILE = path.join(__dirname, 'tokens.json');

function loadTokens() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE));
        }
    } catch (e) {
        console.log('Error load DB:', e);
    }
    return {};
}

function saveTokens(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.log('Error save DB:', e);
    }
}

let activeTokens = loadTokens();
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
let bot = null;

try {
    bot = new TelegramBot(TG_TOKEN, { polling: true });
    console.log('[SYSTEM] Bot Telegram Berjalan...');

    bot.onText(/\/akses (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        if (String(chatId) !== String(OWNER_ID)) return bot.sendMessage(chatId, '❌ Anda bukan Owner.');

        const days = parseInt(match[1]);
        const token = Math.floor(10000000 + Math.random() * 90000000).toString();
        const expired = Date.now() + (days * 24 * 60 * 60 * 1000);

        activeTokens[token] = expired;
        saveTokens(activeTokens);

        bot.sendMessage(chatId,
            `✅ **AKSES DIBUAT**\n\n` +
            `🔑 Token: \`${token}\`\n` +
            `⏳ Durasi: ${days} Hari\n` +
            `📅 Expired: ${new Date(expired).toLocaleString('id-ID')}`,
            { parse_mode: 'Markdown' }
        );
    });

    bot.on('message', (msg) => {
        if (String(msg.chat.id) === String(OWNER_ID) && msg.text === '/start') {
            bot.sendMessage(msg.chat.id, "Halo Owner! Ketik `/akses 30` untuk membuat token login web.");
        }
    });

    bot.on('polling_error', () => {});
} catch (e) {
    console.log('[SYSTEM] Gagal bot:', e.message);
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
    const token = req.headers['authorization'];
    activeTokens = loadTokens();

    if (!token || !activeTokens[token]) {
        return res.status(401).json({ success: false, msg: 'Token Salah / Tidak Ditemukan' });
    }

    if (Date.now() > activeTokens[token]) {
        delete activeTokens[token];
        saveTokens(activeTokens);
        return res.status(401).json({ success: false, msg: 'Token Sudah Kadaluarsa' });
    }

    next();
};

app.post('/login', (req, res) => {
    let { token } = req.body;
    token = token.trim();
    activeTokens = loadTokens();

    if (activeTokens[token] && Date.now() < activeTokens[token]) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/files', checkAuth, (req, res) => {
    const reqPath = req.body.path || '';
    const targetPath = path.join(uploadDir, reqPath);
    if (!targetPath.startsWith(uploadDir)) return res.json({ success: false, data: [] });

    try {
        const files = fs.readdirSync(targetPath);
        const data = files.map(f => {
            const fullPath = path.join(targetPath, f);
            try {
                const stats = fs.statSync(fullPath);
                return {
                    name: f,
                    isDir: stats.isDirectory(),
                    path: path.relative(uploadDir, fullPath).split(path.sep).join('/')
                };
            } catch {
                return null;
            }
        }).filter(Boolean);
        data.sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1));
        res.json({ success: true, data, currentPath: reqPath });
    } catch {
        res.json({ success: false, data: [] });
    }
});

app.post('/read', checkAuth, (req, res) => {
    const target = path.join(uploadDir, req.body.path);
    if (!target.startsWith(uploadDir)) return res.status(403);
    try {
        const content = fs.readFileSync(target, 'utf8');
        res.json({ success: true, content });
    } catch {
        res.json({ success: false });
    }
});

app.post('/save', checkAuth, (req, res) => {
    const target = path.join(uploadDir, req.body.path);
    if (!target.startsWith(uploadDir)) return res.status(403);
    try {
        fs.writeFileSync(target, req.body.content);
        res.json({ success: true, msg: 'Disimpan.' });
    } catch {
        res.json({ success: false });
    }
});

app.post('/upload', upload.single('file'), (req, res) => res.json({ success: true }));

app.post('/unzip', checkAuth, (req, res) => {
    try {
        const filePath = path.join(uploadDir, req.body.filename);
        const zip = new AdmZip(filePath);
        zip.extractAllTo(path.dirname(filePath), true);
        fs.unlinkSync(filePath);
        res.json({ success: true, msg: 'Extracted.' });
    } catch {
        res.json({ success: false, msg: 'Gagal.' });
    }
});

app.post('/delete', checkAuth, (req, res) => {
    const target = path.join(uploadDir, req.body.filename);
    if (!target.startsWith(uploadDir)) return res.status(403);
    fs.rm(target, { recursive: true, force: true }, () => res.json({ success: true }));
});

app.post('/start', checkAuth, (req, res) => {
    if (isRunning) return res.json({ success: false, msg: 'Sudah jalan!' });

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
            for (const f of candidates) {
                if (files.includes(f)) return path.join(dir, f);
            }
            for (const f of files) {
                const full = path.join(dir, f);
                if (fs.statSync(full).isDirectory() && f !== 'node_modules') {
                    const found = findEntry(full);
                    if (found) return found;
                }
            }
        } catch {}
        return null;
    };

    const entry = findEntry(uploadDir);
    if (!entry) return res.json({ success: false, msg: 'File bot tidak ketemu.' });

    const wd = path.dirname(entry);
    if (!fs.existsSync(path.join(wd, 'node_modules')) && fs.existsSync(path.join(wd, 'package.json'))) {
        io.emit('log', '\x1b[33m[INSTALL] Menginstall node_modules...\x1b[0m\n');
        exec('npm install', { cwd: wd }, () => startProcess(entry, wd));
    } else {
        startProcess(entry, wd);
    }
    res.json({ success: true, msg: 'Starting...' });
});

function startProcess(entry, cwd) {
    io.emit('log', `\x1b[32m[START] ${path.basename(entry)}\x1b[0m\n`);
    isRunning = true;
    currentProcess = spawn('node', [entry], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: true });

    currentProcess.stdout.on('data', d => io.emit('log', d.toString()));
    currentProcess.stderr.on('data', d => io.emit('log', `\x1b[31m${d}\x1b[0m`));
    currentProcess.on('close', c => {
        isRunning = false;
        io.emit('log', `\n\x1b[31m[STOP] Code: ${c}\x1b[0m\n`);
        io.emit('status_update', false);
    });
    io.emit('status_update', true);
}

app.post('/stop', checkAuth, (req, res) => {
    if (currentProcess) {
        if (os.platform() === 'win32') exec(`taskkill /pid ${currentProcess.pid} /T /F`);
        else try { process.kill(-currentProcess.pid); } catch { currentProcess.kill(); }
        currentProcess = null;
        isRunning = false;
        io.emit('status_update', false);
        res.json({ success: true, msg: 'Stopped.' });
    } else {
        res.json({ success: false, msg: 'Not running.' });
    }
});

app.post('/restart', checkAuth, (req, res) => res.json({ success: true }));

io.on('connection', s => {
    s.emit('stats', { ram: getRam(), status: isRunning ? 'ONLINE' : 'OFFLINE' });
    s.on('input', c => {
        if (currentProcess) {
            currentProcess.stdin.write(c + '\n');
            io.emit('log', `> ${c}\n`);
        }
    });
});

function getRam() {
    return `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`;
}

setInterval(() => io.emit('stats', { ram: getRam(), status: isRunning ? 'ONLINE' : 'OFFLINE' }), 2000);

server.listen(PORT, () => console.log('Server Ready.'));