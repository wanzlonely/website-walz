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

const activeBots = {};

if (MONGO_URI) {
    mongoose.connect(MONGO_URI).then(() => console.log("DB_OK")).catch(e => console.log("DB_ERR", e));
}

app.use(express.static('public'));
app.use(express.json());

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, './uploads/'),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

app.get('/ping', (req, res) => res.send('Pong'));
setInterval(() => {
    const usedMem = process.memoryUsage().heapUsed / 1024 / 1024;
    const totalMem = os.totalmem() / 1024 / 1024;
    const uptime = process.uptime();
    
    io.emit('sys_stats', {
        ram: `${Math.round(usedMem)} MB`,
        total_ram: `${Math.round(totalMem/1024)} GB`,
        uptime: new Date(uptime * 1000).toISOString().substr(11, 8),
        cpu: `${os.loadavg()[0].toFixed(1)}%`
    });
}, 1000);

io.on('connection', (socket) => {
    socket.emit('log', '\x1b[36m[SYSTEM] PTERODACTYL-LITE ENGINE READY (NODE 20)\x1b[0m\n');
    emitStatus();

    socket.on('console_input', ({ filename, cmd }) => {
        if (activeBots[filename] && activeBots[filename].stdin) {
            activeBots[filename].stdin.write(cmd + '\n');
            io.emit('log', `\x1b[35m> ${cmd}\x1b[0m\n`);
        } else {
            socket.emit('log', '\r\n\x1b[31m[ERROR] Bot offline / Input closed.\x1b[0m\r\n');
        }
    });
});

function emitStatus() {
    io.emit('status_update', Object.keys(activeBots));
}

function findStartupFile(dir) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
        try {
            const pkg = require(path.join(dir, 'package.json'));
            if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return path.join(dir, pkg.main);
        } catch (e) {}
    }
    const common = ['index.js', 'main.js', 'bot.js', 'run.js'];
    for (const f of common) {
        if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
    }
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const full = path.join(dir, item);
        if (fs.statSync(full).isDirectory() && item !== 'node_modules') {
            const found = findStartupFile(full);
            if (found) return found;
        }
    }
    return null;
}

app.post('/login', (req, res) => res.json({ success: req.body.password === ADMIN_PASS }));

app.post('/start', async (req, res) => {
    const { filename } = req.body;
    let target = path.join(__dirname, 'uploads', filename);

    if (!fs.existsSync(target)) return res.json({ success: false });
    if (activeBots[filename]) return res.json({ success: false });

    let workDir = path.dirname(target);
    if (fs.lstatSync(target).isDirectory()) {
        io.emit('log', `\n\x1b[33m[SEARCH] Looking for startup file in ${filename}...\x1b[0m\n`);
        
        const entry = findStartupFile(target);
        if (!entry) {
            io.emit('log', `\x1b[31m[FAIL] No index.js/package.json found!\x1b[0m\n`);
            return res.json({ success: false });
        }
        
        target = entry;
        workDir = path.dirname(entry);
        
        if (fs.existsSync(path.join(workDir, 'package.json')) && !fs.existsSync(path.join(workDir, 'node_modules'))) {
            io.emit('log', `\x1b[36m[INSTALL] Installing dependencies... Please wait.\x1b[0m\n`);
            try {
                await new Promise((res, rej) => exec('npm install', { cwd: workDir }, (e) => e ? rej(e) : res()));
                io.emit('log', `\x1b[32m[DONE] Dependencies installed.\x1b[0m\n`);
            } catch (e) {
                io.emit('log', `\x1b[31m[ERROR] Install failed: ${e}\x1b[0m\n`);
            }
        }
    }

    io.emit('log', `\x1b[32m[EXEC] Starting ${path.basename(target)} in Node 20...\x1b[0m\n`);
    
    const child = spawn('node', [target], { 
        cwd: workDir,
        env: { ...process.env, MONGO_URI },
        stdio: ['pipe', 'pipe', 'pipe'] 
    });

    activeBots[filename] = child;

    child.stdout.on('data', d => io.emit('log', d.toString()));
    child.stderr.on('data', d => io.emit('log', `\x1b[31m${d}\x1b[0m`));
    child.on('close', c => {
        io.emit('log', `\n\x1b[33m[EXIT] Process ended with code ${c}\x1b[0m\n`);
        delete activeBots[filename];
        emitStatus();
    });

    emitStatus();
    res.json({ success: true });
});

app.post('/stop', (req, res) => {
    const { filename } = req.body;
    if (activeBots[filename]) {
        activeBots[filename].kill();
        delete activeBots[filename];
        emitStatus();
        res.json({ success: true });
    } else res.json({ success: false });
});

app.post('/upload', upload.single('scriptFile'), (req, res) => {
    if (req.file && req.file.mimetype.includes('zip')) {
        try {
            const zip = new AdmZip(req.file.path);
            const out = path.join('./uploads', req.file.originalname.replace('.zip', ''));
            zip.extractAllTo(out, true);
            fs.unlinkSync(req.file.path);
            io.emit('log', `\x1b[32m[UNZIP] Extracted ${req.file.originalname}\x1b[0m\n`);
        } catch (e) {}
    }
    res.redirect('/');
});

app.get('/files', (req, res) => {
    fs.readdir('./uploads', (e, f) => {
        if(e) return res.json([]);
        res.json(f.filter(x => !x.startsWith('.')));
    });
});

app.post('/delete', (req, res) => {
    fs.rm(path.join(__dirname, 'uploads', req.body.filename), {recursive:true, force:true}, ()=>res.json({success:true}));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Panel Port: ${PORT}`));