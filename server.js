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
    mongoose.connect(MONGO_URI)
        .then(() => console.log("DB_CONNECTED"))
        .catch(e => console.log("DB_FAIL", e));
}

app.use(express.static('public'));
app.use(express.json());

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, './uploads/'),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

setInterval(() => {
    http.get(`http://localhost:${PORT}/ping`);
}, 300000);

setInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    const total = os.totalmem() / 1024 / 1024;
    io.emit('sys_stats', {
        ram: `${Math.round(used)} MB`,
        total: `${Math.round(total / 1024)} GB`
    });
}, 2000);

io.on('connection', (socket) => {
    socket.emit('log', '\x1b[36m[SYSTEM] NEXUS KERNEL READY.\x1b[0m\n');
    if(mongoose.connection.readyState === 1) socket.emit('log', '\x1b[32m[DB] MONGODB CONNECTED.\x1b[0m\n');
    emitStatus();
});

function emitStatus() {
    io.emit('status_update', Object.keys(activeBots));
}

app.get('/ping', (req, res) => {
    res.status(200).send('OK');
});

app.post('/login', (req, res) => {
    res.json({ success: req.body.password === ADMIN_PASS });
});

app.post('/start', async (req, res) => {
    const { filename } = req.body;
    let targetPath = path.join(__dirname, 'uploads', filename);

    if (!fs.existsSync(targetPath)) return res.json({ success: false, msg: '404' });
    if (activeBots[filename]) return res.json({ success: false, msg: 'RUNNING' });

    if (fs.lstatSync(targetPath).isDirectory()) {
        io.emit('log', `\n\x1b[33m[INIT] Environment: ${filename}\x1b[0m\n`);
        
        if (fs.existsSync(path.join(targetPath, 'package.json')) && !fs.existsSync(path.join(targetPath, 'node_modules'))) {
            io.emit('log', `\x1b[36m[INSTALL] Dependencies...\x1b[0m\n`);
            try {
                await new Promise((resolve, reject) => {
                    exec('npm install', { cwd: targetPath }, (e) => e ? reject(e) : resolve());
                });
                io.emit('log', `\x1b[32m[DONE] Installed.\x1b[0m\n`);
            } catch (e) {
                io.emit('log', `\x1b[31m[FAIL] Install Error: ${e}\x1b[0m\n`);
            }
        }

        let mainFile = 'index.js';
        try {
            const pkg = require(path.join(targetPath, 'package.json'));
            if (pkg.main) mainFile = pkg.main;
        } catch (e) {}

        if (!fs.existsSync(path.join(targetPath, mainFile))) {
             const possible = ['index.js', 'main.js', 'run.js', 'bot.js', 'app.js'];
             const found = possible.find(f => fs.existsSync(path.join(targetPath, f)));
             if (found) mainFile = found;
        }
        targetPath = path.join(targetPath, mainFile);
    }

    const botEnv = { ...process.env, MONGO_URI: MONGO_URI };

    io.emit('log', `\x1b[32m[EXEC] ${path.basename(targetPath)}\x1b[0m\n`);
    
    const child = spawn('node', [targetPath], { 
        cwd: path.dirname(targetPath),
        env: botEnv
    });
    
    activeBots[filename] = child;

    child.stdout.on('data', (d) => io.emit('log', d.toString()));
    child.stderr.on('data', (d) => io.emit('log', `\x1b[31m${d}\x1b[0m`));
    child.on('close', (c) => {
        io.emit('log', `\n\x1b[33m[EXIT] Code ${c}\x1b[0m\n`);
        delete activeBots[filename];
        emitStatus();
    });

    emitStatus();
    res.json({ success: true, msg: 'Started' });
});

app.post('/stop', (req, res) => {
    const { filename } = req.body;
    if (activeBots[filename]) {
        activeBots[filename].kill();
        delete activeBots[filename];
        emitStatus();
        res.json({ success: true, msg: 'Stopped' });
    } else {
        res.json({ success: false, msg: 'Not Running' });
    }
});

app.post('/upload', upload.single('scriptFile'), (req, res) => {
    if (!req.file) return res.redirect('/');
    io.emit('log', `\n\x1b[36m[UPLOAD] ${req.file.originalname}\x1b[0m\n`);
    if (req.file.mimetype === 'application/zip' || req.file.originalname.endsWith('.zip')) {
        try {
            const zip = new AdmZip(req.file.path);
            const extractPath = path.join('./uploads', req.file.originalname.replace('.zip', ''));
            zip.extractAllTo(extractPath, true);
            fs.unlinkSync(req.file.path);
            io.emit('log', `\x1b[32m[UNZIP] Success.\x1b[0m\n`);
        } catch (e) { io.emit('log', `\x1b[31m[ERROR] Zip Corrupt\x1b[0m\n`); }
    }
    res.redirect('/');
});

app.get('/files', (req, res) => {
    fs.readdir('./uploads', (err, files) => {
        if (err) return res.json([]);
        res.json(files.filter(f => !f.startsWith('.')));
    });
});

app.post('/delete', (req, res) => {
    const p = path.join(__dirname, 'uploads', req.body.filename);
    fs.rm(p, { recursive: true, force: true }, () => res.json({ success: true }));
});

app.post('/read', (req, res) => {
    const p = path.join(__dirname, 'uploads', req.body.filename);
    if(fs.lstatSync(p).isDirectory()) return res.json({content: "Directory"});
    fs.readFile(p, 'utf8', (err, data) => res.json({ content: err ? "" : data }));
});

app.post('/save', (req, res) => {
    fs.writeFile(path.join(__dirname, 'uploads', req.body.filename), req.body.content, () => res.json({ success: true }));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server: ${PORT}`));
