require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cookie = require('cookie');
const cookieParser = require('cookie-parser');
const { nanoid } = require('nanoid');
const fetch = require('node-fetch');
const webpush = require('web-push');
const http = require('http');
const { Server } = require('socket.io');

const db = require('./db');

const app = express();
app.set('trust proxy', true); // 部署在Nginx/宝塔反代后面，这样req.ip才是访客真实IP而不是127.0.0.1
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 64 * 1024,
  perMessageDeflate: false
});

const PORT = process.env.PORT || 4000;
const ADMIN_PATH = (process.env.ADMIN_PATH || 'admin').replace(/^\/|\/$/g, '');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  // VAPID的subject必须是合法的 mailto: 或 https:// 开头的URL，格式不对的话，
  // 苹果的推送服务器有可能直接拒收或者不稳定——这里做个兜底，万一PUBLIC_URL没带协议头也能自动补上
  let vapidSubject = PUBLIC_URL || 'mailto:admin@example.com';
  if (vapidSubject && !vapidSubject.startsWith('mailto:') && !vapidSubject.startsWith('https://') && !vapidSubject.startsWith('http://')) {
    vapidSubject = 'https://' + vapidSubject;
  }
  webpush.setVapidDetails(
    vapidSubject,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  console.warn('⚠️  未配置 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY，Web Push 原生推送不会生效（Bark推送不受影响）。');
}

if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.warn('⚠️  未在 .env 中配置 ADMIN_USERNAME / ADMIN_PASSWORD，管理后台登录将始终失败，请先配置。');
}

// 未捕获异常后继续运行可能留下损坏状态。记录日志后让 PM2 拉起全新进程，
// SQLite/WAL 会保留已经提交的数据；正常停止则先关闭监听和数据库。
let shuttingDown = false;
function gracefulShutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(exitCode), 5000);
  forceExit.unref();
  server.close(() => {
    try { db.close(); } catch (e) {}
    process.exit(exitCode);
  });
}
process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获的异常，正在安全重启:', err);
  gracefulShutdown(1);
});
process.on('unhandledRejection', (err) => {
  console.error('❌ 未处理的 Promise 错误，正在安全重启:', err);
  gracefulShutdown(1);
});
process.on('SIGTERM', () => gracefulShutdown(0));
process.on('SIGINT', () => gracefulShutdown(0));

// widget 需要被不同域名的网站引用，但我们不允许跨站请求携带后台 Cookie。
// 原生 App/管理后台使用 Authorization，访客上传使用独立 visitor secret。
app.use(cors({
  origin: true,
  credentials: false,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Visitor-Id', 'X-Visitor-Secret']
}));
app.use(express.json({ limit: '128kb' }));
app.use(cookieParser());
// widget是嵌到别的网站里的单文件脚本，修复身份/安全问题后必须尽快让所有访客拿到
// 新版本，不能被浏览器或中间CDN长期缓存旧逻辑。
app.get('/widget.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'widget.js'));
});

// ---------- 登录鉴权（session 持久化存数据库，服务重启不掉登录态） ----------
const SESSION_TTL = 1000 * 60 * 60 * 24 * 180; // 180天，且每次使用会自动续期

// 启动时清一下过期的旧session
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

function createSession() {
  const token = nanoid(40);
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(token, Date.now() + SESSION_TTL);
  return token;
}
function isValidSession(token) {
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (Date.now() > row.expires_at) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return false;
  }
  // 续期：只要还在正常使用，就不断往后延长有效期，正常情况下不会主动掉登录
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() + SESSION_TTL, token);
  return true;
}
function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
function getTokenFromReq(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return req.cookies.ms_session || '';
}
const loginAttempts = new Map(); // ip -> { count, lockedUntil }
const uploadAttempts = new Map(); // ip -> [timestamp, ...]

// 定期清理这两个内存Map里的过期记录，服务长期运行也不会占用越来越多内存
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) {
    if (rec.lockedUntil < now && rec.count === 0) loginAttempts.delete(ip);
  }
  for (const [ip, timestamps] of uploadAttempts) {
    const recent = timestamps.filter((t) => now - t < 5 * 60 * 1000);
    if (recent.length === 0) uploadAttempts.delete(ip);
    else uploadAttempts.set(ip, recent);
  }
  // 推送日志只保留最近30天，避免无限增长
  try {
    db.prepare('DELETE FROM push_logs WHERE created_at < ?').run(now - 30 * 24 * 60 * 60 * 1000);
  } catch (e) {}
}, 30 * 60 * 1000);

function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (isValidSession(token)) {
    return next();
  }
  return res.status(401).json({ error: 'unauthorized' });
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function socketClientIP(socket) {
  const headers = socket.handshake.headers || {};
  const forwarded = cleanText(headers['x-forwarded-for'], 500).split(',')[0].trim();
  const realIP = cleanText(headers['x-real-ip'], 100);
  return cleanText(forwarded || realIP || socket.handshake.address || '', 100);
}

function isSafeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

function hasValidVisitorIdentity(visitorId, visitorSecret) {
  if (!isSafeId(visitorId) || !isSafeId(visitorSecret)) return false;
  const row = db.prepare('SELECT visitor_secret FROM visitors WHERE id = ?').get(visitorId);
  return Boolean(row && row.visitor_secret && row.visitor_secret === visitorSecret);
}

