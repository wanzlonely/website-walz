const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn, exec } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || "walzexploit";
const UPLOAD_DIR = path.join(__dirname, 'uploads');

let currentProcess = null;
let isRunning = false;

app.use(express.static('public'));
app.use(express.json());
app.use(cors());

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

function getSystemStats() {
    const used = process.memoryUsage().rss / 1024 / 1024;
    const totalMem = os.totalmem() / 1024 / 1024;
    const freeMem = os.freemem() / 1024 / 1024;
    const cpus = os.cpus();
    const cpuLoad = cpus.length > 0 ? cpus[0].speed : 0;
    
    return {
        ram: `${Math.round(used)} MB / ${Math.round(totalMem)} MB`,
        cpu: `${cpuLoad} MHz`,
        uptime: os.uptime(),
        platform: os.platform()
    };
}

setInterval(() => {
    io.emit('stats', {
        ...getSystemStats(),
        status: isRunning ? 'ONLINE' : 'OFFLINE',
        time: new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })
    });
}, 1000);

io.on('connection', (socket) => {
    socket.emit('log', '\x1b[36m[SYSTEM] NEXUS TERMINAL READY.\x1b[0m\n');
    
    socket.on('input', (cmd) => {
        if (!cmd) return;
        if (currentProcess && currentProcess.stdin) {
            try {
                currentProcess.stdin.write(cmd + '\n');
                io.emit('log', `\x1b[33m$ ${cmd}\x1b[0m\n`);
            } catch (e) {
                socket.emit('notify', { type: 'error', msg: 'Stream error.' });
            }
        } else {
            exec(cmd, { cwd: UPLOAD_DIR }, (err, stdout, stderr) => {
                if (err) io.emit('log', `\x1b[31m${stderr}\x1b[0m\n`);
                else io.emit('log', stdout + '\n');
            });
        }
    });
});

app.post('/auth', (req, res) => {
    if (req.body.password === ADMIN_PASS) res.json({ success: true, token: 'NEXUS-V6-AUTH' });
    else res.json({ success: false });
});

app.post('/start', async (req, res) => {
    if (isRunning) return res.json({ success: false, msg: 'Process is already running.' });

    const findEntry = (d) => {
        try {
            const files = fs.readdirSync(d);
            const pkgPath = path.join(d, 'package.json');
            if (fs.existsSync(pkgPath)) {
                try { 
                    const pkg = require(pkgPath);
                    if (pkg.main) return path.join(d, pkg.main);
                } catch {}
            }
            const candidates = ['index.js', 'main.js', 'bot.js', 'server.js', 'app.js'];
            for (const f of candidates) if (files.includes(f)) return path.join(d, f);
            
            for (const f of files) {
                const full = path.join(d, f);
                if (fs.statSync(full).isDirectory() && f !== 'node_modules') {
                    const found = findEntry(full);
                    if (found) return found;
                }
            }
        } catch {}
        return null;
    };

    const entryFile = findEntry(UPLOAD_DIR);
    if (!entryFile) return res.json({ success: false, msg: 'No entry file (index.js/main.js) found.' });

    const workDir = path.dirname(entryFile);
    io.emit('log', `\x1b[32m[BOOT] Starting ${path.basename(entryFile)}...\x1b[0m\n`);
    
    isRunning = true;
    currentProcess = spawn('node', [entryFile], {
        cwd: workDir,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    currentProcess.stdout.on('data', d => io.emit('log', d.toString()));
    currentProcess.stderr.on('data', d => io.emit('log', `\x1b[31m${d}\x1b[0m`));
    
    currentProcess.on('close', (code) => {
        isRunning = false;
        currentProcess = null;
        io.emit('log', `\n\x1b[31m[EXIT] Process stopped (Code: ${code})\x1b[0m\n`);
        io.emit('stats', { status: 'OFFLINE' });
    });

    res.json({ success: true, msg: 'System started.' });
});

app.post('/stop', (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
        isRunning = false;
        io.emit('log', `\x1b[31m[STOP] Terminated by user.\x1b[0m\n`);
        res.json({ success: true, msg: 'Process terminated.' });
    } else {
        res.json({ success: false, msg: 'No process running.' });
    }
});

app.get('/files', (req, res) => {
    try {
        const files = fs.readdirSync(UPLOAD_DIR).filter(f => f !== 'node_modules' && !f.startsWith('.'));
        const data = files.map(f => {
            const stat = fs.statSync(path.join(UPLOAD_DIR, f));
            return {
                name: f,
                isDir: stat.isDirectory(),
                size: stat.size,
                mtime: stat.mtime
            };
        });
        res.json(data);
    } catch { res.json([]); }
});

app.post('/file/read', (req, res) => {
    try {
        const content = fs.readFileSync(path.join(UPLOAD_DIR, req.body.filename), 'utf8');
        res.json({ success: true, content });
    } catch { res.json({ success: false, msg: 'Read failed.' }); }
});

app.post('/file/save', (req, res) => {
    try {
        fs.writeFileSync(path.join(UPLOAD_DIR, req.body.filename), req.body.content);
        res.json({ success: true, msg: 'File saved.' });
    } catch { res.json({ success: false, msg: 'Save failed.' }); }
});

app.post('/file/rename', (req, res) => {
    try {
        fs.renameSync(path.join(UPLOAD_DIR, req.body.oldName), path.join(UPLOAD_DIR, req.body.newName));
        res.json({ success: true, msg: 'Renamed.' });
    } catch { res.json({ success: false, msg: 'Rename failed.' }); }
});

app.post('/upload', upload.single('file'), (req, res) => res.json({ success: true }));

app.post('/unzip', (req, res) => {
    try {
        const filePath = path.join(UPLOAD_DIR, req.body.filename);
        const zip = new AdmZip(filePath);
        zip.extractAllTo(UPLOAD_DIR, true);
        fs.unlinkSync(filePath);
        res.json({ success: true, msg: 'Extracted.' });
    } catch { res.json({ success: false, msg: 'Extraction failed.' }); }
});

app.post('/delete', (req, res) => {
    fs.rm(path.join(UPLOAD_DIR, req.body.filename), { recursive: true, force: true }, () => res.json({ success: true, msg: 'Deleted.' }));
});

server.listen(PORT, '0.0.0.0', () => console.log(`CORE: Port ${PORT}`));
