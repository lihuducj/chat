/**
 * 清理数据库里已经存在的重复消息（比如Crisp导入脚本以前那个bug产生的）。
 *
 * 用法：
 *   node scripts/dedup-messages.js --dry-run   # 先看看会删掉哪些，不会真的删
 *   node scripts/dedup-messages.js             # 确认没问题后正式删除
 *
 * 判断"重复"的标准：同一个会话里，发送方、类型、内容、发送时间(精确到毫秒)都完全一样，
 * 只保留最早插入的那一条，其余的删掉。
 */

require('dotenv').config();
const db = require('../db');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const rows = db.prepare(`
  SELECT id, conversation_id, sender, type, content, created_at, rowid
  FROM messages
  ORDER BY conversation_id, created_at, rowid
`).all();

const seen = new Map(); // key -> 第一次出现的那条消息id（保留的）
const toDelete = [];

for (const row of rows) {
  const key = [row.conversation_id, row.sender, row.type, row.content, row.created_at].join('|||');
  if (seen.has(key)) {
    toDelete.push(row.id);
  } else {
    seen.set(key, row.id);
  }
}

console.log(`总消息数: ${rows.length}`);
console.log(`发现重复: ${toDelete.length} 条`);

if (toDelete.length === 0) {
  console.log('没有发现重复消息，不用清理。');
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\n[空跑] 会被删除的消息ID（前20条预览）:');
  toDelete.slice(0, 20).forEach((id) => console.log(' - ' + id));
  console.log('\n确认没问题后，去掉 --dry-run 正式删除。');
} else {
  const delStmt = db.prepare('DELETE FROM messages WHERE id = ?');
  const tx = db.transaction(() => {
    toDelete.forEach((id) => delStmt.run(id));
  });
  tx();
  console.log(`✅ 已删除 ${toDelete.length} 条重复消息。`);
}
