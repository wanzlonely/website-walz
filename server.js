const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn, exec } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";
const activeBots = {};

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
    io.emit('sys_stats', {
        ram: `${Math.round(used)} MB`,
        total: `${Math.round(total / 1024)} GB`
    });
}, 2000);

io.on('connection', (socket) => {
    socket.emit('log', '\x1b[36m[SYSTEM] VPS Controller Ready.\x1b[0m\n');
    emitStatus();
});

function emitStatus() {
    io.emit('status_update', Object.keys(activeBots));
}

app.post('/login', (req, res) => {
    res.json({ success: req.body.password === ADMIN_PASS });
});

app.post('/start', async (req, res) => {
    const { filename } = req.body;
    let targetPath = path.join(__dirname, 'uploads', filename);

    if (!fs.existsSync(targetPath)) return res.json({ success: false, msg: 'Not Found' });
    if (activeBots[filename]) return res.json({ success: false, msg: 'Running' });

    if (fs.lstatSync(targetPath).isDirectory()) {
        io.emit('log', `\n\x1b[33m[INIT] Preparing environment for ${filename}...\x1b[0m\n`);
        
        if (fs.existsSync(path.join(targetPath, 'package.json'))) {
            if (!fs.existsSync(path.join(targetPath, 'node_modules'))) {
                io.emit('log', `\x1b[36m[INSTALL] Installing dependencies...\x1b[0m\n`);
                try {
                    await new Promise((resolve, reject) => {
                        exec('npm install', { cwd: targetPath }, (e) => e ? reject(e) : resolve());
                    });
                    io.emit('log', `\x1b[32m[DONE] Dependencies installed.\x1b[0m\n`);
                } catch (e) {
                    io.emit('log', `\x1b[31m[FAIL] Install error: ${e}\x1b[0m\n`);
                    return res.json({ success: false, msg: 'Install Failed' });
                }
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
            else return res.json({ success: false, msg: 'No entry file found' });
        }
        targetPath = path.join(targetPath, mainFile);
    }

    io.emit('log', `\x1b[32m[START] Executing ${path.basename(targetPath)}...\x1b[0m\n`);
    
    const child = spawn('node', [targetPath], { cwd: path.dirname(targetPath) });
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
        const zipPath = req.file.path;
        const extractName = req.file.originalname.replace('.zip', '');
        const extractPath = path.join('./uploads', extractName);
        
        try {
            const zip = new AdmZip(zipPath);
            zip.extractAllTo(extractPath, true);
            fs.unlinkSync(zipPath);
            io.emit('log', `\x1b[32m[UNZIP] Extracted to /${extractName}\x1b[0m\n`);
        } catch (e) {
            io.emit('log', `\x1b[31m[ERROR] Corrupt Zip\x1b[0m\n`);
        }
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
    const { filename } = req.body;
    if (activeBots[filename]) return res.json({ success: false, msg: 'Stop first' });
    const p = path.join(__dirname, 'uploads', filename);
    fs.rm(p, { recursive: true, force: true }, (e) => {
        if (!e) io.emit('log', `\n\x1b[31m[DELETED] ${filename}\x1b[0m\n`);
        res.json({ success: !e });
    });
});

app.post('/read', (req, res) => {
    const p = path.join(__dirname, 'uploads', req.body.filename);
    if(fs.existsSync(p) && fs.lstatSync(p).isDirectory()) return res.json({content: "Directory - Cannot Edit"});
    fs.readFile(p, 'utf8', (err, data) => res.json({ content: err ? "" : data }));
});

app.post('/save', (req, res) => {
    fs.writeFile(path.join(__dirname, 'uploads', req.body.filename), req.body.content, (err) => {
        res.json({ success: !err });
    });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server: ${PORT}`));
