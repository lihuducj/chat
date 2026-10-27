// 隔离浏览器回归测试：不启动服务端，不连接真实客户或发送真实消息。
// 需要测试环境安装 Playwright 和 Chromium；运行 node server/tests/widget-interactions.cjs。
// 可用 CHAT_TEST_PLAYWRIGHT / CHAT_TEST_BROWSER 指定已有的测试依赖和浏览器。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.CHAT_TEST_PLAYWRIGHT || 'playwright');
const widget = fs.readFileSync(process.env.CHAT_TEST_WIDGET || path.join(__dirname, '../public/widget.js'), 'utf8');
const useWebSocket = process.env.CHAT_TEST_TRANSPORT === 'websocket';
const origin = 'https://widget-test.invalid';
const visitor = { visitorId: 'testvisitor123456', visitorSecret: 'testsecret123456789', conversationId: 'testconversation' };
const menu = Array.from({ length: 12 }, (_, index) => ({
  title: '帮助菜单 ' + (index + 1),
  children: [{ title: '常见问题', content: '这是解答，<img src=x onerror=alert(1)> 应显示为文字。' }]
}));
const message = (id, sender = 'visitor', content = '客户咨询 ' + id, type = 'text') => ({
  id, sender, content, type, created_at: Date.now()
});
const history = [message('first'), ...Array.from({ length: 16 }, (_, i) => message('agent-' + i, 'agent', '客服回复\n第二行\n第三行'))];

const socketScript = `
  window.io = function (server, options) {
    var listeners = {};
    var socket = window.__testSocket = {
      connected: true, outgoing: [],
      on: function (event, callback) { listeners[event] = callback; return this; },
      receive: function (event, data) { if (listeners[event]) listeners[event](data); },
      timeout: function () { return this; },
      emit: function (event, data, callback) {
        this.outgoing.push({ event: event, data: data });
        if (event === 'visitor_message') {
          queueMicrotask(function () {
            if (window.__testAutoEcho) socket.receive('new_message', {
              id: data.clientMessageId, sender: 'visitor', type: data.type,
              content: data.content, created_at: Date.now()
            });
            if (callback) callback(null, { ok: true, messageId: data.clientMessageId });
          });
        }
        return this;
      }
    };
    options.auth(function (auth) { window.__testAuth = auth; });
    queueMicrotask(function () {
      socket.receive('connect');
      socket.receive('session_info', window.__testVisitor);
      socket.receive('history', window.__testHistory);
      window.__testReady = true;
    });
    return socket;
  };
`;

// Exercise the CF adapter without contacting customer data or a remote Worker.
const webSocketScript = `
  window.WebSocket = class TestWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.readyState = 1;
      var ws = this;
      var socket = window.__testSocket = {
        outgoing: [],
        receive: function (event, data) {
          var message = event === 'history' ? { type: event, messages: data }
            : event === 'new_message' ? { type: event, message: data }
            : Object.assign({ type: event }, data || {});
          if (ws.onmessage) ws.onmessage({ data: JSON.stringify(message) });
        }
      };
      this.testSocket = socket;
      window.__testAuth = Object.fromEntries(new URL(url).searchParams);
      queueMicrotask(function () {
        if (ws.onopen) ws.onopen();
        socket.receive('session_info', window.__testVisitor);
        socket.receive('history', window.__testHistory);
        window.__testReady = true;
      });
    }
    send(raw) {
      var data = JSON.parse(raw);
      var socket = this.testSocket;
      socket.outgoing.push({ event: data.action, data: data.payload });
      if (data.action === 'visitor_message') {
        queueMicrotask(function () {
          if (window.__testAutoEcho) socket.receive('new_message', {
            id: data.payload.clientMessageId, sender: 'visitor', type: data.payload.type,
            content: data.payload.content, created_at: Date.now()
          });
          if (data.requestId) socket.receive('ack', {
            requestId: data.requestId, ok: true, messageId: data.payload.clientMessageId
          });
        });
      }
    }
    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose();
    }
  };
`;

