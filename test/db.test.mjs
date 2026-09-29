// 表结构与迁移：node test/db.test.mjs
//
// 【为什么必须有这个测试】ensureSchema 在**每个请求**上都会跑一次。
// 刚部署、第一个请求进来时，浏览器扩展的轮询、面板页面、定时任务往往是同时到的：
// 几个请求会一起跑同一批迁移。检查「列存不存在」和真的 ALTER 之间有窗口，
// 后来者就会撞上 `duplicate column name` / `table already exists` —— 那说明目的已经达成，
// 不该让这个请求 500（用户看到的就是「刚部署完面板报错」）。
import assert from 'node:assert/strict';
import { ensureSchema, getSetting, setSetting } from '../src/db.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// ---- 极简 D1 仿真：真的会因重复建表/重复加列而报错 ----
function makeDb({ columns = {}, tables = new Set() } = {}) {
  const kv = new Map();
  const state = { columns, tables };
  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  return {
    state,
    prepare(sqlRaw) {
      const sql = norm(sqlRaw);
      const stmt = {
        _args: [],
        _sql: sql,
        bind(...a) { stmt._args = a; return stmt; },
        async first() {
          if (/^SELECT value FROM settings/i.test(sql)) {
            const m = sql.match(/key\s*=\s*'([^']+)'/i);
            const k = m ? m[1] : stmt._args[0];
            const v = kv.get(k);
            return v === undefined ? null : { value: v };
          }
          return null;
        },
        async all() {
          const m = sql.match(/^PRAGMA table_info\((\w+)\)/i);
          if (m) return { results: (state.columns[m[1]] || []).map((name) => ({ name })) };
          return { results: [] };
        },
        async run() {
          const a = stmt._args;
          const create = sql.match(/^CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/i);
          if (create) {
            const name = create[1];
            if (state.tables.has(name)) throw new Error(`table ${name} already exists`);
            state.tables.add(name);
            return { meta: { changes: 1 } };
          }
          const alter = sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
          if (alter) {
            const [, table, col] = alter;
            state.columns[table] = state.columns[table] || [];
            if (state.columns[table].includes(col)) throw new Error(`duplicate column name: ${col}`);
            state.columns[table].push(col);
            return { meta: { changes: 1 } };
          }
          // setSetting 用的是 UPSERT（key/value 都是 bind 的）：INSERT … VALUES(?, ?) ON CONFLICT…
          if (/^INSERT INTO settings\s*\(\s*key\s*,\s*value\s*\)\s*VALUES\s*\(\s*\?\s*,\s*\?\s*\)/i.test(sql)) {
            kv.set(a[0], a[1]);
            return { meta: { changes: 1 } };
          }
          // crypto.js / ensureSchema 里那种把 key 写在 SQL 里的写法
          const ins = sql.match(/settings\s*\(\s*key\s*,\s*value\s*\)\s*VALUES\s*\(\s*'([^']+)'/i);
          if (ins) { kv.set(ins[1], a[0]); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    // 建表走的是 batch（ensureSchema 开头那批发语句），仿真里也要如实记进去
    async batch(stmts) {
      for (const st of stmts || []) {
        const m = String(st && st._sql || '').match(/^CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/i);
        if (m) state.tables.add(m[1]);
      }
      return (stmts || []).map(() => ({ meta: { changes: 1 } }));
    },
  };
}

await t('并发冷启动：两个请求同时跑迁移，都不该报「已存在 / 重复列」', async () => {
  const db = makeDb();
  // 两个「请求」同时进来 —— 老代码在这里会有一个抛 already exists / duplicate column
  await Promise.all([ensureSchema(db), ensureSchema(db)]);
  assert.ok(db.state.tables.has('settings'));
  assert.ok((db.state.columns.accounts || []).includes('meta'));
  assert.ok((db.state.columns.accounts || []).includes('last_detail'));
});

await t('迁移断点续跑：schema_version 记到哪，下次就从哪继续', async () => {
  const db = makeDb();
  await ensureSchema(db);
  const v1 = await getSetting(db, 'schema_version');
  await ensureSchema(db); // 再来一次应当无事发生（幂等）
  assert.equal(await getSetting(db, 'schema_version'), v1);
  assert.ok(Number(v1) >= 11, '迁移版本号应被记录，当前 ' + v1);
});

await t('真正的迁移错误照样要抛出来，不能被并发容错吞掉', async () => {
  const db = makeDb();
  db.prepare = (sqlRaw) => {
    const sql = String(sqlRaw).replace(/\s+/g, ' ').trim();
    const stmt = {
      _args: [],
      bind(...a) { stmt._args = a; return stmt; },
      async first() { return null; },
      async all() { return { results: [] }; },
      async run() {
        if (/^ALTER TABLE/i.test(sql) || /^CREATE TABLE/i.test(sql)) throw new Error('disk I/O error');
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };
  db.batch = async () => [];
  const err = await ensureSchema(db).then(() => null, (e) => e);
  assert.ok(err instanceof Error, '不该把磁盘错误也吞掉');
  assert.match(err.message, /disk I\/O error/);
});

await t('setSetting 是 UPSERT：重复写同一个 key 不会报错', async () => {
  const db = makeDb();
  await setSetting(db, 'schedule_time', '08');
  await setSetting(db, 'schedule_time', '09:30');
  assert.equal(await getSetting(db, 'schedule_time'), '09:30');
  assert.equal(await getSetting(db, 'not_exist'), null);
});

console.log(`\n${n} 组通过`);