function requireUploadIdentity(req, res, next) {
  if (isValidSession(getTokenFromReq(req))) return next();
  const visitorId = req.get('X-Visitor-Id') || '';
  const visitorSecret = req.get('X-Visitor-Secret') || '';
  if (hasValidVisitorIdentity(visitorId, visitorSecret)) return next();
  return res.status(401).json({ error: '上传身份已失效，请刷新聊天窗口后重试' });
}

// ---------- 原生 App 实时事件流（SSE） ----------
// 使用系统自带的 HTTP 长连接，不要求 iOS App 集成第三方 Socket.IO SDK。
// Nginx 反代时 X-Accel-Buffering=no 可以避免事件被缓存，消息会立即到达手机。
const nativeEventClients = new Set();
let nativeForegroundSeenAt = 0;
const NATIVE_FOREGROUND_TTL_MS = 15 * 1000;

function isNativeAppForeground() {
  return Date.now() - nativeForegroundSeenAt < NATIVE_FOREGROUND_TTL_MS;
}

app.get('/api/native/health', (req, res) => {
  res.json({ ok: true, apiVersion: 2, pushMode: 'bark' });
});

function emitNativeEvent(type, conversationId, extra = {}) {
  const payload = JSON.stringify({ type, conversationId: conversationId || null, ...extra });
  for (const client of nativeEventClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (e) {
      nativeEventClients.delete(client);
    }
  }
}

app.get('/api/native/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  nativeEventClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'connected', conversationId: null })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    nativeEventClients.delete(res);
  });
});

app.post('/api/native/presence', requireAuth, (req, res) => {
  nativeForegroundSeenAt = req.body && req.body.active === true ? Date.now() : 0;
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.lockedUntil > now) {
    const waitMin = Math.ceil((attempt.lockedUntil - now) / 60000);
    return res.status(429).json({ error: `尝试次数太多，请${waitMin}分钟后再试` });
  }

  const { username, password } = req.body || {};
  if (ADMIN_USERNAME && ADMIN_PASSWORD && username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    loginAttempts.delete(ip);
    const token = createSession();
    res.cookie('ms_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: SESSION_TTL
    });
    return res.json({ ok: true, token });
  }

  const fails = (attempt && attempt.count || 0) + 1;
  const record = { count: fails, lockedUntil: 0 };
  if (fails >= 5) {
    record.lockedUntil = now + 10 * 60 * 1000; // 连续错5次，锁10分钟
    record.count = 0;
  }
  loginAttempts.set(ip, record);
  res.status(401).json({ error: '账号或密码错误' });
});

app.post('/api/logout', (req, res) => {
  deleteSession(getTokenFromReq(req));
  res.clearCookie('ms_session');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ ok: true }));

// manifest 依据实际管理路径动态生成，放在静态目录挂载之前优先匹配
app.get(`/${ADMIN_PATH}/manifest.json`, (req, res) => {
  res.json({
    name: '客服台',
    short_name: '客服台',
    start_url: `/${ADMIN_PATH}/index.html`,
    scope: `/`, // 故意放宽到整个域名（不只是/admin/），避免任何同源跳转(比如查看图片、下载附件)因为超出scope被iOS弹出到简化浏览器视图里
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
});

app.use('/' + ADMIN_PATH, express.static(path.join(__dirname, '..', 'admin'), {
  etag: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    // 管理端经常整目录覆盖升级；强制浏览器/CDN每次校验，避免新旧HTML、JS混用后只剩空壳。
    if (/\.(?:html|js|css|json)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// ---------- 文件上传 ----------
const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', // 图片
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', // 常见文档
  '.zip', '.rar', '.7z' // 压缩包
]);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${nanoid()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error('不支持的文件类型'));
    }
    cb(null, true);
  }
});

app.post('/api/upload', requireUploadIdentity, (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const record = uploadAttempts.get(ip) || [];
  const recent = record.filter((t) => now - t < 5 * 60 * 1000);
  if (recent.length >= 12) {
    return res.status(429).json({ error: '上传太频繁，请稍后再试' });
  }
  recent.push(now);
  uploadAttempts.set(ip, recent);

  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message === '不支持的文件类型' ? err.message : '上传失败' });
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const isImage = /^image\//.test(req.file.mimetype);
    res.json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      size: req.file.size,
      type: isImage ? 'image' : 'file'
    });
  });
});

// 非图片类型一律强制以附件方式下载，就算真有漏网的HTML/SVG文件混进来，
// 浏览器也不会把它当成网页直接执行/渲染，而是弹出下载
app.use('/uploads', (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  next();
}, express.static(UPLOAD_DIR, {
  etag: true,
  immutable: true,
  maxAge: '365d'
}));

// ---------- Widget 外观配置（供 widget.js 拉取，无需登录） ----------
const WIDGET_DEFAULTS = {
  widget_title: '在线客服',
  widget_color: '#6D5DFB',
  widget_color2: '#3B82F6',
  widget_launcher_text: '点我联系客服',
  widget_welcome_message: '你好呀，有什么可以帮你的？'
};