async function start(page, options = {}) {
  await page.goto(origin);
  await page.evaluate(({ visitor, history, email, autoEcho }) => {
    if (email !== undefined) localStorage.setItem('myservice_visitor', JSON.stringify({ ...visitor, email }));
    window.MYSERVICE_CONFIG = { server: location.origin };
    window.__testVisitor = visitor;
    window.__testHistory = history;
    window.__testAutoEcho = autoEcho;
  }, { visitor, history: options.history || [], email: options.email, autoEcho: options.autoEcho !== false });
  await page.addScriptTag({ content: widget });
  await page.waitForFunction(() => window.__testReady);
  await page.locator('#ms-launcher').click();
  await settle(page);
}

async function fixture(browser, options = {}) {
  const page = await browser.newPage({
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1100, height: 850 },
    isMobile: !!options.mobile, hasTouch: !!options.mobile
  });
  page.on('pageerror', error => { errors.push(error.message); });
  if (useWebSocket) await page.addInitScript({ content: webSocketScript });
  await page.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>测试页面</title><body></body>' });
    if (pathname === '/api/widget-config') return route.fulfill({ json: { menu: options.menu === undefined ? menu : options.menu } });
    if (pathname === '/socket.io/socket.io.js') return route.fulfill({ contentType: 'application/javascript', body: socketScript });
    return route.abort();
  });
  await start(page, options);
  return page;
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}
async function receive(page, event, data) {
  await page.evaluate(({ event, data }) => window.__testSocket.receive(event, data), { event, data });
  await settle(page);
}
async function send(page, text) {
  await page.locator('#ms-input').fill(text);
  await page.locator('#ms-send').click();
  await settle(page);
}
async function scrollToMenu(page) {
  await page.locator('#ms-messages').dispatchEvent('wheel');
  await page.locator('#ms-messages').evaluate(el => { el.scrollTop = 0; });
  await settle(page);
}
async function count(page, selector, expected) {
  assert.equal(await page.locator(selector).count(), expected, selector);
}
async function checkMenuLayout(page) {
  const layout = await page.evaluate(() => {
    const scroller = document.getElementById('ms-messages');
    const menu = document.getElementById('ms-menu-view');
    const first = scroller.querySelector('.ms-row[data-msg-id]');
    return {
      display: getComputedStyle(menu).display,
      position: getComputedStyle(menu).position,
      nestedScroll: menu.scrollHeight > menu.clientHeight + 1,
      firstChild: scroller.firstElementChild === menu,
      overlap: first && menu.getBoundingClientRect().bottom > first.getBoundingClientRect().top + 1
    };
  });
  assert.deepEqual(layout, { display: 'flex', position: 'static', nestedScroll: false, firstChild: true, overlap: false });
}
async function outgoing(page, event) {
  return page.evaluate(event => window.__testSocket.outgoing.filter(item => item.event === event), event);
}

