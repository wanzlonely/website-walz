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

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let activeTokens = {};

let bot = null;
if (TG_TOKEN !== '8227444423:AAGJcCOkeZ0dVAWzQrbJ9J9auRzCvDHceWc') {
    try {
        bot = new TelegramBot(TG_TOKEN, { polling: true });
        console.log('[SYSTEM] Bot Telegram Berjalan...');

        bot.onText(/\/akses (\d+)/, (msg, match) => {
            const chatId = msg.chat.id;
            if (String(chatId) !== String(OWNER_ID)) return bot.sendMessage(chatId, '❌ Anda bukan Owner.');
            
            const days = parseInt(match[1]);
            const token = Math.random().toString(36).substring(2, 10).toUpperCase();
            const expired = Date.now() + (days * 24 * 60 * 60 * 1000);
            
            activeTokens[token] = expired;
            
            bot.sendMessage(chatId, 
                `✅ **AKSES DIBUAT**\n\n` +
                `🔑 Token: \`${token}\`\n` +
                `Durasi: ${days} Hari\n` +
                `📅 Expired: ${new Date(expired).toLocaleString()}`, 
                { parse_mode: 'Markdown' }
            );
        });

        bot.on('message', (msg) => {
            if (String(msg.chat.id) === String(OWNER_ID) && msg.text === '/start') {
                bot.sendMessage(msg.chat.id, "Halo Owner! Ketik `/akses 30` untuk membuat token login web selama 30 hari.");
            }
        });
        
        bot.on('polling_error', (error) => console.log(`[TG ERROR] ${error.code}`));
    } catch (e) {
        console.log('[SYSTEM] Gagal mengaktifkan bot telegram:', e.message);
    }
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
const upload = multer({ storage: storage });

const checkAuth = (req, res, next) => {
    if (TG_TOKEN === '8227444423:AAGJcCOkeZ0dVAWzQrbJ9J9auRzCvDHceWc') return next();

    const token = req.headers['authorization'];
    
    if (!token || !activeTokens[token]) {
        return res.status(401).json({ success: false, msg: 'Token Invalid / Tidak Ada' });
    }
    
    if (Date.now() > activeTokens[token]) {
        delete activeTokens[token];
        return res.status(401).json({ success: false, msg: 'Token Sudah Kadaluarsa' });
    }
    
    next();
};

app.post('/login', (req, res) => {
    const { token } = req.body;
    
    if (TG_TOKEN === '8227444423:AAGJcCOkeZ0dVAWzQrbJ9J9auRzCvDHceWc' && token === 'dev') {
        return res.json({ success: true, warning: 'Mode Developer (Tanpa Telegram)' });
    }

    if (activeTokens[token] && Date.now() < activeTokens[token]) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/files', checkAuth, (req, res) => {
    const reqPath = req.body.path || '';
    const targetPath = path.join(uploadDir, reqPath);
    
    if (!targetPath.startsWith(uploadDir)) {
        return res.json({ success: false, msg: 'Akses Ditolak', data: [] });
    }

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
            } catch { return null; }
        }).filter(Boolean);

        data.sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1));
        
        res.json({ success: true, data, currentPath: reqPath });
    } catch (e) {
        res.json({ success: false, msg: 'Gagal membaca folder', data: [] });
    }
});

app.post('/read', checkAuth, (req, res) => {
    const target = path.join(uploadDir, req.body.path);
    if (!target.startsWith(uploadDir)) return res.status(403).json({success: false});
    
    try {
        const stats = fs.statSync(target);
        if (stats.size > 1024 * 1024) return res.json({ success: false, msg: 'File terlalu besar untuk diedit' });

        const content = fs.readFileSync(target, 'utf8');
        res.json({ success: true, content });
    } catch {
        res.json({ success: false, msg: 'Gagal membaca file' });
    }
});

app.post('/save', checkAuth, (req, res) => {
    const target = path.join(uploadDir, req.body.path);
    if (!target.startsWith(uploadDir)) return res.status(403).json({success: false});

    try {
        fs.writeFileSync(target, req.body.content);
        res.json({ success: true, msg: 'File berhasil disimpan' });
    } catch {
        res.json({ success: false, msg: 'Gagal menyimpan file' });
    }
});

app.post('/upload', upload.single('file'), (req, res) => {
    res.json({ success: true, msg: 'Upload Berhasil' });
});

app.post('/unzip', checkAuth, (req, res) => {
    try {
        const filePath = path.join(uploadDir, req.body.filename);
        const targetDir = path.dirname(filePath);
        
        const zip = new AdmZip(filePath);
        zip.extractAllTo(targetDir, true);
        
        fs.unlinkSync(filePath);
        
        res.json({ success: true, msg: 'Berhasil Extract & Hapus Zip' });
    } catch (e) {
        res.json({ success: false, msg: 'Gagal Extract: ' + e.message });
    }
});

