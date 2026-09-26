// D1 表结构与 settings 读写。首次请求时自动建表，无需手动迁移。

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
