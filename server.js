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
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";
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
    const total = os.totalmem() / 1024 / 1024;
    io.emit('stats', {
        ram: `${Math.round(used)} MB`,
        total: `${Math.round(total / 1024)} GB`,
        cpu: `${os.loadavg()[0].toFixed(1)}%`,
        status: isRunning ? 'Running' : 'Offline'
    });
}, 1000);

io.on('connection', (socket) => {
    socket.emit('log', '\x1b[36m[SYSTEM] NEXUS CORE READY.\x1b[0m\n');
    
    socket.on('input', (cmd) => {
        if (currentProcess && currentProcess.stdin) {
            currentProcess.stdin.write(cmd + '\n');
            io.emit('log', `\x1b[33m> ${cmd}\x1b[0m\n`);
        } else {
            socket.emit('log', '\x1b[31m[ERROR] Bot is offline.\x1b[0m\n');
        }
    });
});

function findMainFile(dir) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
        try {
            const pkg = require(path.join(dir, 'package.json'));
            if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return path.join(dir, pkg.main);
        } catch (e) {}
    }
    const candidates = ['index.js', 'main.js', 'bot.js', 'run.js', 'app.js'];
    for (const f of candidates) {
        if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
    }
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const full = path.join(dir, item);
        if (fs.statSync(full).isDirectory() && item !== 'node_modules') {
            const found = findMainFile(full);
            if (found) return found;
        }
    }
    return null;
}

app.post('/login', (req, res) => {
    res.json({ success: req.body.password === ADMIN_PASS });
});

app.post('/start', async (req, res) => {
    if (isRunning) return res.json({ msg: 'Already running' });

    const rootDir = path.join(__dirname, 'uploads');
    io.emit('log', `\x1b[33m[INIT] Scanning for bot script...\x1b[0m\n`);

    const entryFile = findMainFile(rootDir);
    if (!entryFile) {
        io.emit('log', `\x1b[31m[FAIL] No bot file found (index.js/package.json). Please UPLOAD ZIP first!\x1b[0m\n`);
        return res.json({ success: false });
    }

    const workDir = path.dirname(entryFile);
    io.emit('log', `\x1b[32m[FOUND] Script: ${path.basename(entryFile)}\x1b[0m\n`);

    if (fs.existsSync(path.join(workDir, 'package.json')) && !fs.existsSync(path.join(workDir, 'node_modules'))) {
        io.emit('log', `\x1b[36m[INSTALL] Installing dependencies (Silent Mode)... Please wait 1-3 mins.\x1b[0m\n`);
        try {
            await new Promise((resolve, reject) => {
                exec('npm install --omit=dev --no-audit --no-fund', { cwd: workDir }, (e) => e ? reject(e) : resolve());
            });
            io.emit('log', `\x1b[32m[DONE] Dependencies installed successfully.\x1b[0m\n`);
        } catch (e) {
            io.emit('log', `\x1b[31m[WARN] Install warning: ${e.message}\x1b[0m\n`);
        }
    }

    io.emit('log', `\x1b[32m[START] Launching ${path.basename(entryFile)}...\x1b[0m\n`);
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
        io.emit('log', `\n\x1b[31m[OFF] Process exited with code ${code}\x1b[0m\n`);
        currentProcess = null;
    });

    res.json({ success: true });
});

app.post('/stop', (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        isRunning = false;
        io.emit('log', `\x1b[31m[STOP] Force kill signal sent.\x1b[0m\n`);
    }
    res.json({ success: true });
});

app.post('/restart', (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        isRunning = false;
    }
    setTimeout(() => {
        io.emit('log', `\x1b[33m[RESTART] System resetting...\x1b[0m\n`);
    }, 1000);
    res.json({ success: true });
});

app.get('/files', (req, res) => {
    const getFiles = (dir) => {
        let results = [];
        try {
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (file === 'node_modules' || file.startsWith('.')) return;
                results.push({
                    name: file,
                    isDir: stat.isDirectory(),
                    size: (stat.size / 1024).toFixed(1) + ' KB'
                });
            });
        } catch(e) {}
        return results;
    };
    res.json(getFiles(path.join(__dirname, 'uploads')));
});

app.post('/upload', upload.single('file'), (req, res) => {
    res.json({ success: true });
});

app.post('/unzip', (req, res) => {
    const target = path.join(__dirname, 'uploads', req.body.filename);
    try {
        const zip = new AdmZip(target);
        zip.extractAllTo(path.join(__dirname, 'uploads'), true);
        fs.unlinkSync(target); 
        io.emit('log', `\x1b[32m[FILE] Extracted ${req.body.filename}\x1b[0m\n`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, msg: e.message });
    }
});

app.post('/delete', (req, res) => {
    const target = path.join(__dirname, 'uploads', req.body.filename);
    fs.rm(target, { recursive: true, force: true }, () => {
        io.emit('log', `\x1b[31m[FILE] Deleted ${req.body.filename}\x1b[0m\n`);
        res.json({ success: true });
    });
});

server.listen(PORT, '0.0.0.0', () => console.log('Panel Ready'));