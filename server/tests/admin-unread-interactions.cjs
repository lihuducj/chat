// Real admin HTML/JS in an isolated browser, with synthetic network responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.CHAT_TEST_PLAYWRIGHT || 'playwright');
const admin = path.join(__dirname, '../../admin');
const readRequests = [];
const messages = [];
const row = { id: 'fixture-conversation', visitor_id: 'fixture-visitor', visitor_email: 'fixture@example.test',
  status: 'open', created_at: 1, last_message_at: 1, unread_count: 0, last_type: 'text', last_sender: 'visitor', last_message: '' };
const socketScript = 'window.io = () => { const listeners = {}; const s = window.fixtureSocket = { connected: true,' +
  ' on: (name, fn) => { listeners[name] = fn; return s; }, emit: () => s, timeout: () => s,' +
  ' receive: (name, value) => listeners[name]?.(value) }; queueMicrotask(() => s.receive("connect")); return s; };';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHAT_TEST_BROWSER || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('ms_token', 'synthetic-only');
      window.fixtureFocused = false;
      window.fixtureHidden = false;
      document.hasFocus = () => window.fixtureFocused;
      Object.defineProperty(document, 'hidden', { get: () => window.fixtureHidden });
    });
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      if (pathname === '/socket.io/socket.io.js') return route.fulfill({ contentType: 'application/javascript', body: socketScript });
      if (pathname === '/api/me') return json({ ok: true });
      if (pathname === '/api/conversations') return json([row]);
      if (pathname.endsWith('/messages')) return json(messages);
      if (pathname.endsWith('/read')) {
        const marker = route.request().postDataJSON().throughMessageId;
        readRequests.push(marker);
        const index = messages.findIndex(message => message.id === marker);
        assert.ok(index >= 0, 'read must identify a rendered message');
        row.unread_count = messages.slice(index + 1).filter(message => message.sender === 'visitor').length;
        return json({ ok: true });
      }
      const filename = path.basename(pathname);
      if (['index.html', 'app.js', 'style.css', 'manifest.json'].includes(filename)) {
        const mime = filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
        return route.fulfill({ contentType: mime, body: fs.readFileSync(path.join(admin, filename)) });
      }
      return json({});
    });
    await page.goto('https://admin-test.invalid/admin/index.html');
    await page.waitForSelector('.conv-item');
    assert.equal(await page.title(), 'Chat');
    await page.locator('.conv-item').click();
    await page.waitForFunction(() => conversationLoadBuffer === null);

    async function incoming(id, content = 'new visitor message') {
      const message = { id, conversation_id: row.id, sender: 'visitor', type: 'text',
        content, created_at: messages.length + 2 };
      messages.push(message);
      row.unread_count += 1;
      row.last_message = content;
      row.last_message_at = message.created_at;
      await page.evaluate(message => window.fixtureSocket.receive('new_message', message), message);
      await page.waitForFunction(id => document.querySelector('[data-msg-id="' + id + '"]'), id);
    }
    await incoming('visitor-off-focus');
    await page.waitForFunction(() => document.querySelector('.conv-unread')?.textContent === '1');
    assert.deepEqual(readRequests, [], 'unfocused desktop must preserve the mobile unread badge');
    await page.evaluate(() => { window.fixtureFocused = true; window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => !document.querySelector('.conv-unread'));
    assert.equal(readRequests.at(-1), 'visitor-off-focus');

    await page.evaluate(() => { window.fixtureHidden = true; });
    await incoming('visitor-background');
    await page.waitForFunction(() => document.querySelector('.conv-unread')?.textContent === '1');
    assert.equal(readRequests.length, 1, 'hidden tab cannot mark incoming messages read');
    await page.evaluate(() => {
      window.fixtureHidden = false;
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForFunction(() => !document.querySelector('.conv-unread'));
    assert.equal(readRequests.at(-1), 'visitor-background');

    await page.evaluate(() => { window.fixtureFocused = false; });
    await page.setViewportSize({ width: 1400, height: 400 });
    await incoming('visitor-long-history', 'history line\n'.repeat(60));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      window.fixtureFocused = true;
      document.getElementById('chat-messages').scrollTop = 0;
    });
    const before = readRequests.length;
    await incoming('visitor-while-reading-history');
    await page.waitForFunction(() => document.querySelector('.conv-unread')?.textContent === '2');
    assert.equal(readRequests.length, before, 'reading history must retain unread');
    await page.evaluate(() => {
      const box = document.getElementById('chat-messages');
      box.scrollTop = box.scrollHeight;
      box.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction(() => !document.querySelector('.conv-unread'));
    assert.equal(readRequests.at(-1), 'visitor-while-reading-history');
    assert.deepEqual(errors, []);
    console.log('PASS: Chat title; unfocused/hidden/history states preserve unread; visible bottom acknowledges only rendered messages');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
