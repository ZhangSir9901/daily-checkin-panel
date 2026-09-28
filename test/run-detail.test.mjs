// 运行日志 detail（网站原始回馈）测试：node test/run-detail.test.mjs
import assert from 'node:assert/strict';
import { ensureSchema } from '../src/db.js';
import { encryptJSON } from '../src/crypto.js';
import { runAccount } from '../src/runner.js';
import { nodeseek } from '../src/sites/nodeseek.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// ---- 极简 D1 fake：只记录 SQL，模拟老库（runs 表没有 detail 列）----
function fakeDbNoDetail() {
  const sqls = [];
  const db = {
    sqls,
    prepare(sql) {
      sqls.push(sql);
      const stmt = {
        bind() { return stmt; },
        async run() { return {}; },
        async all() {
          if (/PRAGMA table_info\(runs\)/i.test(sql)) {
            return { results: [{ name: 'id' }, { name: 'account_id' }, { name: 'message' }] };
          }
          if (/PRAGMA table_info/i.test(sql)) return { results: [{ name: 'id' }] };
          return { results: [] };
        },
        async first() { return null; },
      };
      return stmt;
    },
    async batch(stmts) { return []; },
  };
  return db;
}

await t('迁移 v3：老库 runs 缺 detail 列时自动补上', async () => {
  const db = fakeDbNoDetail();
  await ensureSchema(db);
  const alters = db.sqls.filter((s) => /ALTER TABLE runs ADD COLUMN detail/i.test(s));
  assert.equal(alters.length, 1, '应执行一次补列，实际：' + JSON.stringify(db.sqls.filter((s) => /ALTER/i.test(s))));
});

await t('迁移幂等：已有 detail 列不再补', async () => {
  const db = fakeDbNoDetail();
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (/PRAGMA table_info\(runs\)/i.test(sql)) {
      const stmt = origPrepare(sql);
      stmt.all = async () => ({ results: [{ name: 'id' }, { name: 'detail' }] });
      return stmt;
    }
    return origPrepare(sql);
  };
  await ensureSchema(db);
  const alters = db.sqls.filter((s) => /ALTER TABLE runs ADD COLUMN detail/i.test(s));
  assert.equal(alters.length, 0);
});

// ---- runner：detail 写入 runs ----
function fakeDbRunner() {
  const inserted = [];
  return {
    inserted,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async run() {
          if (/INSERT INTO runs/i.test(sql)) inserted.push({ sql, args: stmt._args });
          return {};
        },
        async all() { return { results: [] }; },
        async first() { return null; },
      };
      return stmt;
    },
    async batch() { return []; },
  };
}

await t('runner：站点返回的 detail 写入 runs', async () => {
  // 用站点注册表里的 nodeseek（mock fetch 返回成功 JSON）
  const { getSite } = await import('../src/sites/index.js');
  assert.ok(getSite('nodeseek'), 'nodeseek 站点应已注册');

  const db = fakeDbRunner();
  const env = { DB: db, ENCRYPT_KEY: 'El771KvGwTGzl6K9C2dqmMOsOBYgF3LR9pIm/FvTEbs=' };
  const credsEnc = await encryptJSON(env, db, { cookie: 'a=1', random: '试试手气（随机）' });
  // nodeseek 默认 browser 执行，扩展离线时会被跳过；这里强制云端执行以验证 detail 写入
  const account = { id: 7, site: 'nodeseek', name: 'NS测试', creds: credsEnc, meta: '{"execution":"server"}', enabled: 1 };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ success: true, message: '获得 3 个鸡腿' }),
  });
  try {
    const r = await runAccount(env, account);
    assert.equal(r.status, 'ok');
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(db.inserted.length, 1);
  const args = db.inserted[0].args;
  // INSERT 列顺序：account_id, site, name, status, message, detail, duration_ms, created_at
  assert.match(args[5] || '', /网站返回.*鸡腿/, 'detail 列应存入网站原始回馈，实际：' + JSON.stringify(args[5]));
  assert.ok(/detail/.test(db.inserted[0].sql), 'INSERT 应包含 detail 列');
});

await t('runner：抛错时 e.detail 也写入 runs', async () => {
  const db = fakeDbRunner();
  const env = { DB: db, ENCRYPT_KEY: 'El771KvGwTGzl6K9C2dqmMOsOBYgF3LR9pIm/FvTEbs=' };
  const credsEnc = await encryptJSON(env, db, { cookie: 'a=1' });
  const account = { id: 8, site: 'nodeseek', name: 'NS测试2', creds: credsEnc, meta: '{"execution":"server"}', enabled: 1 };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    text: async () => JSON.stringify({ success: false, message: '参数错误' }),
  });
  try {
    const r = await runAccount(env, account);
    assert.equal(r.status, 'fail');
  } finally {
    globalThis.fetch = origFetch;
  }
  const args = db.inserted[0].args;
  assert.match(args[5] || '', /网站返回/, '失败时 detail 也应写入');
});

