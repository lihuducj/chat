// JS length and Swift utf16.count use the same units, including emoji and quotes.
const MAX_TEXT_LENGTH = 100_000;
// 100k UTF-16 units can take up to 600k bytes after JSON escaping. Allow room
// for the message envelope, while retaining a bounded transport payload size.
const MAX_MESSAGE_BODY_BYTES = 1024 * 1024;
const MESSAGE_TOO_LONG = `消息连同引用不能超过 ${MAX_TEXT_LENGTH} 个字符，请分段发送。`;
const UPLOAD_PATH_RE = /^\/uploads\/[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,10}$/;

function sanitizeMessagePayload(payload) {
  let { type, content, fileName, fileSize } = payload || {};
  type = type === undefined ? 'text' : type;
  if (!['text', 'image', 'file'].includes(type)) {
    return { error: '不支持的消息类型', code: 'INVALID_MESSAGE_TYPE' };
  }
  content = typeof content === 'string' ? content : '';

  if (type === 'image' || type === 'file') {
    if (!UPLOAD_PATH_RE.test(content)) return null;
    fileName = typeof fileName === 'string' ? fileName.slice(0, 200) : null;
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) fileSize = null;
  } else {
    type = 'text';
    content = content.trim();
    if (content.length > MAX_TEXT_LENGTH) {
      return { error: MESSAGE_TOO_LONG, code: 'MESSAGE_TOO_LONG' };
    }
    if (!content) return null;
    fileName = null;
    fileSize = null;
  }
  return { type, content, fileName: fileName || null, fileSize: fileSize || null };
}

module.exports = { MAX_TEXT_LENGTH, MAX_MESSAGE_BODY_BYTES, MESSAGE_TOO_LONG, sanitizeMessagePayload };
