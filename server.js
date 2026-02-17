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
const ADMIN_PASS = 'walz123';
const DB_FILE = path.join(__dirname, 'tokens.json');

function loadTokens() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) { console.log('[DB READ ERR]', e.message); }
    return {};
}

function saveTokens(data) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.log('[DB WRITE ERR]', e.message); }
}

let activeTokens = loadTokens();
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
let bot = null;

try {
    bot = new TelegramBot(TG_TOKEN, { polling: true });
    console.log('[SYSTEM] Bot Telegram Siap.');

    bot.onText(/\/akses (\d+)/, (msg, match) => {
        if (String(msg.chat.id) !== String(OWNER_ID)) return;
        const days = parseInt(match[1]);
        const token = Math.floor(100000 + Math.random() * 900000).toString();
        const expired = Date.now() + (days * 24 * 60 * 60 * 1000);

        activeTokens = loadTokens();
        activeTokens[token] = expired;
        saveTokens(activeTokens);

        console.log(`[TOKEN DIBUAT] ${token} untuk ${days} hari.`);

        bot.sendMessage(msg.chat.id,
            `✅ **AKSES DIBUAT**\n\n🔑 Token: \`${token}\`\n⏳ Durasi: ${days} Hari\n📅 Exp: ${new Date(expired).toLocaleString('id-ID')}\n\n_Jika token gagal, gunakan password admin: ${ADMIN_PASS}_`,
            { parse_mode: 'Markdown' }
        );
    });

} catch (e) { console.log('[TG ERROR]', e.message); }

let currentProcess = null;
let isRunning = false;
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

app.use(express.static('public'));
app.use(express.json());

const upload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, file.originalname)
})});

const checkAuth = (req, res, next) => {
    const token = req.headers['authorization'];
    if (token === ADMIN_PASS) return next();

    activeTokens = loadTokens();
    if (!token || !activeTokens[token]) return res.status(401).json({ success: false, msg: 'Token Salah' });

    if (Date.now() > activeTokens[token]) {
        delete activeTokens[token];
        saveTokens(activeTokens);
        return res.status(401).json({ success: false, msg: 'Token Kadaluarsa' });
    }
    next();
};

app.post('/login', (req, res) => {
    let { token } = req.body;
    token = token ? String(token).trim() : "";
    console.log(`[LOGIN ATTEMPT] Mencoba login dengan: "${token}"`);

    if (token === ADMIN_PASS) {
        console.log('[LOGIN SUCCESS] Menggunakan Admin Pass.');
        return res.json({ success: true, msg: 'Login Admin Berhasil' });
    }

    activeTokens = loadTokens();

    if (activeTokens[token]) {
        if (Date.now() < activeTokens[token]) {
            console.log('[LOGIN SUCCESS] Token Valid.');
            res.json({ success: true });
        } else {
            console.log('[LOGIN FAIL] Token Expired.');
            delete activeTokens[token];
            saveTokens(activeTokens);
            res.json({ success: false, msg: 'Token Kadaluarsa' });
        }
    } else {
        console.log('[LOGIN FAIL] Token Tidak Ditemukan di Database.');
        console.log('List Token Aktif:', Object.keys(activeTokens));
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
                return { name: f, isDir: s.isDirectory(), path: path.relative(uploadDir, fp).replace(/\\/g, '/') };
            } catch { return null; }
        }).filter(Boolean);
        data.sort((a, b) => b.isDir - a.isDir);
        res.json({ success: true, data, currentPath: reqPath });
    } catch { res.json({ success: false, data: [] }); }
});

app.post('/read', checkAuth, (req, res) => {
    try { res.json({ success: true, content: fs.readFileSync(path.join(uploadDir, req.body.path), 'utf8') }); }
    catch { res.json({ success: false }); }
});

app.post('/save', checkAuth, (req, res) => {
    try { fs.writeFileSync(path.join(uploadDir, req.body.path), req.body.content); res.json({ success: true, msg: 'Saved.' }); }
    catch { res.json({ success: false }); }
});

app.post('/upload', upload.single('file'), (req, res) => res.json({ success: true }));

app.post('/unzip', checkAuth, (req, res) => {
    try {
        const fp = path.join(uploadDir, req.body.filename);
        new AdmZip(fp).extractAllTo(path.dirname(fp), true);
        fs.unlinkSync(fp);
        res.json({ success: true, msg: 'Extracted.' });
    } catch { res.json({ success: false, msg: 'Fail.' }); }
});

app.post('/delete', checkAuth, (req, res) => {
    fs.rm(path.join(uploadDir, req.body.filename), { recursive: true, force: true }, () => res.json({ success: true }));
});

app.post('/start', checkAuth, (req, res) => {
    if (isRunning) return res.json({ success: false, msg: 'Running...' });

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
            for (const c of candidates) if (files.includes(c)) return path.join(dir, c);

            for (const f of files) {
                const sub = path.join(dir, f);
                if (fs.statSync(sub).isDirectory() && f !== 'node_modules') {
                    const found = findEntry(sub); if (found) return found;
                }
            }
        } catch {} return null;
    };

    const entry = findEntry(uploadDir);
    if (!entry) return res.json({ success: false, msg: 'Script not found.' });

    const wd = path.dirname(entry);
    const entryBase = path.basename(entry);

    io.emit('log', `\x1b[36m[SYSTEM] Target: ${entryBase}\x1b[0m\n`);

    if (!fs.existsSync(path.join(wd, 'node_modules')) && fs.existsSync(path.join(wd, 'package.json'))) {
        io.emit('log', `\x1b[33m[INSTALL] Installing modules...\x1b[0m\n`);
        exec('npm install', { cwd: wd }, (e) => {
            if(e) io.emit('log', `\x1b[31m[ERR] ${e.message}\x1b[0m\n`);
            startBot(entry, wd);
        });
    } else {
        startBot(entry, wd);
    }
    res.json({ success: true });
});

function startBot(file, cwd) {
    if(isRunning) return;
    io.emit('log', `\x1b[32m[START] Executing...\x1b[0m\n`);
    isRunning = true;

    currentProcess = spawn('node', [file], { cwd, stdio: ['pipe','pipe','pipe'] });

    currentProcess.stdout.on('data', d => io.emit('log', d.toString()));
    currentProcess.stderr.on('data', d => io.emit('log', `\x1b[31m${d}\x1b[0m`));
    currentProcess.on('close', c => {
        isRunning = false;
        io.emit('log', `\n\x1b[31m[STOP] Exit Code: ${c}\x1b[0m\n`);
        io.emit('status_update', false);
    });
    io.emit('status_update', true);
}

app.post('/stop', checkAuth, (req, res) => {
    if(currentProcess) {
        currentProcess.kill();
        currentProcess = null; isRunning = false;
        io.emit('status_update', false);
        res.json({ success: true, msg: 'Stopped' });
    } else res.json({ success: false, msg: 'Offline' });
});

io.on('connection', s => {
    s.emit('stats', { ram: getRam(), status: isRunning ? 'ONLINE' : 'OFFLINE' });
    s.on('input', c => { if(currentProcess) currentProcess.stdin.write(c+'\n'); });
});

function getRam() { return `${Math.round(process.memoryUsage().rss/1024/1024)} MB`; }
setInterval(() => io.emit('stats', { ram: getRam(), status: isRunning ? 'ONLINE' : 'OFFLINE' }), 2000);

server.listen(PORT, () => console.log('Ready.'));