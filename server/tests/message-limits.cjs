// node --test server/tests/message-limits.cjs (no external dependencies).
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  MAX_TEXT_LENGTH, MAX_MESSAGE_BODY_BYTES, MESSAGE_TOO_LONG, sanitizeMessagePayload
} = require('../message-validation');

for (const [label, content] of [
  ['ASCII', 'a'.repeat(100000)],
  ['Chinese', '中'.repeat(100000)],
  ['emoji', '😀'.repeat(50000)],
  ['JSON escapes', '\u0000'.repeat(100000)],
  ['quote plus body', '「引用」\n' + '文'.repeat(99995)]
]) {
  test(`${label}: exactly 100000 UTF-16 units are preserved`, () => {
    assert.equal(MAX_TEXT_LENGTH, 100000);
    assert.equal(content.length, MAX_TEXT_LENGTH);
    const payload = { type: 'text', content, clientMessageId: 'test-limit' };
    const result = sanitizeMessagePayload(payload);
    assert.equal(result.content, content);
    assert.equal(result.type, 'text');
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < MAX_MESSAGE_BODY_BYTES);
    const rejected = sanitizeMessagePayload({ ...payload, content: content + 'x' });
    assert.equal(rejected.code, 'MESSAGE_TOO_LONG');
    assert.equal(rejected.error, MESSAGE_TOO_LONG);
    assert.equal(rejected.content, undefined, 'never return truncated content');
  });
}

test('trim, invalid messages, and attachment validation stay intact', () => {
  assert.equal(sanitizeMessagePayload({ type: 'text', content: ' \n test \t' }).content, 'test');
  assert.equal(sanitizeMessagePayload({ content: '   \n' }), null);
  assert.equal(sanitizeMessagePayload({ content: 123 }), null);
  assert.equal(sanitizeMessagePayload(null), null);
  assert.equal(sanitizeMessagePayload({ type: 'image', content: 'https://untrusted.test/a.jpg' }), null);
  assert.equal(sanitizeMessagePayload({ type: 'file', content: '/uploads/../secret.txt' }), null);
  const file = sanitizeMessagePayload({ type: 'file', content: '/uploads/test-file.pdf', fileName: 'a'.repeat(250), fileSize: 25 });
  assert.equal(file.content, '/uploads/test-file.pdf');
  assert.equal(file.fileName.length, 200);
  assert.equal(file.fileSize, 25);
});

test('web agent guards body plus quote before clearing the draft', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../admin/app.js'), 'utf8');
  const sendFunction = source.slice(source.indexOf('function sendText() {'), source.indexOf('\nconst sendBtn ='));
  assert.ok(sendFunction.includes('MAX_TEXT_LENGTH'));
  let sent = [];
  let alerts = [];
  const context = {
    MAX_TEXT_LENGTH, activeConvId: 'test', quotedText: '引用',
    chatInput: { value: '文'.repeat(99996), focus() {} },
    makeClientMessageId: () => 'web-test',
    sendAgentSocketMessage: payload => sent.push(payload),
    autoGrowChatInput() {}, clearQuote() { context.quotedText = null; },
    alert: message => alerts.push(message)
  };
  vm.createContext(context);
  vm.runInContext(sendFunction + '\nsendText();', context);
  assert.equal(sent.length, 0);
  assert.equal(alerts[0], MESSAGE_TOO_LONG);
  assert.equal(context.chatInput.value.length, 99996);
  assert.equal(context.quotedText, '引用');
  context.chatInput.value = '文'.repeat(99995);
  vm.runInContext('sendText();', context);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content.length, 100000);
  assert.equal(context.chatInput.value, '');
});

test('iOS sender uses the same UTF-16 boundary as JS', () => {
  const swift = fs.readFileSync(path.join(__dirname, '../../ios/ServiceDesk/ContentView.swift'), 'utf8');
  assert.match(swift, /guard outgoingText\.utf16\.count <= 100_000 else/);
  assert.ok(swift.includes(MESSAGE_TOO_LONG));
});
