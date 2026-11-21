/*
 * efedublaj — sunucu (backend)
 * Express + Socket.io + JSON dosya veritabanı + multer (video yükleme) + ffmpeg (video birleştirme)
 * Tümü ücretsiz. Render'da çalıştırılabilir.
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cors = require('cors');
const session = require('express-session');
const { execSync } = require('child_process');

const app = express();
const server = http.createServer(app);

// Socket.io — Render uyumlu CORS ve credentials
const io = require('socket.io')(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ['*'],
  },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['polling', 'websocket'],
});

app.set('trust proxy', 1); // Render load balancer'ı için

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const RENDERED_DIR = path.join(__dirname, 'rendered');

[DATA_DIR, UPLOAD_DIR, RENDERED_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ---------- Basit JSON veritabanı ----------
const DB_PATH = path.join(DATA_DIR, 'db.json');
let db = { users: [], rooms: [], scenes: [], recordings: [] };

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (e) { console.error('DB load error', e.message); }
}
function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
loadDb();

// Varsayılan sahneler (dublaj.io'dan esinlenen)
if (db.scenes.length === 0) {
  db.scenes = [
    { id: 'firewood', title: 'To get more firewood', duration: 44, chars: 2, video: null },
    { id: 'smooth', title: "Smooth criminals down under", duration: 19, chars: 1, video: null },
    { id: 'suit', title: "Put on the suit — Let's go a few rounds", duration: 70, chars: 2, video: null },
    { id: 'wazzup', title: "Scary Movie — Wazzup! (2000)", duration: 59, chars: 4, video: null },
    { id: 'tralala', title: 'manifest TRALALA', duration: 173, chars: 6, video: null },
    { id: 'stupid', title: 'stupid girl', duration: 63, chars: 4, video: null },
    { id: 'dress', title: 'Dress robes — For what', duration: 38, chars: 4, video: null },
    { id: 'interstellar', title: 'Interstellar — come back', duration: 61, chars: 2, video: null },
  ];
  saveDb();
}

// ---------- Middleware ----------
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'efedublaj-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth yardımcıları ----------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Giriş yapmalısınız' });
  next();
}
function getUser(id) { return db.users.find(u => u.id === id); }

// ---------- Auth rotaları ----------
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Tüm alanları doldurun' });
  if (db.users.find(u => u.email === email)) return res.status(409).json({ error: 'Bu e-posta zaten kayıtlı' });
  const user = {
    id: uuidv4(),
    name,
    email,
    password: await bcrypt.hash(password, 10),
    createdAt: Date.now(),
  };
  db.users.push(user);
  saveDb();
  req.session.userId = user.id;
  req.session.userName = user.name;
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'Kullanıcı bulunamadı' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Hatalı şifre' });
  req.session.userId = user.id;
  req.session.userName = user.name;
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.clearCookie('connect.sid').json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const u = getUser(req.session.userId);
  if (!u) return res.json({ user: null });
  res.json({ user: { id: u.id, name: u.name, email: u.email } });
});

// ---------- Sahne listesi ----------
app.get('/api/scenes', (req, res) => res.json(db.scenes));

// ---------- Video yükleme (multer) ----------
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500 MB

// Sahne video yükleme (sahne sahibi / admin)
app.post('/api/scenes/:id/video', requireAuth, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Video dosyası gerekli' });
  const scene = db.scenes.find(s => s.id === req.params.id);
  if (!scene) return res.status(404).json({ error: 'Sahne bulunamadı' });
  scene.video = {
    filename: req.file.filename,
    originalname: req.file.originalname,
    path: req.file.path,
    url: `/api/rendered/${req.file.filename}`,
    size: req.file.size,
    uploadedAt: Date.now(),
  };
  saveDb();
  res.json({ ok: true, scene });
});

// ---------- Oda işlemleri ----------
function makeCode() {
  let c;
  do { c = Math.random().toString(36).slice(2, 8).toUpperCase(); } while (db.rooms.find(r => r.code === c));
  return c;
}

app.post('/api/rooms', requireAuth, (req, res) => {
  const { name } = req.body || {};
  const code = makeCode();
  const room = {
    id: uuidv4(),
    code,
    name: name || 'Oda',
    owner: req.session.userId,
    sceneId: null,
    users: [{ id: req.session.userId, name: req.session.userName, ready: false, char: null }],
    messages: [],
    createdAt: Date.now(),
  };
  db.rooms.push(room);
  saveDb();
  res.json({ room });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = db.rooms.find(r => r.code === req.params.code);
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı' });
  res.json({ room: { ...room, users: room.users.map(u => ({ id: u.id, name: u.name, ready: u.ready, char: u.char })) } });
});

app.post('/api/rooms/:code/join', requireAuth, (req, res) => {
  const room = db.rooms.find(r => r.code === req.params.code);
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı' });
  if (room.users.find(u => u.id === req.session.userId)) {
    return res.json({ room });
  }
  room.users.push({ id: req.session.userId, name: req.session.userName, ready: false, char: null });
  saveDb();
  io.to(room.code).emit('room-state', room);
  res.json({ room });
});

app.post('/api/rooms/:code/ready', requireAuth, (req, res) => {
  const room = db.rooms.find(r => r.code === req.params.code);
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı' });
  const u = room.users.find(u => u.id === req.session.userId);
  if (u) u.ready = req.body.ready !== false;
  saveDb();
  io.to(room.code).emit('room-state', room);
  res.json({ ok: true });
});

app.post('/api/rooms/:code/scene', requireAuth, (req, res) => {
  const room = db.rooms.find(r => r.code === req.params.code);
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı' });
  if (room.owner !== req.session.userId) return res.status(403).json({ error: 'Sadece sahip sahne seçebilir' });
  room.sceneId = req.body.sceneId;
  saveDb();
  io.to(room.code).emit('room-state', room);
  res.json({ ok: true });
});

app.post('/api/rooms/:code/start', requireAuth, (req, res) => {
  const room = db.rooms.find(r => r.code === req.params.code);
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı' });
  if (room.owner !== req.session.userId) return res.status(403).json({ error: 'Sadece sahip başlatabilir' });
  if (!room.sceneId) return res.status(400).json({ error: 'Önce bir sahne seçin' });
  io.to(room.code).emit('start-game', { sceneId: room.sceneId });
  res.json({ ok: true, sceneId: room.sceneId });
});

app.post('/api/rooms/:code/char', requireAuth, (req, res) => {
  const room = db.rooms.find(r => r.code === req.params.code);
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı' });
  const { char } = req.body || {};
  const u = room.users.find(u => u.id === req.session.userId);
  if (!u) return res.status(404).json({ error: 'Kullanıcı odada değil' });
  // Karakter diğerindeyse al
  for (const other of room.users) {
    if (other.id !== req.session.userId && other.char === char) other.char = null;
  }
  u.char = char || null;
  saveDb();
  io.to(room.code).emit('room-state', room);
  res.json({ ok: true, char: u.char });
});

app.post('/api/upload', requireAuth, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Video dosyası gerekli' });
  const recording = {
    id: uuidv4(),
    userId: req.session.userId,
    userName: req.session.userName,
    filename: req.file.filename,
    originalname: req.file.originalname,
    path: req.file.path,
    size: req.file.size,
    mime: req.file.mimetype,
    roomCode: req.body.roomCode || null,
    sceneId: req.body.sceneId || null,
    status: 'uploaded',
    createdAt: Date.now(),
    mergedUrl: null,
  };
  db.recordings.push(recording);
  saveDb();
  res.json({ recording });
});

app.get('/api/recordings', requireAuth, (req, res) => {
  const mine = db.recordings.filter(r => r.userId === req.session.userId);
  res.json(mine);
});

app.get('/api/recordings/all', requireAuth, (req, res) => {
  res.json(db.recordings);
});

app.get('/api/rendered/:file', (req, res) => {
  const file = path.join(RENDERED_DIR, req.params.file);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Bulunamadı' });
  res.sendFile(file);
});

// Sunucu tarafı video birleştirme (ffmpeg)
app.post('/api/merge', requireAuth, async (req, res) => {
  const { recordingIds, outputName } = req.body || {};
  if (!recordingIds || !Array.isArray(recordingIds) || recordingIds.length < 1) {
    return res.status(400).json({ error: 'En az bir video gerekli' });
  }
  const recs = recordingIds.map(id => db.recordings.find(r => r.id === id)).filter(Boolean);
  if (recs.length === 0) return res.status(400).json({ error: 'Video bulunamadı' });

  const fileList = path.join(UPLOAD_DIR, `list-${uuidv4()}.txt`);
  const inputs = recs.map(r => r.path);
  fs.writeFileSync(fileList, inputs.map(p => `file '${p}'`).join('\n'));

  const outFile = path.join(RENDERED_DIR, `${outputName || 'merged'}-${Date.now()}.mp4`);
  try {
    execSync(`ffmpeg -y -f concat -safe 0 -i "${fileList}" -c:v libx264 -c:a aac -strict experimental -movflags +faststart "${outFile}"`, { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
    fs.unlinkSync(fileList);
    const merged = db.recordings.find(r => r.id === recs[0].id);
    if (merged) {
      merged.status = 'merged';
      merged.mergedUrl = `/api/rendered/${path.basename(outFile)}`;
      saveDb();
    }
    res.json({ ok: true, mergedUrl: `/api/rendered/${path.basename(outFile)}` });
  } catch (err) {
    fs.unlinkSync(fileList);
    res.status(500).json({ error: 'Video birleştirilemedi: ' + err.message });
  }
});

// ---------- Socket.io çok oyunculu ----------
function broadcastRoomState(io, code) {
  const room = db.rooms.find(r => r.code === code);
  if (room) {
    io.to(code).emit('room-state', {
      ...room,
      users: room.users.map(u => ({ id: u.id, name: u.name, ready: u.ready, char: u.char })),
    });
  }
}

io.on('connection', (socket) => {
  console.log('socket bağlandı', socket.id);

  socket.on('join-room', ({ code, name }) => {
    socket.join(code);
    const room = db.rooms.find(r => r.code === code);
    if (room && !room.users.find(u => u.id === socket.id)) {
      room.users.push({ id: socket.id, name, ready: false, char: null });
      saveDb();
    }
    broadcastRoomState(io, code);
    socket.to(code).emit('user-joined', { socketId: socket.id, name });
  });

  socket.on('leave-room', ({ code }) => {
    const room = db.rooms.find(r => r.code === code);
    if (room) {
      room.users = room.users.filter(u => u.id !== socket.id);
      saveDb();
      broadcastRoomState(io, code);
    }
    socket.to(code).emit('user-left', { socketId: socket.id });
    socket.leave(code);
    if (room && room.users.length === 0) {
      db.rooms = db.rooms.filter(r => r.code !== code);
      saveDb();
    }
  });

  socket.on('chat-msg', ({ code, from, text }) => {
    io.to(code).emit('chat-msg', { from, text, at: Date.now() });
  });

  socket.on('start-recording', ({ code }) => {
    socket.to(code).emit('peer-started', { by: socket.id });
  });

  socket.on('stop-recording', ({ code }) => {
    socket.to(code).emit('peer-stopped', { by: socket.id });
  });

  socket.on('disconnect', () => {
    console.log('socket ayrıldı', socket.id);
    for (const room of db.rooms) {
      if (room.users.find(u => u.id === socket.id)) {
        room.users = room.users.filter(u => u.id !== socket.id);
        saveDb();
        broadcastRoomState(io, room.code);
        socket.to(room.code).emit('user-left', { socketId: socket.id });
        if (room.users.length === 0) {
          db.rooms = db.rooms.filter(r => r.code !== room.code);
          saveDb();
        }
        break;
      }
    }
  });
});

// ---------- Health check ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), rooms: db.rooms.length, users: db.users.length });
});

// ---------- SPA fallback ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log(`efedublaj sunucu: http://localhost:${PORT}`));