const errors = [];
async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_TEST_BROWSER || undefined });
  try {
    for (const mobile of [false, true]) {
      const page = await fixture(browser, { mobile, email: '' });
      assert.equal(await page.locator('#ms-attach').getAttribute('title'), '发送图片');
      assert.equal(await page.locator('#ms-file').getAttribute('accept'), 'image/jpeg,image/png,image/webp,image/gif');
      let attemptedUploads = 0;
      page.on('request', req => { if (new URL(req.url()).pathname === '/api/upload') attemptedUploads++; });
      await page.locator('#ms-file').setInputFiles({ name: 'blocked.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
      assert.equal(await page.getByText('只能发送 JPG、PNG、WebP、GIF 图片').count(), 1);
      assert.equal(attemptedUploads, 0, 'file upload is rejected before network access');
      await page.locator('#ms-messages').evaluate(el => { el.scrollTop = 0; });
      assert.equal(await page.locator('#ms-messages').evaluate(el => el.scrollTop), 0, '长菜单从第一项展示');
      await send(page, '第一条咨询');
      await checkMenuLayout(page);
      await count(page, '.ms-row[data-msg-id]', 1);
      await count(page, '.ms-gate-card', 1);
      await page.locator('.ms-gate-skip').click();
      await count(page, '.ms-email-prompt', 1);
      assert.equal(await page.locator('.ms-email-prompt').evaluate(el => el.previousElementSibling.hasAttribute('data-msg-id')), true);
      if (process.env.CHAT_TEST_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CHAT_TEST_SCREENSHOTS, mobile ? 'email-mobile.png' : 'email-desktop.png') });
      for (let i = 0; i < 3; i++) {
        await page.locator('.ms-email-action').click();
        await count(page, '.ms-gate-card', 1);
        await page.locator('.ms-gate-skip').click();
        await count(page, '.ms-email-prompt', 1);
      }
      assert.equal((await outgoing(page, 'visitor_message')).length, 1, '提示不作为消息发送');
      assert.equal((await outgoing(page, 'visitor_info')).length, 0);
      await send(page, '稍后再填写');
      await count(page, '.ms-gate-card', 0);
      await page.locator('.ms-email-action').click();
      await page.locator('.ms-gate-card input').fill('bad-email');
      await page.locator('.ms-gate-submit').click();
      assert.equal(await page.locator('.ms-gate-err').isVisible(), true);
      await count(page, '.ms-gate-card', 1);
      await page.locator('.ms-gate-card input').fill('visitor@example.test');
      await page.locator('.ms-gate-card input').press('Enter');
      await count(page, '.ms-gate-card', 0);
      await count(page, '.ms-email-prompt', 0);
      assert.equal((await outgoing(page, 'visitor_info'))[0].data.email, 'visitor@example.test');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('myservice_visitor')).email), 'visitor@example.test');
      await send(page, '填写后继续聊天');
      await count(page, '.ms-gate-card', 0);
      await receive(page, 'history', history);
      await count(page, '.ms-email-prompt', 0);
      await scrollToMenu(page);
      await checkMenuLayout(page);
      await page.locator('.ms-menu-pill').first().click();
      await page.locator('.ms-menu-pill').first().click();
      await count(page, '.ms-menu-answer', 1);
      await count(page, '.ms-menu-answer img', 0);
      await page.locator('.ms-menu-back').click();
      await page.locator('.ms-menu-back').click();
      await count(page, '.ms-menu-pill', 12);
      if (process.env.CHAT_TEST_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.CHAT_TEST_SCREENSHOTS, mobile ? 'widget-mobile.png' : 'widget-desktop.png') });
      await page.close();
      console.log('PASS ' + (mobile ? 'mobile' : 'desktop') + ': menu layout, send, skip/reopen, validation, save, nested menus');
    }

    const reconnect = await fixture(browser, { email: '' });
    await send(reconnect, '测试重连');
    const first = await reconnect.evaluate(() => {
      const sent = window.__testSocket.outgoing.find(item => item.event === 'visitor_message').data;
      return { id: sent.clientMessageId, sender: 'visitor', content: sent.content, type: 'text', created_at: Date.now() };
    });
    await reconnect.locator('.ms-gate-skip').click();
    const replay = [first, ...history.slice(1)];
    await receive(reconnect, 'history', replay);
    await count(reconnect, '.ms-row[data-msg-id]', replay.length);
    await count(reconnect, '.ms-email-prompt', 1);
    assert.equal(await reconnect.locator('.ms-email-prompt').evaluate(el => el.previousElementSibling.getAttribute('data-msg-id')), first.id);
    await scrollToMenu(reconnect);
    await reconnect.locator('.ms-menu-pill').first().click();
    await receive(reconnect, 'disconnect');
    await receive(reconnect, 'connect');
    await receive(reconnect, 'history', replay);
    await count(reconnect, '.ms-menu-pill', 1);
    assert.equal(await reconnect.locator('#ms-messages').evaluate(el => el.scrollTop), 0, '重连不打断菜单阅读');
    await receive(reconnect, 'new_message', message('fresh', 'agent'));
    assert.equal(await reconnect.locator('#ms-messages').evaluate(el => el.scrollTop), 0, '新消息不把正在阅读菜单的客户拉到底部');
    assert.equal(await reconnect.title(), '【1条新消息】测试页面', '看菜单时仍有未读提醒');
    assert.equal(await reconnect.evaluate(() => window.__testSocket.outgoing.at(-1).event), 'visitor_delivered', '看菜单时只标记送达');
    await reconnect.locator('#ms-messages').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await settle(reconnect);
    assert.equal(await reconnect.title(), '测试页面');
    assert.equal(await reconnect.evaluate(() => window.__testSocket.outgoing.at(-1).event), 'visitor_read', '回到底部才标记已读');
    await receive(reconnect, 'new_message', first);
    await count(reconnect, '.ms-row[data-msg-id]', replay.length + 1);
    await count(reconnect, '.ms-email-prompt', 1);
    await start(reconnect, { history: replay });
    await checkMenuLayout(reconnect);
    await count(reconnect, '.ms-email-prompt', 1);
    await count(reconnect, '.ms-gate-card', 0);
    await reconnect.locator('.ms-email-action').click();
    await count(reconnect, '.ms-gate-card', 1);
    await reconnect.close();
    console.log('PASS reconnect/refresh: prompt order, no duplicates, menu navigation/scroll retained, email can reopen');

    const delayed = await fixture(browser, { email: '', autoEcho: false, menu: [] });
    await send(delayed, '延迟回显');
    await delayed.locator('.ms-gate-skip').click();
    await count(delayed, '.ms-email-prompt', 1);
    await receive(delayed, 'new_message', message('delayed'));
    assert.equal(await delayed.locator('.ms-email-prompt').evaluate(el => el.previousElementSibling.getAttribute('data-msg-id')), 'delayed');
    assert.equal(await delayed.locator('#ms-menu-view').isVisible(), false);
    await delayed.close();
    console.log('PASS slow echo / empty menu: prompt stays after message, no empty menu space');

    const longMenu = await fixture(browser, { email: '', autoEcho: false });
    await send(longMenu, '慢网络');
    await longMenu.locator('.ms-gate-skip').click();
    assert.equal(await longMenu.locator('.ms-email-prompt').evaluate(el => {
      const prompt = el.getBoundingClientRect();
      const viewport = document.getElementById('ms-messages').getBoundingClientRect();
      return prompt.top >= viewport.top && prompt.bottom <= viewport.bottom;
    }), true, '即使回显未到，跳过后的提示也出现在可见区');
    await longMenu.close();
    console.log('PASS slow echo / long menu: skipped email prompt immediately visible');

    const images = await fixture(browser, { email: 'existing@example.test', history });
    let releaseImage;
    const imageRequested = new Promise(resolve => {
      images.route('**/slow-image.svg', route => { releaseImage = route; resolve(); });
    });
    await receive(images, 'new_message', message('image', 'agent', '/slow-image.svg', 'image'));
    await imageRequested;
    await scrollToMenu(images);
    await releaseImage.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="gray"/></svg>' });
    await images.waitForFunction(() => document.querySelector('.ms-bubble img').complete);
    await settle(images);
    assert.equal(await images.locator('#ms-messages').evaluate(el => el.scrollTop), 0, '图片加载完成不把客户从菜单拉走');
    await images.close();
    console.log('PASS slow image: pending bottom-scroll cancelled when customer reads menu');
    if (!useWebSocket) {
      const boundary = await fixture(browser, { email: 'existing@example.test', menu: [] });
      const fullText = '开头' + '中'.repeat(99996) + '末尾';
      await send(boundary, fullText);
      assert.equal((await outgoing(boundary, 'visitor_message'))[0].data.content, fullText);
      assert.equal(await boundary.locator('#ms-input').inputValue(), '');
      await send(boundary, fullText + '多');
      assert.equal((await outgoing(boundary, 'visitor_message')).length, 1, '超限不发送');
      assert.equal(await boundary.locator('#ms-input').inputValue(), fullText + '多', '超限保留草稿');
      await receive(boundary, 'new_message', message('long-agent-message', 'agent', fullText));
      assert.ok((await boundary.locator('[data-msg-id="long-agent-message"]').textContent()).includes(fullText), '完整接收十万字符');
      await boundary.close();
      console.log('PASS message boundary: 100k Chinese sent/received intact, excess blocked with draft retained');
    }
    assert.deepEqual(errors, [], '无浏览器脚本异常');
    console.log('All widget interaction checks passed.');
  } finally {
    await browser.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