app.get('/api/widget-config', (req, res) => {
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${Object.keys(WIDGET_DEFAULTS).map(() => '?').join(',')})`
  ).all(...Object.keys(WIDGET_DEFAULTS));
  const out = { ...WIDGET_DEFAULTS };
  rows.forEach((r) => { out[r.key] = r.value; });
  res.json({
    title: out.widget_title,
    color: out.widget_color,
    color2: out.widget_color2,
    launcherText: out.widget_launcher_text,
    welcomeMessage: out.widget_welcome_message,
    menu: buildMenuTree()
  });
});

// ---------- 常用语 / 快捷回复 ----------
app.get('/api/canned-replies', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM canned_replies ORDER BY created_at ASC').all();
  res.json(rows);
});

app.post('/api/canned-replies', requireAuth, (req, res) => {
  const title = cleanText(req.body && req.body.title, 80);
  const content = cleanText(req.body && req.body.content, 10000);
  if (!title || !content) return res.status(400).json({ error: 'title/content required' });
  const row = { id: nanoid(), title, content, created_at: Date.now() };
  db.prepare('INSERT INTO canned_replies (id, title, content, created_at) VALUES (@id, @title, @content, @created_at)').run(row);
  res.json(row);
});

app.put('/api/canned-replies/:id', requireAuth, (req, res) => {
  const title = req.body && req.body.title !== undefined ? cleanText(req.body.title, 80) : null;
  const content = req.body && req.body.content !== undefined ? cleanText(req.body.content, 10000) : null;
  if (title === '' || content === '') return res.status(400).json({ error: 'title/content required' });
  db.prepare('UPDATE canned_replies SET title = COALESCE(?, title), content = COALESCE(?, content) WHERE id = ?')
    .run(title, content, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/canned-replies/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM canned_replies WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 菜单式引导（客户打开聊天窗看到的选项卡片）----------
app.get('/api/menu-items', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM menu_items ORDER BY parent_id NULLS FIRST, sort_order ASC, created_at ASC').all();
  res.json(rows);
});

app.post('/api/menu-items', requireAuth, (req, res) => {
  const { parentId, title, content, sortOrder } = req.body || {};
  const cleanTitle = cleanText(title, 80);
  const cleanContent = cleanText(content, 10000);
  if (!cleanTitle) return res.status(400).json({ error: 'title required' });
  if (parentId && !db.prepare('SELECT id FROM menu_items WHERE id = ?').get(parentId)) {
    return res.status(400).json({ error: 'parent not found' });
  }
  const row = {
    id: nanoid(),
    parent_id: parentId || null,
    title: cleanTitle,
    content: cleanContent || null,
    sort_order: Number.isFinite(Number(sortOrder)) ? Math.max(-9999, Math.min(9999, Number(sortOrder))) : 0,
    created_at: Date.now()
  };
  db.prepare(`INSERT INTO menu_items (id, parent_id, title, content, sort_order, created_at)
    VALUES (@id, @parent_id, @title, @content, @sort_order, @created_at)`).run(row);
  res.json(row);
});

app.put('/api/menu-items/:id', requireAuth, (req, res) => {
  const { title, content, sortOrder, parentId } = req.body || {};
  const id = req.params.id;
  const current = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'menu item not found' });
  if (title !== undefined && !cleanText(title, 80)) return res.status(400).json({ error: 'title required' });

  if (parentId !== undefined && parentId !== null) {
    // 防止把一个菜单项的上级设成它自己的子孙，那样会在树形结构里形成死循环
    if (parentId === id) return res.status(400).json({ error: '不能把自己设成自己的上级' });
    let cursor = db.prepare('SELECT parent_id FROM menu_items WHERE id = ?').get(parentId);
    if (!cursor) return res.status(400).json({ error: 'parent not found' });
    let hops = 0;
    while (cursor && cursor.parent_id && hops < 50) {
      if (cursor.parent_id === id) return res.status(400).json({ error: '不能把子菜单设成自己的上级，会形成循环' });
      cursor = db.prepare('SELECT parent_id FROM menu_items WHERE id = ?').get(cursor.parent_id);
      hops++;
    }
  }

  db.prepare(`UPDATE menu_items SET
    title = COALESCE(?, title),
    content = ?,
    sort_order = COALESCE(?, sort_order),
    parent_id = ?
    WHERE id = ?`).run(
    title === undefined ? null : cleanText(title, 80),
    content === undefined ? current.content : (cleanText(content, 10000) || null),
    sortOrder === undefined ? null : Math.max(-9999, Math.min(9999, Number(sortOrder) || 0)),
    parentId !== undefined ? (parentId || null) : current.parent_id,
    id
  );
  res.json({ ok: true });
});

app.delete('/api/menu-items/:id', requireAuth, (req, res) => {
  // 删除一个菜单项时，把它底下的子项也一起删掉，避免留下捞不到的孤儿子菜单
  const deleteRecursive = (id) => {
    const children = db.prepare('SELECT id FROM menu_items WHERE parent_id = ?').all(id);
    children.forEach((c) => deleteRecursive(c.id));
    db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
  };
  deleteRecursive(req.params.id);
  res.json({ ok: true });
});

// 把扁平的菜单表组装成嵌套树形结构，供访客端widget直接渲染用
function buildMenuTree() {
  const rows = db.prepare('SELECT * FROM menu_items ORDER BY sort_order ASC, created_at ASC').all();
  const byId = {};
  rows.forEach((r) => { byId[r.id] = { id: r.id, title: r.title, content: r.content || null, children: [] }; });
  const roots = [];
  rows.forEach((r) => {
    const node = byId[r.id];
    if (r.parent_id && byId[r.parent_id]) {
      byId[r.parent_id].children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

// ---------- Web Push 原生推送 ----------
app.get('/api/push-logs', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM push_logs ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows);
});

app.get('/api/push/vapid-public-key', requireAuth, (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.get('/api/push/subscriptions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, endpoint, created_at FROM push_subscriptions ORDER BY created_at DESC').all();
  // 端点url太长了，只截取有辨识度的一小段给管理员看，不用把完整密钥性质的东西暴露出来
  res.json(rows.map((r) => ({ id: r.id, endpointPreview: r.endpoint.slice(-24), created_at: r.created_at })));
});

app.delete('/api/push/subscriptions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  if (typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 2000 ||
      typeof sub.keys.p256dh !== 'string' || sub.keys.p256dh.length > 512 ||
      typeof sub.keys.auth !== 'string' || sub.keys.auth.length > 256) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at)
    VALUES (@id, @endpoint, @p256dh, @auth, @created_at)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`).run({
    id: nanoid(), endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, created_at: Date.now()
  });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

