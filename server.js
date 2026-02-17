const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn, exec } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || "walzexploit"; 
const MONGO_URI = process.env.MONGO_URI;

let currentProcess = null;
let isRunning = false;

if (MONGO_URI) mongoose.connect(MONGO_URI).catch(() => {});

app.use(express.static('public'));
app.use(express.json());

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, './uploads/'),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

setInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    io.emit('stats', {
        ram: `${Math.round(used)} MB`,
        status: isRunning ? 'ONLINE' : 'OFFLINE'
    });
}, 1000);

io.on('connection', (socket) => {
    socket.emit('log', '\x1b[36m[SYSTEM] NEXUS HYPER-V CONNECTED.\x1b[0m\n');
    
    socket.on('input', (cmd) => {
        if (currentProcess && currentProcess.stdin) {
            currentProcess.stdin.write(cmd + '\n');
            io.emit('log', `\x1b[33m> ${cmd}\x1b[0m\n`);
        } else {
            socket.emit('log', '\x1b[31m[ERROR] Bot is offline. Click START first.\x1b[0m\n');
        }
    });
});

app.post('/login', (req, res) => {
    if (req.body.password === ADMIN_PASS) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/start', async (req, res) => {
    if (isRunning) return res.json({ msg: 'Running' });

    const rootDir = path.join(__dirname, 'uploads');
    
    const findEntry = (d) => {
        try {
            const files = fs.readdirSync(d);
            if (files.includes('package.json')) {
                try { return path.join(d, require(path.join(d, 'package.json')).main); } catch {}
            }
            const candidates = ['index.js', 'main.js', 'bot.js', 'app.js'];
            for (const f of candidates) if (files.includes(f)) return path.join(d, f);
            
            for (const f of files) {
                if (fs.statSync(path.join(d, f)).isDirectory() && f !== 'node_modules') {
                    const found = findEntry(path.join(d, f));
                    if (found) return found;
                }
            }
        } catch {}
        return null;
    };

    const entryFile = findEntry(rootDir);
    
    if (!entryFile) {
        io.emit('log', `\x1b[31m[ERROR] No bot script found! Please upload a ZIP file first.\x1b[0m\n`);
        return res.json({ success: false });
    }

    const workDir = path.dirname(entryFile);
    io.emit('log', `\x1b[32m[SYSTEM] Target: ${path.basename(entryFile)}\x1b[0m\n`);

    if (fs.existsSync(path.join(workDir, 'package.json')) && !fs.existsSync(path.join(workDir, 'node_modules'))) {
        io.emit('log', `\x1b[33m[INSTALL] Installing modules... (This may take 3-5 mins)\x1b[0m\n`);
        try {
            await new Promise((resolve, reject) => {
                exec('npm install --omit=dev --no-audit --no-fund', { cwd: workDir }, (e) => e ? reject(e) : resolve());
            });
            io.emit('log', `\x1b[32m[DONE] Modules installed.\x1b[0m\n`);
        } catch (e) {
            io.emit('log', `\x1b[31m[WARN] Install finished with warnings.\x1b[0m\n`);
        }
    }

    io.emit('log', `\x1b[32m[BOOT] Starting process...\x1b[0m\n`);
    isRunning = true;

    currentProcess = spawn('node', [entryFile], {
        cwd: workDir,
        env: { ...process.env, MONGO_URI },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    currentProcess.stdout.on('data', d => io.emit('log', d.toString()));
    currentProcess.stderr.on('data', d => io.emit('log', `\x1b[31m${d}\x1b[0m`));
    
    currentProcess.on('close', (code) => {
        isRunning = false;
        io.emit('log', `\n\x1b[31m[STOP] Process exited (Code: ${code})\x1b[0m\n`);
        currentProcess = null;
    });

    res.json({ success: true });
});

app.post('/stop', (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        isRunning = false;
        io.emit('log', `\x1b[31m[STOP] Killed by user.\x1b[0m\n`);
    }
    res.json({ success: true });
});

app.post('/restart', (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        isRunning = false;
    }
    setTimeout(() => io.emit('log', `\x1b[33m[RESTART] Rebooting system...\x1b[0m\n`), 1500);
    res.json({ success: true });
});

app.get('/files', (req, res) => {
    try {
        const files = fs.readdirSync('./uploads').filter(f => f !== 'node_modules' && !f.startsWith('.'));
        const data = files.map(f => ({
            name: f,
            isDir: fs.statSync(path.join('./uploads', f)).isDirectory()
        }));
        res.json(data);
    } catch { res.json([]); }
});

app.post('/upload', upload.single('file'), (req, res) => res.json({ success: true }));

app.post('/unzip', (req, res) => {
    try {
        const filePath = path.join('./uploads', req.body.filename);
        const zip = new AdmZip(filePath);
        zip.extractAllTo('./uploads', true);
        fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch { res.json({ success: false }); }
});

app.post('/delete', (req, res) => {
    fs.rm(path.join('./uploads', req.body.filename), { recursive: true, force: true }, () => res.json({ success: true }));
});

server.listen(PORT, '0.0.0.0', () => console.log('Panel Online'));