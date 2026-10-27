// Synthetic data only. Never reads the production .env or customer database.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { SlidingWindowLimiter } = require('../abuse-guard');
const { cleanImage } = require('../image-upload');

test('decoder rejects oversized dimensions and truncated pixel data', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-image-security-'));
  try {
    const wide = await sharp({ create: { width: 12001, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
    await assert.rejects(cleanImage(wide, folder), /尺寸过大/);
    const image = await sharp({ create: { width: 50, height: 50, channels: 3, background: 'red' } }).png().toBuffer();
    await assert.rejects(cleanImage(image.subarray(0, image.length - 30), folder), /有效图片/);
    assert.deepEqual(fs.readdirSync(folder), []);
  } finally {
    assert.equal(path.dirname(folder), os.tmpdir());
    assert.ok(path.basename(folder).startsWith('chat-image-security-'));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('shared limiter expires and bounds keys without resetting on reconnect', () => {
  const guard = new SlidingWindowLimiter(2);
  assert.equal(guard.take('a', 2, 10, 1, 0), true);
  assert.equal(guard.take('a', 2, 10, 1, 1), true);
  assert.equal(guard.take('a', 2, 10, 1, 2), false);
  assert.equal(guard.take('b', 1, 10, 1, 2), true);
  assert.equal(guard.take('c', 1, 10, 1, 3), false);
  assert.equal(guard.take('a', 2, 10, 1, 12), true);
  guard.sweep(30);
  assert.equal(guard.entries.size, 0);
});

test('visitor identity, upload ownership, image decoding and anti-flood', { timeout: 60000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-security-regression-'));
  for (const file of ['server.js', 'db.js', 'message-validation.js', 'abuse-guard.js', 'image-upload.js']) {
    fs.copyFileSync(path.join(__dirname, '..', file), path.join(fixture, file));
  }
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(fixture, 'server.js')], {
    cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), ADMIN_USERNAME: 'audit', ADMIN_PASSWORD: 'fixture-only',
      PUBLIC_URL: base, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', DOTENV_CONFIG_PATH: path.join(fixture, 'no-env') }
  });
  let logs = '', db;
  child.stdout.on('data', s => logs += s);
  child.stderr.on('data', s => logs += s);
  const clients = [];
  async function until(fn) {
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      const value = await fn(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Timed out');
  }
  async function connect(auth) {
    const socket = io(base, { autoConnect: false, transports: ['websocket'], reconnection: false, auth });
    clients.push(socket);
    const result = { socket, messages: [] };
    socket.on('session_info', s => result.session = s);
    socket.on('history', h => result.history = h);
    socket.on('new_message', m => result.messages.push(m));
    socket.on('connect_error', e => result.error = e.message);
    socket.connect();
    await until(() => result.error || (auth.role === 'agent' ? socket.connected : result.session && result.history));
    return result;
  }
  function send(client, payload) {
    return new Promise((resolve, reject) => client.socket.timeout(3000).emit('visitor_message', payload, (e, r) => e ? reject(e) : resolve(r)));
  }
  async function upload(headers, name, bytes, type = 'image/png') {
    const form = new FormData(); form.append('file', new Blob([bytes], { type }), name);
    const response = await fetch(base + '/api/upload', { method: 'POST', headers, body: form });
    return { status: response.status, data: await response.json() };
  }
  const identityHeaders = client => ({ 'X-Visitor-Id': client.session.visitorId, 'X-Visitor-Secret': client.session.visitorSecret });
  try {
    await until(async () => { try { return (await fetch(base + '/api/native/health')).ok; } catch { return false; } });
    db = new Database(path.join(fixture, 'data.sqlite'));
    const now = Date.now();
    db.prepare('INSERT INTO visitors(id,name,visitor_secret,first_seen,last_seen) VALUES(?,?,NULL,?,?)').run('legacy-visitor', 'legacy', now, now);
    db.prepare("INSERT INTO conversations(id,visitor_id,status,created_at,last_message_at) VALUES(?,?,'open',?,?)").run('legacy-conversation', 'legacy-visitor', now, now);
    db.prepare("INSERT INTO messages(id,conversation_id,sender,type,content,created_at) VALUES(?,?,'visitor','text',?,?)").run('legacy-message', 'legacy-conversation', 'PRIVATE', now);
    const claim = await connect({ role: 'visitor', visitorId: 'legacy-visitor', conversationId: 'legacy-conversation' });
    assert.notEqual(claim.session.visitorId, 'legacy-visitor');
    assert.deepEqual(claim.history, []);
    assert.equal(db.prepare('SELECT visitor_secret FROM visitors WHERE id=?').get('legacy-visitor').visitor_secret, null);
    const victim = await connect({ role: 'visitor', visitorId: 'chosen-id', visitorSecret: 'chosen-secret' });
    assert.notEqual(victim.session.visitorId, 'chosen-id');
    assert.equal((await send(victim, { content: 'private history', clientMessageId: 'victim-message' })).ok, true);
    const restored = await connect({ role: 'visitor', ...victim.session });
    assert.equal(restored.history[0].content, 'private history');
    const intruder = await connect({ role: 'visitor', ...victim.session, visitorSecret: 'wrong-secret' });
    assert.notEqual(intruder.session.visitorId, victim.session.visitorId);
    assert.deepEqual(intruder.history, []);
    const forged = await send(intruder, { type: 'text', content: 'FORGED-AGENT', sender: 'agent', conversationId: victim.session.conversationId, clientMessageId: 'forged-message' });
    assert.equal(forged.ok, true);
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get('forged-message');
    assert.equal(row.sender, 'visitor'); assert.equal(row.conversation_id, intruder.session.conversationId);
    assert.equal((await send(claim, { type: 'html', content: '<script>bad</script>' })).code, 'INVALID_MESSAGE_TYPE');
    assert.equal((await send(claim, { type: 'file', content: '/uploads/old.pdf' })).code, 'IMAGE_ONLY');
    assert.equal((await send(claim, { type: 'image', content: '/uploads/missing.png' })).code, 'INVALID_ATTACHMENT');
    assert.equal(db.prepare('SELECT count(*) n FROM conversations WHERE visitor_id=?').get(claim.session.visitorId).n, 0);
    assert.equal((await connect({ role: 'agent', token: { unexpected: true } })).error, 'unauthorized');
    assert.equal((await connect({ role: 'system' })).error, 'unauthorized');
    assert.equal((await fetch(base + '/api/conversations')).status, 401);
    console.log('PASS: legacy claim, secret spoofing, cross-conversation and sender spoofing blocked');

    const headers = identityHeaders(victim);
    assert.equal((await upload({}, 'a.png', 'fake')).status, 401);
    for (const [name, bytes, mime] of [
      ['a.txt', 'text', 'text/plain'], ['a.pdf', '%PDF', 'image/png'], ['a.svg', '<svg/>', 'image/svg+xml'],
      ['a.png', '<html><script>bad</script></html>', 'image/png'], ['a.png', Buffer.from('89504e470d0a1a0a0000', 'hex'), 'image/png'],
      ['a.png', '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>', 'image/png']
    ]) assert.equal((await upload(headers, name, bytes, mime)).status, 400, name);
    assert.deepEqual(fs.readdirSync(path.join(fixture, 'uploads')), []);
    assert.deepEqual(fs.readdirSync(path.join(fixture, '.upload-staging')), []);
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff00ff' } }).png().toBuffer();
    const tail = Buffer.from('<script>TRAILING-PAYLOAD</script>');
    const valid = await upload(headers, 'safe.png', Buffer.concat([png, tail]));
    assert.equal(valid.status, 200, JSON.stringify(valid)); assert.equal(valid.data.type, 'image');
    const served = await fetch(base + valid.data.url);
    const sanitized = Buffer.from(await served.arrayBuffer());
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(sanitized.includes(tail), false); assert.equal((await sharp(sanitized).metadata()).format, 'png');
    assert.equal(valid.data.size, sanitized.length);
    assert.equal((await send(intruder, { type: 'image', content: valid.data.url })).code, 'INVALID_ATTACHMENT');
    assert.equal((await send(victim, { type: 'image', content: valid.data.url, fileName: 'spoof.exe', fileSize: 1, clientMessageId: 'valid-picture' })).ok, true);
    const picture = db.prepare('SELECT * FROM messages WHERE id=?').get('valid-picture');
    assert.equal(picture.file_name, valid.data.name); assert.equal(picture.file_size, sanitized.length);
    const login = await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'audit', password: 'fixture-only' }) })).json();
    const agentHeaders = { Authorization: 'Bearer ' + login.token };
    const document = await upload(agentHeaders, 'agent.txt', 'agent document', 'image/png');
    assert.equal(document.status, 200); assert.equal(document.data.type, 'file');
    assert.equal((await fetch(base + document.data.url)).headers.get('content-disposition'), 'attachment');
    for (const format of ['jpeg', 'webp', 'gif']) {
      const bytes = await sharp(png).toFormat(format).toBuffer();
      assert.equal((await upload(agentHeaders, 'image.' + format.replace('jpeg', 'jpg'), bytes)).status, 200);
    }
    console.log('PASS: fake images and SVG rejected; re-encoding, ownership and agent documents verified');

    const flood = await connect({ role: 'visitor' });
    for (let i = 0; i < 8; i++) assert.equal((await send(flood, { content: 'test ' + i, clientMessageId: 'flood-test-' + i })).ok, true);
    assert.equal((await send(flood, { content: 'retry', clientMessageId: 'flood-test-0' })).ok, true);
    flood.socket.close();
    const reconnect = await connect({ role: 'visitor', ...flood.session });
    const rejected = await send(reconnect, { content: 'ninth', clientMessageId: 'flood-test-9' });
    assert.equal(rejected.code, 'RATE_LIMITED'); assert.equal(rejected.retryable, false);
    assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE conversation_id=?').get(flood.session.conversationId).n, 8);
    assert.deepEqual(fs.readdirSync(path.join(fixture, '.upload-staging')), []);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    console.log('PASS: reconnect cannot reset flood budget; retry is idempotent; DB healthy');
  } finally {
    clients.forEach(client => client.close());
    if (db) db.close();
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.equal(path.dirname(fixture), os.tmpdir());
    assert.ok(path.basename(fixture).startsWith('chat-security-regression-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