// ---------- 设置（Bark 推送地址等）----------
app.get('/api/settings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  rows.forEach(r => (out[r.key] = r.value));
  res.json(out);
});

app.post('/api/settings', requireAuth, (req, res) => {
  const rules = {
    bark_url: (v) => {
      const value = cleanText(v, 1000);
      return value === '' || /^https:\/\//i.test(value) ? value : null;
    },
    widget_title: (v) => cleanText(v, 80),
    widget_color: (v) => /^#[0-9A-Fa-f]{6}$/.test(String(v)) ? String(v).toUpperCase() : null,
    widget_color2: (v) => /^#[0-9A-Fa-f]{6}$/.test(String(v)) ? String(v).toUpperCase() : null,
    widget_launcher_text: (v) => cleanText(v, 40),
    widget_welcome_message: (v) => cleanText(v, 500)
  };
  const entries = [];
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!rules[key]) return res.status(400).json({ error: `不支持的设置项: ${key}` });
    const cleaned = rules[key](value);
    if (cleaned === null) return res.status(400).json({ error: `设置格式错误: ${key}` });
    entries.push([key, cleaned]);
  }
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );
  const tx = db.transaction(() => entries.forEach(([k, v]) => stmt.run(k, String(v))));
  tx();
  res.json({ ok: true });
});

// ---------- 会话列表 / 历史消息 ----------
app.get('/api/conversations', requireAuth, (req, res) => {
  const q = cleanText(req.query.q || '', 100);
  const like = `%${q}%`;
  const rows = q
    ? db.prepare(`
        SELECT c.*, v.name as visitor_name, v.email as visitor_email, v.ip as visitor_ip, v.last_url,
          (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
          (SELECT type FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_type
        FROM conversations c
        JOIN visitors v ON v.id = c.visitor_id
        WHERE v.name LIKE @like OR v.email LIKE @like OR c.tags LIKE @like OR c.notes LIKE @like
          OR EXISTS (SELECT 1 FROM messages m2 WHERE m2.conversation_id = c.id AND m2.content LIKE @like)
        ORDER BY c.last_message_at DESC
      `).all({ like })
    : db.prepare(`
        SELECT c.*, v.name as visitor_name, v.email as visitor_email, v.ip as visitor_ip, v.last_url,
          (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
          (SELECT type FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_type
        FROM conversations c
        JOIN visitors v ON v.id = c.visitor_id
        ORDER BY c.last_message_at DESC
      `).all();
  res.json(rows);
});

app.patch('/api/conversations/:id', requireAuth, (req, res) => {
  const { notes, tags, status } = req.body || {};
  const fields = [];
  const params = {};
  if (notes !== undefined) { fields.push('notes = @notes'); params.notes = cleanText(notes, 5000); }
  if (tags !== undefined) { fields.push('tags = @tags'); params.tags = cleanText(tags, 1000); }
  if (status !== undefined) {
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    fields.push('status = @status');
    params.status = status;
  }
  if (!fields.length) return res.json({ ok: true });
  params.id = req.params.id;
  let result;
  if (params.status === 'open') {
    const reopenConversation = db.transaction(() => {
      const target = db.prepare('SELECT visitor_id FROM conversations WHERE id = ?').get(params.id);
      if (target) {
        db.prepare("UPDATE conversations SET status = 'closed' WHERE visitor_id = ? AND id != ? AND status = 'open'")
          .run(target.visitor_id, params.id);
      }
      return db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = @id`).run(params);
    });
    result = reopenConversation();
  } else {
    result = db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = @id`).run(params);
  }
  if (!result.changes) return res.status(404).json({ error: 'conversation not found' });
  emitNativeEvent('conversation_updated', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  });
  tx();
  io.to('agents').emit('conversation_deleted', { conversationId: id });
  emitNativeEvent('conversation_deleted', id);
  res.json({ ok: true });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT c.*, v.name as visitor_name, v.email as visitor_email, v.ip as visitor_ip, v.last_url,
      (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
      (SELECT type FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_type
    FROM conversations c
    JOIN visitors v ON v.id = c.visitor_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'conversation not found' });
  res.json(row);
});

app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);
  res.json(rows);
});

