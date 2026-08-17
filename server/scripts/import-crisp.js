/**
 * 从 Crisp 导入历史会话到本系统。
 *
 * 用法：
 *   node scripts/import-crisp.js --dry-run            # 先空跑，只打印不写库，务必先跑这个确认没问题
 *   node scripts/import-crisp.js --dry-run --limit=3  # 空跑，只看前3个会话，方便快速确认字段对不对
 *   node scripts/import-crisp.js                       # 正式导入全部历史会话
 *   node scripts/import-crisp.js --limit=50            # 正式导入，但只导入前50个会话（分批导入用）
 *
 * 需要先在 .env 里配置：
 *   CRISP_WEBSITE_ID=
 *   CRISP_TOKEN_ID=
 *   CRISP_TOKEN_KEY=
 *
 * 重要提示：
 * - 这个脚本没有在真实Crisp账号上跑过测试（我这边环境连不上api.crisp.chat），
 *   Crisp的接口字段名如果跟脚本里假设的不一致，脚本会在控制台打印出原始JSON，
 *   把报错/打印内容发给我，我再调整。
 * - 强烈建议先用 --dry-run --limit=3 看看效果，确认没问题再正式导入。
 * - 附件（图片/文件）会尝试从Crisp下载后重新保存到本系统的 uploads 目录，
 *   如果下载失败，会退化成一条文字消息（带原始链接），不会丢失这条记录本身。
 * - 导入的会话会自动打上"已导入,Crisp"标签，方便你在后台筛选区分。
 * - 脚本是幂等的：用Crisp的session_id生成固定的visitor_id/conversation_id，
 *   重复运行同一个会话不会产生重复记录（INSERT OR IGNORE），报错了可以直接重跑。
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const db = require('../db');

const WEBSITE_ID = process.env.CRISP_WEBSITE_ID;
const TOKEN_ID = process.env.CRISP_TOKEN_ID;
const TOKEN_KEY = process.env.CRISP_TOKEN_KEY;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

if (!WEBSITE_ID || !TOKEN_ID || !TOKEN_KEY) {
  console.error('❌ 请先在 .env 里配置 CRISP_WEBSITE_ID / CRISP_TOKEN_ID / CRISP_TOKEN_KEY');
  process.exit(1);
}

const AUTH_HEADER = 'Basic ' + Buffer.from(`${TOKEN_ID}:${TOKEN_KEY}`).toString('base64');

async function crispGet(pathname) {
  const res = await fetch(`https://api.crisp.chat${pathname}`, {
    headers: {
      Authorization: AUTH_HEADER,
      'X-Crisp-Tier': 'website'
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Crisp API ${res.status} ${pathname}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 下载Crisp上的附件，重新保存到本地 uploads 目录；失败返回 null
async function downloadAttachment(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const extMatch = url.match(/\.([a-zA-Z0-9]{2,5})(\?|$)/);
    const ext = extMatch ? '.' + extMatch[1] : '';
    const filename = `${nanoid()}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
    return `/uploads/${filename}`;
  } catch (e) {
    console.warn('  ⚠️ 附件下载失败，保留原链接:', url, e.message);
    return null;
  }
}

// 把Crisp消息对象转换成本系统的消息格式。
// Crisp消息字段在不同版本/不同消息类型下可能有出入，这里做了多重兜底。
async function convertMessage(raw) {
  const sender = raw.from === 'operator' ? 'agent' : 'visitor';
  const createdAt = raw.timestamp || Date.now();
  const msgType = raw.type || 'text';

  if (msgType === 'text' || msgType === undefined) {
    const content = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content || '');
    return { sender, type: 'text', content: content.slice(0, 4000), file_name: null, file_size: null, created_at: createdAt };
  }

  if (msgType === 'file' || msgType === 'picture' || msgType === 'image' || msgType === 'audio') {
    // Crisp的file/picture类型content通常是个对象：{ url, name, type, size } —— 但具体字段名可能有出入，这里多重兜底取值
    const fileInfo = typeof raw.content === 'object' ? raw.content : {};
    const originalUrl = fileInfo.url || raw.url || (typeof raw.content === 'string' ? raw.content : null);
    const fileName = fileInfo.name || raw.name || '文件';
    const isImage = msgType === 'picture' || msgType === 'image' || /\.(jpg|jpeg|png|gif|webp)$/i.test(originalUrl || '');

    if (!originalUrl) {
      return { sender, type: 'text', content: `[无法识别的附件消息，原始数据：${JSON.stringify(raw).slice(0, 300)}]`, file_name: null, file_size: null, created_at: createdAt };
    }

    const localUrl = await downloadAttachment(originalUrl);
    if (localUrl) {
      return { sender, type: isImage ? 'image' : 'file', content: localUrl, file_name: fileName, file_size: fileInfo.size || null, created_at: createdAt };
    }
    return { sender, type: 'text', content: `[附件下载失败，原链接：${originalUrl}]`, file_name: null, file_size: null, created_at: createdAt };
  }

  return { sender, type: 'text', content: `[${msgType}] ${JSON.stringify(raw.content || '').slice(0, 500)}`, file_name: null, file_size: null, created_at: createdAt };
}

async function run() {
  console.log(DRY_RUN ? '=== 空跑模式（不会写入数据库）===' : '=== 正式导入模式 ===');
  console.log('limit =', LIMIT === Infinity ? '不限制' : LIMIT);

  let page = 1;
  let imported = 0;
  let skipped = 0;

  while (imported < LIMIT) {
    console.log(`\n拉取会话列表第 ${page} 页...`);
    const list = await crispGet(`/v1/website/${WEBSITE_ID}/conversations/${page}`);
    const sessions = list.data || list;
    if (!Array.isArray(sessions) || sessions.length === 0) {
      console.log('没有更多会话了，结束。');
      break;
    }

    for (const session of sessions) {
      if (imported >= LIMIT) break;
      const sessionId = session.session_id;
      console.log(`\n--- 处理会话 ${sessionId} ---`);

      const convIdCheck = 'crisp_conv_' + sessionId.replace(/[^a-zA-Z0-9]/g, '');
      if (!DRY_RUN && db.prepare('SELECT id FROM conversations WHERE id = ?').get(convIdCheck)) {
        console.log('  （之前已经导入过，跳过，不会产生重复消息）');
        imported++;
        continue;
      }

      let messages;
      try {
        const msgRes = await crispGet(`/v1/website/${WEBSITE_ID}/conversation/${sessionId}/messages`);
        messages = msgRes.data || msgRes;
      } catch (e) {
        console.warn('  ⚠️ 拉取消息失败，跳过这个会话:', e.message);
        skipped++;
        continue;
      }
      if (!Array.isArray(messages) || messages.length === 0) {
        console.log('  （没有消息内容，跳过）');
        skipped++;
        continue;
      }

      const meta = session.meta || {};
      const email = meta.email || '';
      const nickname = meta.nickname || '';

      console.log(`  访客: ${nickname || '(无昵称)'} / ${email || '(无邮箱)'}，消息数: ${messages.length}`);
      if (DRY_RUN && imported === 0) {
        console.log('  第一条消息原始数据(供核对字段格式):', JSON.stringify(messages[0], null, 2).slice(0, 800));
      }

      const converted = [];
      for (const raw of messages) {
        converted.push(await convertMessage(raw));
        await sleep(30);
      }

      if (DRY_RUN) {
        console.log(`  [空跑] 将会导入 ${converted.length} 条消息，示例第一条:`, converted[0]);
        imported++;
        continue;
      }

      const now = Date.now();
      const visitorId = 'crisp_' + sessionId.replace(/[^a-zA-Z0-9]/g, '');
      const convId = 'crisp_conv_' + sessionId.replace(/[^a-zA-Z0-9]/g, '');
      const firstTs = converted[0].created_at || now;
      const lastTs = converted[converted.length - 1].created_at || now;

      db.prepare(`INSERT OR IGNORE INTO visitors (id, name, email, ip, user_agent, first_seen, last_seen, last_url)
        VALUES (?, ?, ?, '', '', ?, ?, '')`).run(visitorId, nickname || ('crisp' + Math.floor(100000 + Math.random() * 900000)), email, firstTs, lastTs);

      db.prepare(`INSERT OR IGNORE INTO conversations (id, visitor_id, status, created_at, last_message_at, unread_count, notes, tags)
        VALUES (?, ?, 'closed', ?, ?, 0, ?, ?)`).run(convId, visitorId, firstTs, lastTs, '从Crisp导入', '已导入,Crisp');

      const insertMsg = db.prepare(`INSERT INTO messages (id, conversation_id, sender, type, content, file_name, file_size, created_at)
        VALUES (@id, @conversation_id, @sender, @type, @content, @file_name, @file_size, @created_at)`);
      const tx = db.transaction(() => {
        converted.forEach((m) => {
          insertMsg.run({
            id: nanoid(),
            conversation_id: convId,
            sender: m.sender,
            type: m.type,
            content: m.content,
            file_name: m.file_name,
            file_size: m.file_size,
            created_at: m.created_at
          });
        });
      });
      tx();

      console.log(`  ✅ 已导入 ${converted.length} 条消息`);
      imported++;
      await sleep(200);
    }

    page++;
  }

  console.log(`\n=== 完成：处理了 ${imported} 个会话，跳过 ${skipped} 个（无消息/拉取失败）===`);
  if (DRY_RUN) console.log('这是空跑结果，确认没问题后去掉 --dry-run 正式导入。');
}

run().catch((e) => {
  console.error('❌ 导入过程出错:', e.message);
  console.error(e.stack);
  process.exit(1);
});