app.post('/delete', checkAuth, (req, res) => {
    const target = path.join(uploadDir, req.body.filename);
    if (!target.startsWith(uploadDir)) return res.status(403);
    
    fs.rm(target, { recursive: true, force: true }, (err) => {
        if (err) res.json({ success: false, msg: 'Gagal menghapus' });
        else res.json({ success: true, msg: 'Berhasil dihapus' });
    });
});

app.post('/start', checkAuth, (req, res) => {
    if (isRunning) return res.json({ success: false, msg: 'Bot sudah berjalan!' });

    const findEntry = (dir) => {
        try {
            const files = fs.readdirSync(dir);
            if (files.includes('package.json')) {
                try { 
                    const pkg = require(path.join(dir, 'package.json'));
                    if (pkg.main) return path.join(dir, pkg.main);
                } catch {}
            }
            const candidates = ['index.js', 'main.js', 'bot.js', 'app.js', 'server.js'];
            for (const c of candidates) {
                if (files.includes(c)) return path.join(dir, c);
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

    const entryFile = findEntry(uploadDir);
    if (!entryFile) return res.json({ success: false, msg: 'Script Bot Tidak Ditemukan!' });

    const workDir = path.dirname(entryFile);
    io.emit('log', `\x1b[36m[SYSTEM] Entry point: ${path.basename(entryFile)}\x1b[0m\n`);

    if (!fs.existsSync(path.join(workDir, 'node_modules')) && fs.existsSync(path.join(workDir, 'package.json'))) {
        io.emit('log', `\x1b[33m[INSTALL] Menjalankan 'npm install'...\x1b[0m\n`);
        
        exec('npm install', { cwd: workDir }, (error, stdout, stderr) => {
            if (error) {
                io.emit('log', `\x1b[31m[ERROR] Gagal Install: ${stderr}\x1b[0m\n`);
                return;
            }
            io.emit('log', `\x1b[32m[DONE] Installasi selesai.\x1b[0m\n`);
            startBot(entryFile, workDir);
        });
    } else {
        startBot(entryFile, workDir);
    }
    
    res.json({ success: true, msg: 'Memulai Proses...' });
});

function startBot(file, cwd) {
    io.emit('log', `\x1b[32m[START] Meluncurkan bot...\x1b[0m\n`);
    isRunning = true;

    currentProcess = spawn('node', [file], {
        cwd: cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true 
    });

    currentProcess.stdout.on('data', (data) => {
        io.emit('log', data.toString());
    });
    
    currentProcess.stderr.on('data', (data) => {
        io.emit('log', `\x1b[31m${data.toString()}\x1b[0m`);
    });

    currentProcess.on('close', (code) => {
        isRunning = false;
        io.emit('log', `\n\x1b[33m[STOP] Bot berhenti (Exit Code: ${code})\x1b[0m\n`);
        currentProcess = null;
        io.emit('status_update', false);
    });
    
    io.emit('status_update', true);
}

app.post('/stop', checkAuth, (req, res) => {
    if (currentProcess) {
        if (os.platform() === 'win32') {
            exec(`taskkill /pid ${currentProcess.pid} /T /F`);
        } else {
            try { process.kill(-currentProcess.pid); } catch { currentProcess.kill(); }
        }
        
        currentProcess = null;
        isRunning = false;
        io.emit('status_update', false);
        res.json({ success: true, msg: 'Bot Dimatikan.' });
    } else {
        res.json({ success: false, msg: 'Bot tidak sedang berjalan.' });
    }
});

app.post('/restart', checkAuth, (req, res) => {
    res.json({ success: true });
});

io.on('connection', (socket) => {
    socket.emit('stats', { 
        ram: getRamUsage(), 
        status: isRunning ? 'ONLINE' : 'OFFLINE' 
    });

    socket.on('input', (cmd) => {
        if (currentProcess && currentProcess.stdin) {
            currentProcess.stdin.write(cmd + '\n');
            io.emit('log', `\x1b[36m> ${cmd}\x1b[0m\n`);
        } else {
            socket.emit('log', `\x1b[31m[ERROR] Bot belum jalan.\x1b[0m\n`);
        }
    });
});

function getRamUsage() {
    const used = process.memoryUsage().rss / 1024 / 1024;
    return `${Math.round(used)} MB`;
}

setInterval(() => {
    io.emit('stats', {
        ram: getRamUsage(),
        status: isRunning ? 'ONLINE' : 'OFFLINE'
    });
}, 2000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server berjalan di port ${PORT}`);
});