app.post('/api/conversations/:id/read', requireAuth, (req, res) => {
  const result = db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ? AND unread_count != 0').run(req.params.id);
  if (result.changes) emitNativeEvent('conversation_updated', req.params.id);
  res.json({ ok: true });
});

app.post('/api/conversations/:id/typing', requireAuth, (req, res) => {
  const exists = db.prepare('SELECT id FROM conversations WHERE id = ?').get(req.params.id);
  if (!exists) return res.status(404).json({ error: 'conversation not found' });
  io.to(req.params.id).emit('agent_typing');
  res.json({ ok: true });
});

// ---------- 原生 App 消息接口 ----------
// 网页后台继续使用 Socket.IO；原生 iOS 客户端使用 REST，避免在 App 中引入
// 第三方 Socket.IO SDK。消息仍会广播给网页后台和访客端，两种客户端可以同时在线。
function createAgentMessage(conversationId, payload) {
  const clean = sanitizeMessagePayload(payload);
  if (!clean || !conversationId) return { error: 'invalid message', status: 400 };

  const conversation = db.prepare('SELECT id, visitor_id FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation) return { error: 'conversation not found', status: 404 };

  const msg = {
    id: nanoid(),
    conversation_id: conversationId,
    sender: 'agent',
    type: clean.type,
    content: clean.content,
    file_name: clean.fileName,
    file_size: clean.fileSize,
    created_at: Date.now(),
    recalled: 0
  };
  const saveAgentMessage = db.transaction(() => {
    // 客服在一条已结束的历史会话中重新回复时，以当前选择的会话为准，先结束同一访客
    // 其他进行中会话，再重新打开本会话，避免唯一索引冲突和重复open会话。
    db.prepare("UPDATE conversations SET status = 'closed' WHERE visitor_id = ? AND id != ? AND status = 'open'")
      .run(conversation.visitor_id, conversationId);
    db.prepare(`INSERT INTO messages (id, conversation_id, sender, type, content, file_name, file_size, created_at, recalled)
      VALUES (@id, @conversation_id, @sender, @type, @content, @file_name, @file_size, @created_at, @recalled)`).run(msg);
    db.prepare("UPDATE conversations SET last_message_at = ?, status = 'open' WHERE id = ?")
      .run(msg.created_at, conversationId);
  });
  saveAgentMessage();

  io.to(conversationId).to('agents').emit('new_message', msg);
  io.to('agents').emit('conversation_updated', { conversationId });
  emitNativeEvent('new_message', conversationId, { message: msg });
  return { message: msg };
}

function recallAgentMessage(conversationId, messageId) {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, conversationId);
  if (!msg) return { error: 'message not found', status: 404 };
  if (msg.sender !== 'agent') return { error: 'only agent messages can be recalled', status: 403 };
  if (!msg.recalled) {
    db.prepare('UPDATE messages SET recalled = 1 WHERE id = ?').run(messageId);
    io.to(conversationId).to('agents').emit('message_recalled', { conversationId, messageId });
    emitNativeEvent('message_recalled', conversationId, { messageId });
  }
  return { ok: true };
}

app.post('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const result = createAgentMessage(req.params.id, req.body || {});
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.message);
});

app.post('/api/conversations/:id/messages/:messageId/recall', requireAuth, (req, res) => {
  const result = recallAgentMessage(req.params.id, req.params.messageId);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
});

// ---------- Bark 推送 ----------
// 记一条推送尝试的结果，成功/失败都记，方便以后回查"这条消息到底有没有真的推送成功"
function logPushAttempt(channel, conversationId, success, detail) {
  try {
    db.prepare(`INSERT INTO push_logs (id, channel, conversation_id, success, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(nanoid(), channel, conversationId || null, success ? 1 : 0, detail || '', Date.now());
  } catch (e) {}
}

async function pushToBark(title, body, conversationId, attempt = 1) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'bark_url'").get();
  if (!row || !row.value) return;
  const base = row.value.replace(/\/$/, '');
  const unreadRow = db.prepare('SELECT COALESCE(SUM(unread_count), 0) AS total FROM conversations').get();
  const badgeCount = Math.max(1, Math.min(Number(unreadRow?.total) || 1, 999));
  let url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=myservice&badge=${badgeCount}&level=timeSensitive`;
  if (conversationId) {
    // Bark 的 url 参数支持自定义 URL Scheme。点击通知后直接唤起原生客服台，
    // conversation 路径会由 App 解析并导航到对应会话，无需先经过 Safari。
    const jumpUrl = `servicedesk://conversation/${encodeURIComponent(conversationId)}`;
    url += `&url=${encodeURIComponent(jumpUrl)}`;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8秒还没响应就当作超时，别无限挂着
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) throw new Error(`Bark返回了非成功状态码: ${res.status}`);
    logPushAttempt('bark', conversationId, true, attempt > 1 ? `第${attempt}次尝试成功` : '');
  } catch (e) {
    console.error(`❌ Bark推送失败(第${attempt}次尝试):`, e.message);
    // 网络抖动/Bark服务端偶发故障，很可能重试一下就好了，别一次失败就彻底放弃这条通知
    if (attempt < 4) {
      setTimeout(() => pushToBark(title, body, conversationId, attempt + 1), attempt * 2000);
    } else {
      console.error('❌ Bark推送连续4次都失败，放弃重试，这条客户消息的推送提醒确实没发出去，请检查Bark服务是否正常');
      logPushAttempt('bark', conversationId, false, `连续${attempt}次失败: ${e.message}`);
    }
  }
}

// ---------- Web Push 原生推送 ----------
async function pushWebPush(title, body, conversationId) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (!subs.length) {
    logPushAttempt('webpush', conversationId, false, '没有任何已注册的推送订阅(可能从没在手机上开启过原生推送，或者订阅已经失效被清理了)');
    return;
  }
  const jumpUrl = `/${ADMIN_PATH}/index.html${conversationId ? '?conv=' + encodeURIComponent(conversationId) : ''}`;
  const payload = JSON.stringify({ title, body, url: jumpUrl });
  await Promise.all(subs.map(async (s) => {
    const sendOnce = async () => webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      payload
    );
    try {
      await sendOnce();
      logPushAttempt('webpush', conversationId, true, '');
    } catch (e) {
      // 订阅失效了（比如用户卸载了PWA），清掉，避免每次都白发一次；这种情况不用重试，重试也没用
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
        logPushAttempt('webpush', conversationId, false, `订阅已失效(${e.statusCode})，已自动清理，需要重新在手机上开启一次原生推送`);
        return;
      }
      console.error('❌ Web Push推送失败，2秒后重试:', e.message);
      // 其他错误(比如网络抖动、推送服务瞬时故障)多重试几次再放弃，不要一次失败就彻底放弃
      let lastErr = e;
      let succeeded = false;
      for (let i = 0; i < 2 && !succeeded; i++) {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        try {
          await sendOnce();
          succeeded = true;
        } catch (e2) {
          lastErr = e2;
        }
      }
      if (succeeded) {
        logPushAttempt('webpush', conversationId, true, '重试后成功');
      } else {
        console.error('❌ Web Push多次重试后仍然失败，放弃:', lastErr.message);
        logPushAttempt('webpush', conversationId, false, `多次重试后仍失败: ${lastErr.message}`);
      }
    }
  }));
}

