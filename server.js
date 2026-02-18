const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn, exec } = require('node:child_process');
const express = require('express');
const socketIo = require('socket.io');
const multer = require('multer');
const AdmZip = require('adm-zip');
const TelegramBot = require('node-telegram-bot-api');

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const CONFIG = {
    TG_TOKEN: process.env.TG_TOKEN || '',
    OWNER_ID: process.env.OWNER_ID || '',
    PORT: process.env.PORT || 3000,
    DB_FILE: path.join(__dirname, 'database.json'),
    UPLOAD_DIR: path.join(__dirname, 'uploads'),
    MAX_LOG_BUFFER: 200
};

const state = {
    activeTokens: {},
    currentProc: null,
    isRunning: false,
    logBuffer: []
};

if (!fs.existsSync(CONFIG.UPLOAD_DIR)) fs.mkdirSync(CONFIG.UPLOAD_DIR, { recursive: true });

const db = {
    load: () => {
        try {
            if (fs.existsSync(CONFIG.DB_FILE)) state.activeTokens = JSON.parse(fs.readFileSync(CONFIG.DB_FILE, 'utf8'));
        } catch { state.activeTokens = {}; }
    },
    save: () => {
        try { fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify(state.activeTokens, null, 2)); } catch {}
    }
};

const utils = {
    genToken: (len = 32) => {
        const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        return 'NX-' + Array.from({ length: len }, () => c[Math.floor(Math.random() * c.length)]).join('');
    },
    securePath: (p) => {
        const r = path.resolve(CONFIG.UPLOAD_DIR, p);
        if (!r.startsWith(CONFIG.UPLOAD_DIR)) throw new Error("Access Denied");
        return r;
    },
    broadcastLog: (msg) => {
        state.logBuffer.push(msg);
        if (state.logBuffer.length > CONFIG.MAX_LOG_BUFFER) state.logBuffer.shift();
        io.emit('log', msg);
    },
    getStats: () => {
        const cpus = os.cpus();
        const load = os.loadavg();
        const mem = process.memoryUsage();
        const sysMem = os.totalmem() - os.freemem();
        return {
            cpu: cpus.length ? ((load[0] / cpus.length) * 100).toFixed(1) : 0,
            ram: (sysMem / 1024 / 1024).toFixed(0),
            procRam: (mem.rss / 1024 / 1024).toFixed(0),
            uptime: os.uptime()
        };
    }
};

db.load();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });
const bot = new TelegramBot(CONFIG.TG_TOKEN, { polling: true });

app.use(express.static('public'));
app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    next();
});

const requireAuth = (req, res, next) => {
    const t = req.headers['authorization'];
    if (!t || !state.activeTokens[t]) return res.status(401).json({ error: 'Unauthorized' });
    if (Date.now() > state.activeTokens[t]) {
        delete state.activeTokens[t];
        db.save();
        return res.status(401).json({ error: 'Expired' });
    }
    next();
};

bot.on('polling_error', () => {});
bot.onText(/\/id/, (msg) => bot.sendMessage(msg.chat.id, `<code>${msg.chat.id}</code>`, { parse_mode: 'HTML' }));
bot.onText(/\/akses (\d+)/, (msg, match) => {
    if (String(msg.chat.id) !== String(CONFIG.OWNER_ID)) return;
    const days = parseInt(match[1]);
    const token = utils.genToken();
    state.activeTokens[token] = Date.now() + (days * 24 * 3600 * 1000);
    db.save();
    bot.sendMessage(msg.chat.id, `🔑: <code>${token}</code>\n⏳: ${days} Days`, { parse_mode: 'HTML' });
});

app.post('/login', (req, res) => {
    const { token } = req.body;
    if (state.activeTokens[token] && Date.now() < state.activeTokens[token]) res.json({ success: true });
    else res.status(401).json({ success: false });
});

