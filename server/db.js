const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  visitor_secret TEXT,
  name TEXT,
  email TEXT,
  ip TEXT,
  user_agent TEXT,
  first_seen INTEGER,
  last_seen INTEGER,
  last_url TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  status TEXT DEFAULT 'open',      -- open | closed
  created_at INTEGER,
  last_message_at INTEGER,
  unread_count INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  tags TEXT DEFAULT '',            -- 逗号分隔
  visitor_delivered_at INTEGER DEFAULT 0,  -- 访客客户端最后一次收到消息的时间
  visitor_read_at INTEGER DEFAULT 0,       -- 访客最后一次实际打开聊天窗口查看的时间
  FOREIGN KEY (visitor_id) REFERENCES visitors(id)
);

CREATE TABLE IF NOT EXISTS canned_replies (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  parent_id TEXT,           -- NULL = 顶层菜单项
  title TEXT NOT NULL,
  content TEXT,              -- 有内容 = 叶子节点，点击直接显示这段文字；没内容但有子项 = 菜单节点，点击进入下一层
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender TEXT NOT NULL,            -- visitor | agent
  type TEXT NOT NULL DEFAULT 'text', -- text | image | file
  content TEXT,                    -- text content or file URL
  file_name TEXT,
  file_size INTEGER,
  created_at INTEGER,
  recalled INTEGER DEFAULT 0,      -- 客服撤回了这条消息：客户端不再显示，后台显示"已撤回"占位
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS push_logs (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,           -- bark | webpush
  conversation_id TEXT,
  success INTEGER NOT NULL,        -- 1成功 0失败
  detail TEXT,                     -- 成功的话是简单说明，失败的话是错误信息
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at);
CREATE INDEX IF NOT EXISTS idx_conversations_visitor ON conversations(visitor_id);
CREATE INDEX IF NOT EXISTS idx_visitors_email ON visitors(email);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_menu_items_parent ON menu_items(parent_id);
CREATE INDEX IF NOT EXISTS idx_push_logs_created ON push_logs(created_at);
`);

// 兼容旧数据库：如果是升级上来的、visitors表还没有email字段，补上
try {
  db.prepare('SELECT email FROM visitors LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE visitors ADD COLUMN email TEXT');
}

// 访客身份不能只依赖可复制/可猜测的 visitorId。随机 secret 只保存在该访客浏览器里，
// 服务端用两者共同验证历史会话归属。老数据库启动时自动补字段，旧访客下次连接时再安全生成。
try {
  db.prepare('SELECT visitor_secret FROM visitors LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE visitors ADD COLUMN visitor_secret TEXT');
}

// 兼容旧数据库：conversations表补上 notes / tags
try {
  db.prepare('SELECT notes, tags FROM conversations LIMIT 1').get();
} catch (e) {
  try { db.exec("ALTER TABLE conversations ADD COLUMN notes TEXT DEFAULT ''"); } catch (e2) {}
  try { db.exec("ALTER TABLE conversations ADD COLUMN tags TEXT DEFAULT ''"); } catch (e2) {}
}

// 兼容旧数据库：conversations表补上已读回执字段
try {
  db.prepare('SELECT visitor_delivered_at, visitor_read_at FROM conversations LIMIT 1').get();
} catch (e) {
  try { db.exec('ALTER TABLE conversations ADD COLUMN visitor_delivered_at INTEGER DEFAULT 0'); } catch (e2) {}
  try { db.exec('ALTER TABLE conversations ADD COLUMN visitor_read_at INTEGER DEFAULT 0'); } catch (e2) {}
}

// 兼容旧数据库：messages表补上撤回标记字段
try {
  db.prepare('SELECT recalled FROM messages LIMIT 1').get();
} catch (e) {
  try { db.exec('ALTER TABLE messages ADD COLUMN recalled INTEGER DEFAULT 0'); } catch (e2) {}
}

// 一次性迁移：老数据里默认叫"访客"的，换成chat123456这种编号，看着更好区分
const oldDefaultVisitors = db.prepare("SELECT id FROM visitors WHERE name = '访客' OR name IS NULL OR name = ''").all();
if (oldDefaultVisitors.length) {
  const updateStmt = db.prepare('UPDATE visitors SET name = ? WHERE id = ?');
  const tx = db.transaction(() => {
    oldDefaultVisitors.forEach((v) => {
      updateStmt.run('chat' + Math.floor(100000 + Math.random() * 900000), v.id);
    });
  });
  tx();
}

module.exports = db;