// ---------- Socket.IO ----------
// 在线的客服 socket 集合（判断是否需要推送）
const onlineAgents = new Set();
// 正在前台查看的客服（比onlineAgents更严格：连着但App被切到后台/锁屏的不算）
const activeAgents = new Set();
const agentLastSeen = new Map(); // socket.id -> 最后一次确认"真的在前台"的时间戳
const AGENT_STALE_MS = 90 * 1000; // 超过90秒没心跳，就算activeAgents里还有记录，也当作已经不在看了
// 判断是否真的有客服在前台盯着——不完全依赖"切到后台"这个事件本身触发得准不准
// （iOS上Page Visibility API在PWA场景下时有不可靠的情况），只要心跳超时了就算数
function isAnyAgentTrulyActive() {
  const now = Date.now();
  for (const id of activeAgents) {
    if (now - (agentLastSeen.get(id) || 0) < AGENT_STALE_MS) return true;
  }
  return false;
}

// 客服端连接需要携带有效token/cookie，握手阶段就拦截，未授权时客户端会收到真正的 connect_error 事件
function socketHandshakeIdentity(socket) {
  return {
    ...(socket.handshake.query || {}),
    ...(socket.handshake.auth || {})
  };
}

io.use((socket, next) => {
  const { role, token } = socketHandshakeIdentity(socket);
  if (role === 'agent') {
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');
    const authToken = token || cookies.ms_session;
    if (!isValidSession(authToken)) return next(new Error('unauthorized'));
  }
  next();
});

// 没填邮箱的访客给一个随机编号(chat123456)，比"访客"这种千篇一律的标签好辨认
function genVisitorLabel() {
  return 'chat' + Math.floor(100000 + Math.random() * 900000);
}

// 会话记录延迟创建：只有真的发了消息/填了联系方式才建库，避免访客只是路过没建立起真实的对话意向也留痕迹
const ensureConversation = db.transaction((vId, requestedConversationId) => {
  let requestedId = isSafeId(requestedConversationId) ? requestedConversationId : nanoid();
  const requested = db.prepare('SELECT id, visitor_id, status FROM conversations WHERE id = ?').get(requestedId);

  // 只能恢复当前访客自己的会话。若指定的是已结束会话，且没有其他进行中的会话，
  // 就重新打开原会话，继续保留完整上下文。
  if (requested && requested.visitor_id === vId) {
    if (requested.status === 'open') return requested.id;
    const existingOpen = db.prepare(
      "SELECT id FROM conversations WHERE visitor_id = ? AND status = 'open' ORDER BY last_message_at DESC LIMIT 1"
    ).get(vId);
    if (existingOpen) return existingOpen.id;
    db.prepare("UPDATE conversations SET status = 'open' WHERE id = ?").run(requested.id);
    return requested.id;
  }

  const existingOpen = db.prepare(
    "SELECT id FROM conversations WHERE visitor_id = ? AND status = 'open' ORDER BY last_message_at DESC LIMIT 1"
  ).get(vId);
  if (existingOpen) return existingOpen.id;

  // requestedId如果已经属于别人就绝不能复用，换一个全新的随机ID。
  if (requested) requestedId = nanoid();
  const now = Date.now();
  try {
    db.prepare(`INSERT INTO conversations (id, visitor_id, status, created_at, last_message_at, unread_count)
      VALUES (?, ?, 'open', ?, ?, 0)`).run(requestedId, vId, now, now);
    return requestedId;
  } catch (error) {
    // 两个标签页同时发出第一条消息时，唯一索引只允许一个成功；另一个直接复用赢家。
    if (error && String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      const winner = db.prepare(
        "SELECT id FROM conversations WHERE visitor_id = ? AND status = 'open' ORDER BY last_message_at DESC LIMIT 1"
      ).get(vId);
      if (winner) return winner.id;
    }
    throw error;
  }
});

