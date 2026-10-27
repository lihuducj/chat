// Disposable loopback fixture: never reads the live database or credentials.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { io } = require('socket.io-client');

test('logout revokes live agent sockets and SSE; URL and Cookie cannot authenticate a socket', { timeout: 30000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-auth-revocation-'));
  const sockets = [];
  let child;
  let stream;
  try {
    for (const file of ['server.js', 'db.js', 'message-validation.js', 'abuse-guard.js', 'image-upload.js']) {
      fs.copyFileSync(path.join(__dirname, '..', file), path.join(fixture, file));
    }
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    let logs = '';
    child = spawn(process.execPath, [path.join(fixture, 'server.js')], {
      cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), ADMIN_USERNAME: 'audit', ADMIN_PASSWORD: 'fixture-only',
        PUBLIC_URL: base, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', DOTENV_CONFIG_PATH: path.join(fixture, 'no-env') }
    });
    child.stdout.on('data', data => logs += data);
    child.stderr.on('data', data => logs += data);
    async function until(fn, label) {
      for (let i = 0; i < 200; i++) {
        if (child.exitCode !== null) throw new Error(`Fixture exited: ${logs}`);
        if (await fn()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for ${label}`);
    }
    await until(async () => {
      try { return (await fetch(`${base}/api/native/health`)).ok; } catch { return false; }
    }, 'startup');
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'audit', password: 'fixture-only' }) });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const bearer = { Authorization: `Bearer ${token}` };
    const valid = io(base, { autoConnect: false, transports: ['websocket'], reconnection: false,
      auth: { role: 'agent', token } });
    sockets.push(valid);
    valid.connect();
    await until(() => valid.connected, 'valid agent connection');

    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const options of [
      { query: { role: 'agent', token } },
      { auth: { role: 'agent' }, extraHeaders: { Cookie: cookie } }
    ]) {
      const rejected = io(base, { autoConnect: false, transports: ['websocket'], reconnection: false, ...options });
      sockets.push(rejected);
      let error = '';
      rejected.on('connect_error', e => { error = e.message; });
      rejected.connect();
      await until(() => error, 'unauthorized socket');
      assert.equal(error, 'unauthorized');
      assert.equal(rejected.connected, false);
    }

    stream = await fetch(`${base}/api/native/events`, { headers: bearer });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /connected/);
    assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers: bearer })).status, 200);
    assert.equal((await fetch(`${base}/api/me`, { headers: bearer })).status, 401);
    await until(() => !valid.connected, 'revoked agent disconnect');
    assert.equal((await reader.read()).done, true);

    const revoked = io(base, { autoConnect: false, transports: ['websocket'], reconnection: false,
      auth: { role: 'agent', token } });
    sockets.push(revoked);
    let error = '';
    revoked.on('connect_error', e => { error = e.message; });
    revoked.connect();
    await until(() => error, 'revoked socket rejection');
    assert.equal(error, 'unauthorized');
  } finally {
    if (stream && !stream.body.locked) await stream.body.cancel().catch(() => {});
    sockets.forEach(socket => socket.close());
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.equal(path.dirname(fixture), os.tmpdir());
    assert.ok(path.basename(fixture).startsWith('chat-auth-revocation-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