// ---- runner：本地网络中继（长轮询版）不应该再给消息加 [中继] 前缀 ----
// 线上现象：NodeSeek 的日志显示「[中继] 今日已签到，不能重复签到」，用户不想要这个内部标记。
function fakeDbRelay() {
  const inserted = [];
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ success: false, message: '今天已完成签到，请勿重复操作' }), 'utf8').toString('base64');
  return {
    inserted,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async run() {
          if (/INSERT INTO runs/i.test(sql)) inserted.push({ sql, args: stmt._args });
          return {};
        },
        async all() { return { results: [] }; },
        async first() {
          if (/FROM settings/i.test(sql)) return { value: String(now) }; // relay_last_poll → 扩展在线
          if (/FROM relay_jobs/i.test(sql)) {
            return { status: 'done', resp_status: 200, resp_headers: '{}', resp_body: body };
          }
          return null;
        },
      };
      return stmt;
    },
    async batch() { return []; },
  };
}

await t('runner：中继模式的消息不带 [中继] 前缀，且站点拿得到 ctx.relayDb', async () => {
  const db = fakeDbRelay();
  const env = { DB: db, ENCRYPT_KEY: 'El771KvGwTGzl6K9C2dqmMOsOBYgF3LR9pIm/FvTEbs=' };
  const credsEnc = await encryptJSON(env, db, { cookie: 'a=1' });
  const account = { id: 9, site: 'nodeseek', name: 'NS中继', creds: credsEnc, meta: '{"execution":"relay"}', enabled: 1 };
  const r = await runAccount(env, account);
  assert.equal(r.status, 'ok');
  assert.doesNotMatch(r.message, /\[中继\]/, '消息里不应再出现 [中继]，实际：' + r.message);
  // 主文案必须是**网站原话**（NodeSeek 对已签到回「今天已完成签到，请勿重复操作」），
  // 而不是我们归纳的「今日已签到，不能重复签到」—— 面板「网站反馈」展示的就是这句
  assert.equal(r.message, '今天已完成签到，请勿重复操作');
  assert.equal(db.inserted.length, 1);
});

// ---- runner：按站点自己的「一天」记 last_signin_date ----
// 线上真实现象（糊涂鳄）：面板按北京时间记「今天」，站点却按 UTC 计日（北京时间 08:00 才重置），
// 于是 08:00 之后面板仍显示「已签到」，用户去网站手动点签到却能再领一次积分，看起来就像「假签到」。
function fakeDbMeta() {
  const metaWrites = [];
  return {
    metaWrites,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async run() {
          if (/UPDATE accounts/i.test(sql)) metaWrites.push(stmt._args[4]);
          return {};
        },
        async all() { return { results: [] }; },
        async first() { return null; },
      };
      return stmt;
    },
    async batch() { return []; },
  };
}

await t('runner：站点声明 dayTz 时按站点日界记 last_signin_date（糊涂鳄=UTC）', async () => {
  const { dayInTz } = await import('../src/schedule.js');
  const { getSite } = await import('../src/sites/index.js');
  assert.equal((getSite('hutue') || {}).dayTz, 'UTC', '糊涂鳄必须声明 dayTz=UTC（本站按 UTC 计日）');
  assert.equal((getSite('nodeseek') || {}).dayTz, undefined, '未声明的站点不能凭空多出 dayTz');

  const db = fakeDbMeta();
  const env = { DB: db, ENCRYPT_KEY: 'El771KvGwTGzl6K9C2dqmMOsOBYgF3LR9pIm/FvTEbs=' };
  const credsEnc = await encryptJSON(env, db, { site_url: 'https://dj.hutue.cn', cookie: 'c=x' });
  const account = { id: 11, site: 'hutue', name: '糊涂鳄', creds: credsEnc, meta: '{"execution":"server"}', enabled: 1 };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.endsWith('/') ? '<html>首页</html>' : JSON.stringify({ status: 1, msg: '签到成功，赠送5积分' });
    return { status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  let r;
  try {
    r = await runAccount(env, account);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(r.status, 'ok');
  assert.equal(db.metaWrites.length, 1);
  const meta = JSON.parse(db.metaWrites[0]);
  assert.equal(meta.last_signin_date, dayInTz(new Date(), 'UTC'), '糊涂鳄的「今天」应按 UTC 算，实际：' + meta.last_signin_date);
});

console.log(`\n${n} 组通过`);