const MAX_TEXT_LENGTH = 10000;
const UPLOAD_PATH_RE = /^\/uploads\/[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,10}$/;

// 服务端二次校验消息内容，不能只信任客户端传来的数据——
// 万一有人绕过widget界面直接拿socket.io-client连过来伪造消息，这里能兜住
function sanitizeMessagePayload(payload) {
  let { type, content, fileName, fileSize } = payload || {};
  content = typeof content === 'string' ? content : '';

  if (type === 'image' || type === 'file') {
    // image/file类型的content必须是我们自己上传接口生成的真实路径，不接受任意字符串
    if (!UPLOAD_PATH_RE.test(content)) return null;
    if (typeof fileName === 'string') fileName = fileName.slice(0, 200);
    if (typeof fileSize !== 'number') fileSize = null;
  } else {
    type = 'text';
    content = content.trim().slice(0, MAX_TEXT_LENGTH);
    if (!content) return null;
    fileName = null;
    fileSize = null;
  }
  return { type, content, fileName: fileName || null, fileSize: fileSize || null };
}

io.on('connection', (socket) => {
  const { role, visitorId, visitorSecret, conversationId, name, email, url } = socketHandshakeIdentity(socket);

  if (role === 'agent') {
    onlineAgents.add(socket.id);
    activeAgents.add(socket.id); // 连上时先默认是前台可见状态
    agentLastSeen.set(socket.id, Date.now());
    socket.join('agents');

    socket.on('disconnect', () => {
      onlineAgents.delete(socket.id);
      activeAgents.delete(socket.id);
      agentLastSeen.delete(socket.id);
    });

    // 客户端通过 Page Visibility API 上报：App切到后台/锁屏 -> away，回到前台 -> active，
    // 另外客户端还会定期发心跳(哪怕visibility事件没触发准，心跳停了服务器也能识别出"已经不在看了")
    socket.on('agent_away', () => activeAgents.delete(socket.id));
    socket.on('agent_active', () => { activeAgents.add(socket.id); agentLastSeen.set(socket.id, Date.now()); });
    socket.on('agent_heartbeat', () => agentLastSeen.set(socket.id, Date.now()));

    socket.on('join_conversation', (convId) => {
      if (isSafeId(convId) && db.prepare('SELECT id FROM conversations WHERE id = ?').get(convId)) socket.join(convId);
    });

    socket.on('agent_typing', (payload) => {
      const { conversationId } = payload || {};
      if (isSafeId(conversationId) && db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId)) {
        io.to(conversationId).emit('agent_typing');
      }
    });

    socket.on('agent_message', (payload) => {
      const { conversationId } = payload || {};
      createAgentMessage(conversationId, payload || {});
    });

    // 撤回消息：只能撤回客服自己发的消息，不能撤回访客发的
    socket.on('agent_recall_message', (payload) => {
      const { conversationId, messageId } = payload || {};
      if (!conversationId || !messageId) return;
      recallAgentMessage(conversationId, messageId);
    });

    return;
  }

  // ---- 访客端 ----
  if (role === 'visitor') {
    let vId = isSafeId(visitorId) ? visitorId : nanoid();
    let vSecret = isSafeId(visitorSecret) ? visitorSecret : '';
    const now = Date.now();

    let existingVisitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(vId);
    // 已启用 secret 的访客必须同时匹配；不匹配时创建全新匿名身份，绝不返回原历史。
    // 老数据没有 secret，第一次升级连接时生成并回传一次，之后即进入双重校验。
    if (existingVisitor && existingVisitor.visitor_secret && existingVisitor.visitor_secret !== vSecret) {
      vId = nanoid();
      vSecret = nanoid(40);
      existingVisitor = null;
    } else if (existingVisitor && !existingVisitor.visitor_secret) {
      vSecret = nanoid(40);
      db.prepare('UPDATE visitors SET visitor_secret = ? WHERE id = ?').run(vSecret, vId);
      existingVisitor.visitor_secret = vSecret;
    } else if (!existingVisitor && !vSecret) {
      vSecret = nanoid(40);
    }

    const visitorIP = socketClientIP(socket) || (existingVisitor && existingVisitor.ip) || '';
    if (!existingVisitor) {
      db.prepare(`INSERT INTO visitors (id, visitor_secret, name, email, ip, user_agent, first_seen, last_seen, last_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        vId,
        vSecret,
        cleanText(name, 80) || genVisitorLabel(),
        cleanText(email, 254),
        visitorIP,
        cleanText(socket.handshake.headers['user-agent'] || '', 500),
        now,
        now,
        cleanText(url, 2000)
      );
    } else {
      db.prepare('UPDATE visitors SET last_seen = ?, last_url = ?, ip = ? WHERE id = ?')
        .run(now, cleanText(url, 2000), visitorIP, vId);
      if (email && !existingVisitor.email) {
        db.prepare('UPDATE visitors SET email = ? WHERE id = ?').run(cleanText(email, 254), vId);
      }
    }

    let convId = isSafeId(conversationId) ? conversationId : '';
    // 即使有人拿到了别人的 conversationId，也必须归属于已验证的 visitorId 才能恢复历史。
    let conv = convId ? db.prepare('SELECT * FROM conversations WHERE id = ? AND visitor_id = ?').get(convId, vId) : null;
    if (!conv) {
      conv = db.prepare("SELECT * FROM conversations WHERE visitor_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1").get(vId);
    }
    // 注意：这里不再立即往数据库插入会话记录了——只是先定下这次要用的会话ID，
    // 真正建库要等访客发第一条消息/填联系方式的时候（ensureConversation函数），
    // 不然访客只是打开网页看一眼、什么都没说就走，也会在后台留下一条空会话，显得很乱。
    convId = conv ? conv.id : nanoid();

    socket.join(convId);
    function emitVisitorSession() {
      socket.emit('session_info', { visitorId: vId, visitorSecret: vSecret, conversationId: convId });
    }
    function activateConversation() {
      const activeConversationId = ensureConversation(vId, convId);
      if (activeConversationId !== convId) {
        socket.leave(convId);
        convId = activeConversationId;
        socket.join(convId);
        emitVisitorSession();
      }
      return convId;
    }
    emitVisitorSession();

    // 把历史消息发给访客（重新打开widget时）；如果这个会话还没真正建库，这里自然查出空数组，没问题
    // 已撤回的消息不发给访客，不管是刚撤回还是很久以前撤回的，客户端永远看不到
    const history = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND recalled = 0 ORDER BY created_at ASC').all(convId);
    socket.emit('history', history);

    socket.on('visitor_info', (payload) => {
      const vName = cleanText(payload && payload.name, 80);
      const vEmail = cleanText(payload && payload.email, 254);
      if (!vName && !vEmail) return;
      activateConversation();
      db.prepare('UPDATE visitors SET name = COALESCE(NULLIF(?, \'\'), name), email = COALESCE(NULLIF(?, \'\'), email) WHERE id = ?')
        .run(vName || '', vEmail || '', vId);
      io.to('agents').emit('conversation_updated', { conversationId: convId });
      emitNativeEvent('conversation_updated', convId);
    });

    socket.on('visitor_typing', () => {
      io.to('agents').emit('visitor_typing', { conversationId: convId });
      emitNativeEvent('visitor_typing', convId);
    });

    // 访客客户端确认收到了消息（送达），或者确认真的打开窗口看了（已读）
    socket.on('visitor_delivered', () => {
      db.prepare('UPDATE conversations SET visitor_delivered_at = ? WHERE id = ?').run(Date.now(), convId);
      io.to('agents').emit('conversation_updated', { conversationId: convId });
      emitNativeEvent('conversation_updated', convId);
    });
    socket.on('visitor_read', () => {
      const now = Date.now();
      db.prepare('UPDATE conversations SET visitor_delivered_at = MAX(visitor_delivered_at, ?), visitor_read_at = ? WHERE id = ?')
        .run(now, now, convId);
      io.to('agents').emit('conversation_updated', { conversationId: convId });
      emitNativeEvent('conversation_updated', convId);
    });

    let msgTimestamps = [];
    socket.on('visitor_message', (payload) => {
      // 简单防刷：10秒内超过15条消息就先丢弃，防止恶意脚本刷爆数据库和Bark推送
      const now2 = Date.now();
      msgTimestamps = msgTimestamps.filter((t) => now2 - t < 10000);
      if (msgTimestamps.length >= 15) return;
      msgTimestamps.push(now2);

      const clean = sanitizeMessagePayload(payload);
      if (!clean) return;
      activateConversation();
      const msg = {
        id: nanoid(),
        conversation_id: convId,
        sender: 'visitor',
        type: clean.type,
        content: clean.content,
        file_name: clean.fileName,
        file_size: clean.fileSize,
        created_at: Date.now()
      };
      db.prepare(`INSERT INTO messages (id, conversation_id, sender, type, content, file_name, file_size, created_at)
        VALUES (@id, @conversation_id, @sender, @type, @content, @file_name, @file_size, @created_at)`).run(msg);
      db.prepare("UPDATE conversations SET last_message_at = ?, unread_count = unread_count + 1, status = 'open' WHERE id = ?")
        .run(msg.created_at, convId);

      io.to(convId).to('agents').emit('new_message', msg);
      io.to('agents').emit('conversation_updated', { conversationId: convId, hasNewVisitorMsg: true });
      emitNativeEvent('new_message', convId, { message: msg });

      const preview = clean.type === 'text' ? clean.content.slice(0, 60) : `[${clean.type === 'image' ? '图片' : '文件'}]`;
      // 原生 App 明确处于前台时由 SSE、App 内声音和未读数字提醒，不再重复发送 Bark。
      // App 进入后台会立即上报；上报失败时 15 秒心跳过期后自动恢复 Bark，避免长期漏通知。
      if (!isNativeAppForeground()) pushToBark('新客服消息', preview, convId);
      pushWebPush('新客服消息', preview, convId);
    });
  }
});

server.listen(PORT, () => console.log(`Server running on :${PORT}`));
