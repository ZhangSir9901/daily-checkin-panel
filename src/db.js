// D1 表结构与 settings 读写。首次请求时自动建表。
//
// 大版本更新不丢数据：
// 1. Worker 代码更新（git push → Cloudflare 自动部署）只替换脚本，D1 数据库是独立的，账号和登录信息不受影响。
// 2. 表结构变更走下面的 MIGRATIONS：CREATE TABLE IF NOT EXISTS 只负责建新表，
//    已有表的缺列用 PRAGMA 检查后 ALTER TABLE 补上（幂等），按 schema_version 顺序执行。
// 新增表结构变更时，在 MIGRATIONS 末尾追加一个函数即可，老用户升级自动补齐。

async function ensureColumn(db, table, column, ddl) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
  const cols = (results || []).map((r) => r.name);
  if (!cols.includes(column)) {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  }
}

const MIGRATIONS = [
  // v1：accounts.meta（站点独立开关等扩展字段；2026-09-26 之前建的库没有此列）
  async (db) => ensureColumn(db, 'accounts', 'meta', `TEXT NOT NULL DEFAULT '{}'`),
  // v2：runs 按账号过滤的索引（日志页筛选加速）
  async (db) => db.prepare('CREATE INDEX IF NOT EXISTS idx_runs_account ON runs(account_id, created_at DESC)').run(),
  // v3：runs.detail（网站原始回馈，日志页"网站回馈"展示用）
  async (db) => ensureColumn(db, 'runs', 'detail', 'TEXT'),
  // v4：relay_jobs（本地网络中继代理：Worker 把 HTTP 请求发给浏览器扩展，用用户本地网络执行）
  async (db) => db.prepare(`CREATE TABLE IF NOT EXISTS relay_jobs (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'GET',
    headers TEXT NOT NULL DEFAULT '{}',
    body TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    resp_status INTEGER,
    resp_headers TEXT,
    resp_body TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run(),
  async (db) => db.prepare('CREATE INDEX IF NOT EXISTS idx_relay_status ON relay_jobs(status, created_at)').run(),
  // v5：relay_jobs.options（fetch 选项透传：redirect/credentials 等）
  async (db) => ensureColumn(db, 'relay_jobs', 'options', `TEXT NOT NULL DEFAULT '{}'`),
];

export async function ensureSchema(db) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      site TEXT NOT NULL,
      creds TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      meta TEXT NOT NULL DEFAULT '{}',
      last_status TEXT,
      last_msg TEXT,
      last_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      site TEXT,
      name TEXT,
      status TEXT,
      message TEXT,
      detail TEXT,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC)`,
  ];
  await db.batch(stmts.map((s) => db.prepare(s)));

  // 增量迁移：老库补列/补索引，保证升级不丢数据
  const cur = parseInt((await getSetting(db, 'schema_version')) || '0', 10) || 0;
  for (let i = cur; i < MIGRATIONS.length; i++) {
    await MIGRATIONS[i](db);
    await setSetting(db, 'schema_version', String(i + 1));
  }
}

export async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(db, key, value) {
  await db
    .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}
