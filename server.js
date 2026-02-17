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

function getLocalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return '127.0.0.1';
}

setInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    const cpuLoad = os.loadavg()[0];
    const date = new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Jakarta' });
    
    io.emit('stats', {
        ram: `${Math.round(used)} MB`,
        cpu: `${cpuLoad.toFixed(2)}%`,
        ip: getLocalIP(),
        time: date,
        status: isRunning ? 'ONLINE' : 'OFFLINE'
    });
}, 1000);

io.on('connection', (socket) => {
    socket.emit('log', '\x1b[36m[SYSTEM] SERVER CONNECTED.\x1b[0m\n');
    
    socket.on('input', (cmd) => {
        if (currentProcess && currentProcess.stdin) {
            try {
                currentProcess.stdin.write(cmd + '\n');
                io.emit('log', `\x1b[33m> ${cmd}\x1b[0m\n`);
            } catch (e) {
                socket.emit('notify', { type: 'error', msg: 'Gagal mengirim perintah.' });
            }
        } else {
            socket.emit('notify', { type: 'error', msg: 'Bot belum dijalankan.' });
        }
    });
});

app.post('/login', (req, res) => {
    if (req.body.password === ADMIN_PASS) res.json({ success: true });
    else res.json({ success: false });
});

app.post('/start', async (req, res) => {
    if (isRunning) return res.json({ success: false, msg: 'Bot sudah berjalan!' });

    const rootDir = path.join(__dirname, 'uploads');
    let entryFile = null;

    const findEntry = (d) => {
        try {
            const files = fs.readdirSync(d);
            if (files.includes('package.json')) {
                try { 
                    const pkg = require(path.join(d, 'package.json'));
                    if (pkg.main) return path.join(d, pkg.main);
                } catch {}
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

    entryFile = findEntry(rootDir);
    if (!entryFile) return res.json({ success: false, msg: 'File bot tidak ditemukan. Upload ZIP dulu.' });

    const workDir = path.dirname(entryFile);
    
    io.emit('log', `\x1b[32m[SYSTEM] Menyiapkan environment: ${path.basename(workDir)}\x1b[0m\n`);

    if (fs.existsSync(path.join(workDir, 'package.json')) && !fs.existsSync(path.join(workDir, 'node_modules'))) {
        io.emit('log', `\x1b[33m[INSTALL] Menginstall modul... (Mohon tunggu 2-3 menit)\x1b[0m\n`);
        try {
            await new Promise((resolve, reject) => {
                exec('npm install --omit=dev --no-audit --no-fund', { cwd: workDir }, (e) => e ? reject(e) : resolve());
            });
            io.emit('log', `\x1b[32m[DONE] Installasi selesai.\x1b[0m\n`);
        } catch (e) {
            io.emit('log', `\x1b[31m[WARN] Warning saat install (Abaikan).\x1b[0m\n`);
        }
    }

    io.emit('log', `\x1b[32m[START] Menjalankan ${path.basename(entryFile)}...\x1b[0m\n`);
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
        io.emit('log', `\n\x1b[31m[STOP] Bot berhenti (Code: ${code})\x1b[0m\n`);
        currentProcess = null;
    });

    res.json({ success: true, msg: 'Bot berhasil dijalankan.' });
});

app.post('/stop', (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        isRunning = false;
        io.emit('log', `\x1b[31m[STOP] Dimatikan paksa oleh user.\x1b[0m\n`);
        res.json({ success: true, msg: 'Bot dimatikan.' });
    } else {
        res.json({ success: false, msg: 'Bot tidak sedang berjalan.' });
    }
});

app.post('/restart', (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        isRunning = false;
    }
    setTimeout(() => {
        io.emit('log', `\x1b[33m[RESTART] Memulai ulang sistem...\x1b[0m\n`);
    }, 1000);
    res.json({ success: true, msg: 'Restarting...' });
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
        res.json({ success: true, msg: 'Berhasil diekstrak.' });
    } catch { res.json({ success: false, msg: 'Gagal ekstrak.' }); }
});

app.post('/delete', (req, res) => {
    fs.rm(path.join('./uploads', req.body.filename), { recursive: true, force: true }, () => res.json({ success: true, msg: 'File dihapus.' }));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));