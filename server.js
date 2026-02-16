const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { spawn } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";
const activeBots = {};

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    socket.emit('log', '\x1b[36m[SYSTEM] Connected to Railway Server.\x1b[0m\n');
    emitStatus();
});

function emitStatus() {
    io.emit('status_update', Object.keys(activeBots));
}

app.post('/login', (req, res) => {
    res.json({ success: req.body.password === ADMIN_PASS });
});

app.post('/start', (req, res) => {
    const { filename } = req.body;
    const scriptPath = path.join(__dirname, 'uploads', filename);

    if (!fs.existsSync(scriptPath)) return res.json({ success: false, msg: 'File not found' });
    if (activeBots[filename]) return res.json({ success: false, msg: 'Already running' });

    io.emit('log', `\n\x1b[32m[STARTING] ${filename}...\x1b[0m\n`);
    
    const child = spawn('node', [scriptPath]);
    activeBots[filename] = child;

    child.stdout.on('data', (d) => io.emit('log', d.toString()));
    child.stderr.on('data', (d) => io.emit('log', `\x1b[31m[ERROR] ${d}\x1b[0m`));
    child.on('close', (c) => {
        io.emit('log', `\n\x1b[33m[STOPPED] ${filename} exited code ${c}\x1b[0m\n`);
        delete activeBots[filename];
        emitStatus();
    });

    emitStatus();
    res.json({ success: true, msg: 'Bot Started' });
});

app.post('/stop', (req, res) => {
    const { filename } = req.body;
    if (activeBots[filename]) {
        activeBots[filename].kill();
        delete activeBots[filename];
        emitStatus();
        res.json({ success: true, msg: 'Bot Stopped' });
    } else {
        res.json({ success: false, msg: 'Not Running' });
    }
});

app.post('/upload', upload.single('scriptFile'), (req, res) => {
    if(req.file) io.emit('log', `\n\x1b[36m[UPLOAD] ${req.file.originalname} success.\x1b[0m\n`);
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
    if (activeBots[filename]) return res.json({ success: false, msg: 'Stop bot first!' });
    
    fs.unlink(path.join(__dirname, 'uploads', filename), (err) => {
        if (!err) io.emit('log', `\n\x1b[31m[DELETED] ${filename}\x1b[0m\n`);
        res.json({ success: !err });
    });
});

app.post('/read', (req, res) => {
    fs.readFile(path.join(__dirname, 'uploads', req.body.filename), 'utf8', (err, data) => {
        if (err) return res.json({ error: true });
        res.json({ content: data });
    });
});

app.post('/save', (req, res) => {
    fs.writeFile(path.join(__dirname, 'uploads', req.body.filename), req.body.content, (err) => {
        if (!err) io.emit('log', `\n\x1b[36m[SAVED] ${req.body.filename} updated.\x1b[0m\n`);
        res.json({ success: !err });
    });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