app.post('/files/list', requireAuth, (req, res) => {
    try {
        const i = fs.readdirSync(CONFIG.UPLOAD_DIR, { withFileTypes: true }).map(d => {
            const s = fs.statSync(path.join(CONFIG.UPLOAD_DIR, d.name));
            return { name: d.name, isDir: d.isDirectory(), size: s.size };
        }).sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1));
        res.json({ success: true, data: i });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.post('/files/read', requireAuth, (req, res) => {
    try {
        const t = utils.securePath(req.body.filename);
        if (fs.statSync(t).isDirectory()) throw new Error("Directory");
        res.json({ success: true, content: fs.readFileSync(t, 'utf8') });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.post('/files/save', requireAuth, (req, res) => {
    try {
        fs.writeFileSync(utils.securePath(req.body.filename), req.body.content);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.post('/files/delete', requireAuth, (req, res) => {
    try {
        fs.rmSync(utils.securePath(req.body.filename), { recursive: true, force: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.post('/files/unzip', requireAuth, (req, res) => {
    try {
        const t = utils.securePath(req.body.filename);
        new AdmZip(t).extractAllTo(CONFIG.UPLOAD_DIR, true);
        fs.unlinkSync(t);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: 'Error' }); }
});

const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, f, cb) => cb(null, CONFIG.UPLOAD_DIR),
        filename: (req, f, cb) => cb(null, f.originalname)
    })
});

app.post('/upload', upload.single('file'), (req, res) => res.json({ success: true }));

app.post('/proc/start', requireAuth, (req, res) => {
    if (state.isRunning) return res.json({ success: false, msg: 'Running' });
    
    let cmd = 'node', args = ['index.js'];
    const pkgPath = path.join(CONFIG.UPLOAD_DIR, 'package.json');
    
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath));
            if (pkg.scripts?.start) { cmd = 'npm'; args = ['start']; }
            else if (pkg.main) args = [pkg.main];
        } catch {}
    } else if (!fs.existsSync(path.join(CONFIG.UPLOAD_DIR, 'index.js'))) {
        return res.json({ success: false, msg: 'No Entry File' });
    }

    state.isRunning = true;
    io.emit('status', true);
    utils.broadcastLog(`\x1b[32m[SYSTEM] Starting: ${cmd} ${args.join(' ')}\x1b[0m\n`);

    state.currentProc = spawn(cmd, args, { 
        cwd: CONFIG.UPLOAD_DIR, 
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '1' } 
    });

    state.currentProc.stdout.on('data', d => utils.broadcastLog(d.toString()));
    state.currentProc.stderr.on('data', d => utils.broadcastLog(`\x1b[31m${d.toString()}\x1b[0m`));
    state.currentProc.on('close', c => {
        state.isRunning = false;
        state.currentProc = null;
        io.emit('status', false);
        utils.broadcastLog(`\n\x1b[33m[SYSTEM] Stopped (Code: ${c})\x1b[0m\n`);
    });

    res.json({ success: true });
});

app.post('/proc/stop', requireAuth, (req, res) => {
    if (state.currentProc) {
        state.currentProc.kill('SIGKILL');
        state.currentProc = null;
        state.isRunning = false;
        io.emit('status', false);
        res.json({ success: true });
    } else res.json({ success: false });
});

io.on('connection', (socket) => {
    socket.emit('status', state.isRunning);
    state.logBuffer.forEach(l => socket.emit('log', l));
    socket.on('cmd', (c) => {
        if (!c) return;
        utils.broadcastLog(`\x1b[30m\x1b[47m $ ${c} \x1b[0m\n`);
        if (state.isRunning && state.currentProc) {
            try { state.currentProc.stdin.write(c + '\n'); } catch {}
        } else {
            exec(c, { cwd: CONFIG.UPLOAD_DIR }, (e, out, err) => {
                if (out) utils.broadcastLog(out);
                if (err) utils.broadcastLog(`\x1b[31m${err}\x1b[0m`);
            });
        }
    });
});

setInterval(() => io.emit('usage', utils.getStats()), 2000);

server.listen(CONFIG.PORT, () => console.log(`Server: ${CONFIG.PORT}`));
