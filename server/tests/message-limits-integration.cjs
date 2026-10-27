// Uses a fresh temporary SQLite DB; never loads the project's .env or customer data.
// Run with the server dependencies plus socket.io-client installed, or set NODE_PATH
// to a separate test dependency directory: node --test server/tests/message-limits-integration.cjs.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { io } = require('socket.io-client');

async function until(predicate, label) {
  for (let i = 0; i < 200; i++) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out: ' + label);
}

test('100k messages survive HTTP, WebSocket, polling, SQLite history and native SSE', { timeout: 60000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-message-integration-'));
  for (const name of ['server.js', 'db.js', 'message-validation.js', 'abuse-guard.js', 'image-upload.js']) {
    fs.copyFileSync(path.join(__dirname, '..', name), path.join(fixture, name));
  }
  const portProbe = net.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const dependencyPath = [path.join(__dirname, '../node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  const child = spawn(process.execPath, [path.join(fixture, 'server.js')], {
    cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_PATH: dependencyPath, PORT: String(port),
      ADMIN_USERNAME: 'message-test', ADMIN_PASSWORD: 'local-fixture-only',
      ADMIN_PATH: 'admin', PUBLIC_URL: base, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
      DOTENV_CONFIG_PATH: path.join(fixture, 'no-env-file')
    }
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const sockets = [];
  const sseAbort = new AbortController();
  let sseReaderTask;
  let sseError;
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error('Fixture server stopped: ' + logs);
      try { return (await fetch(base + '/api/native/health')).ok; } catch { return false; }
    }, 'server ready');
    const login = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'message-test', password: 'local-fixture-only' })
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const events = [];
    const stream = await fetch(base + '/api/native/events', { headers, signal: sseAbort.signal });
    sseReaderTask = (async () => {
      const decoder = new TextDecoder();
      let pending = '';
      for await (const chunk of stream.body) {
        pending += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const line = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        }
      }
    })().catch(error => { if (!sseAbort.signal.aborted) sseError = error; });
    await until(() => events.some(event => event.type === 'connected'), 'SSE connected');

    async function connect(auth, transport) {
      const client = io(base, { autoConnect: false, transports: [transport], reconnection: false, auth });
      sockets.push(client);
      const messages = [];
      let session;
      let history;
      let failure;
      client.on('connect_error', error => { failure = error; });
      client.on('new_message', message => messages.push(message));
      client.on('session_info', data => { session = data; });
      client.on('history', data => { history = data; });
      client.connect();
      await until(() => {
        if (failure) throw failure;
        return client.connected && (auth.role === 'agent' || (session && history));
      }, transport + ' connected');
      return { client, messages, session, history };
    }
    const agent = await connect({ role: 'agent', token }, 'websocket');
    const visitor = await connect({ role: 'visitor' }, 'websocket');
    const pollingVisitor = await connect({ role: 'visitor' }, 'polling');
    const convId = visitor.session.conversationId;
    const contents = ['首' + '中'.repeat(99998) + '尾', '😀'.repeat(50000), '\u0000'.repeat(100000)];
    const expected = new Map();
    async function ack(client, event, payload) {
      return await new Promise((resolve, reject) => {
        client.timeout(5000).emit(event, payload, (error, response) => error ? reject(error) : resolve(response));
      });
    }
    for (let i = 0; i < contents.length; i++) {
      const content = contents[i];
      const visitorId = `visitor-boundary-${i}`;
      const visitorReply = await ack(visitor.client, 'visitor_message', { type: 'text', content, clientMessageId: visitorId });
      assert.equal(visitorReply.ok, true);
      expected.set(visitorId, content);
      assert.equal((await until(() => agent.messages.find(message => message.id === visitorId), 'agent receives visitor')).content, content);
      assert.equal((await until(() => events.find(event => event.message?.id === visitorId), 'native receives visitor')).message.content, content);

      const httpId = `http-boundary-${i}`;
      const response = await fetch(`${base}/api/conversations/${convId}/messages`, {
        method: 'POST', headers, body: JSON.stringify({ type: 'text', content, clientMessageId: httpId })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).content, content);
      expected.set(httpId, content);
      assert.equal((await until(() => visitor.messages.find(message => message.id === httpId), 'visitor receives HTTP message')).content, content);

      const socketId = `agent-boundary-${i}`;
      assert.equal((await ack(agent.client, 'agent_message', { conversationId: convId, type: 'text', content, clientMessageId: socketId })).ok, true);
      expected.set(socketId, content);
      assert.equal((await until(() => visitor.messages.find(message => message.id === socketId), 'visitor receives agent socket')).content, content);

      const pollingId = `polling-boundary-${i}`;
      assert.equal((await ack(pollingVisitor.client, 'visitor_message', { type: 'text', content, clientMessageId: pollingId })).ok, true);
      assert.equal((await until(() => pollingVisitor.messages.find(message => message.id === pollingId), 'polling echo')).content, content);
    }
    console.log('PASS: 100k Chinese, emoji and escaped text across HTTP/WebSocket/polling/SSE');

    const oversized = { type: 'text', content: '中'.repeat(100001), clientMessageId: 'must-not-be-saved' };
    assert.equal((await ack(visitor.client, 'visitor_message', oversized)).code, 'MESSAGE_TOO_LONG');
    assert.equal((await ack(pollingVisitor.client, 'visitor_message', oversized)).code, 'MESSAGE_TOO_LONG');
    assert.equal((await ack(agent.client, 'agent_message', { ...oversized, conversationId: convId })).code, 'MESSAGE_TOO_LONG');
    const rejected = await fetch(`${base}/api/conversations/${convId}/messages`, { method: 'POST', headers, body: JSON.stringify(oversized) });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'MESSAGE_TOO_LONG');
    assert.equal(visitor.client.connected, true, 'business limit does not disconnect socket');
    assert.equal(pollingVisitor.client.connected, true);
    const tooLarge = await fetch(`${base}/api/conversations/${convId}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ type: 'text', content: 'a'.repeat(1024 * 1024) })
    });
    assert.equal(tooLarge.status, 413, 'transport byte cap remains enforced');

    const duplicate = await ack(visitor.client, 'visitor_message', { type: 'text', content: contents[0], clientMessageId: 'visitor-boundary-0' });
    assert.equal(duplicate.ok, true);
    const saved = await (await fetch(`${base}/api/conversations/${convId}/messages`, { headers })).json();
    assert.equal(saved.length, expected.size, 'oversized messages never stored and retry never duplicates');
    for (const message of saved) assert.equal(message.content, expected.get(message.id));
    visitor.client.close();
    const restored = await connect({ role: 'visitor', ...visitor.session }, 'websocket');
    assert.equal(restored.history.length, expected.size);
    for (const message of restored.history) assert.equal(message.content, expected.get(message.id));
    assert.equal(sseError, undefined);
    console.log('PASS: rejects 100001 without truncation; preserves complete history, reconnect and idempotency');

    const incomingEvent = events.find(event => event.message?.id === 'visitor-boundary-2');
    assert.equal(incomingEvent.conversation.id, convId);
    assert.equal(incomingEvent.conversation.unread_count, 3);
    assert.equal(incomingEvent.conversation.last_sender, 'visitor');
    const listResponse = await fetch(base + '/api/conversations', { headers });
    assert.match(listResponse.headers.get('cache-control'), /no-store/);
    const listCursor = Number(listResponse.headers.get('x-chat-event-id'));
    assert.ok(Number.isSafeInteger(listCursor) && listCursor >= incomingEvent.eventId);
    const markThrough = (id) => fetch(base + '/api/conversations/' + convId + '/read', {
      method: 'POST', headers, body: JSON.stringify({ throughMessageId: id })
    });
    assert.equal((await markThrough('visitor-boundary-0')).status, 200);
    let row = await (await fetch(base + '/api/conversations/' + convId, { headers })).json();
    assert.equal(row.unread_count, 2, 'messages arriving after the rendered marker remain unread');
    await until(() => events.some(event => event.type === 'conversation_updated' &&
      event.conversationId === convId && event.conversation?.unread_count === 2), 'read event carries unread snapshot');
    assert.equal((await markThrough('polling-boundary-0')).status, 400, 'cannot acknowledge another conversation');
    assert.equal((await markThrough('visitor-boundary-2')).status, 200);
    assert.equal((await markThrough('visitor-boundary-0')).status, 200);
    row = await (await fetch(base + '/api/conversations/' + convId, { headers })).json();
    assert.equal(row.unread_count, 0, 'late old read cannot restore already acknowledged unread');
    console.log('PASS: realtime preview, unread snapshot cursor, cache policy and precise read acknowledgements');
  } finally {
    sseAbort.abort();
    for (const client of sockets) client.close();
    if (sseReaderTask) await sseReaderTask;
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    // Only our unique, synthetic-data fixture is removed; never a project path.
    assert.equal(path.dirname(fixture), os.tmpdir());
    assert.ok(path.basename(fixture).startsWith('chat-message-integration-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
