// 扩展录制小日志接口测试：node test/record-log.test.mjs
// POST /api/external/record-log（API Key 鉴权）：扩展在录制结束（抓到请求 /
// 90 秒超时 / 交接失败）时发一条小日志，面板写进 runs（site='record'），
// 「日志」页直接能看到抓到了什么、错在哪。
import assert from 'node:assert/strict';
import worker from '../src/index.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const KEY = 'k'.repeat(24);

// 极简假库：只实现 record-log 链路 + extGuard 碰到的 SQL。
function makeDb() {
  const settings = new Map([['external_api_key', KEY]]);
  const runs = [];
  let nextId = 1;
  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  const prepare = (sqlRaw) => {
    const sql = norm(sqlRaw);
    const stmt = {
      _args: [],
      bind(...a) { stmt._args = a; return stmt; },
      async first() {
        if (/^SELECT value FROM settings WHERE key = \?/i.test(sql)) {
          const v = settings.get(stmt._args[0]);
          return v === undefined ? null : { value: v };
        }
        return null;
      },
      async all() {
        if (/^SELECT \* FROM runs/i.test(sql)) {
          return { results: [...runs].sort((a, b) => b.id - a.id) };
        }
        return { results: [] };
      },
      async run() {
        if (/^INSERT INTO settings/i.test(sql)) {
          settings.set(stmt._args[0], stmt._args[1]);
          return {};
        }
        if (/^INSERT INTO runs/i.test(sql)) {
          const [account_id, site, name, status, message, detail, duration_ms, created_at] = stmt._args;
          runs.push({ id: nextId++, account_id, site, name, status, message, detail, duration_ms, created_at });
          return {};
        }
        if (/^DELETE FROM runs WHERE site = 'record'/i.test(sql)) {
          const recIds = runs.filter((r) => r.site === 'record').map((r) => r.id).sort((a, b) => b - a);
          const keep = new Set(recIds.slice(0, 100));
          for (let i = runs.length - 1; i >= 0; i--) {
            if (runs[i].site === 'record' && !keep.has(runs[i].id)) runs.splice(i, 1);
          }
          return {};
        }
        return {};
      },
    };
    return stmt;
  };
  const db = { prepare, batch: async (ss) => { for (const s of ss) await s.run(); } };
  db.__runs = runs;
  db.__bumpId = (v) => { nextId = v; };
  db.__env = { DB: db };
  return db;
}

async function call(db, method, path, { body, key } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['X-Api-Key'] = key;
  const res = await worker.fetch(new Request('https://panel.example' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), db.__env, {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

await t('无 API Key → 401（外部接口鉴权不变量）', async () => {
  const db = makeDb();
  const r = await call(db, 'POST', '/api/external/record-log', { body: { ok: true, summary: 'x' } });
  assert.equal(r.status, 401);
  assert.equal(db.__runs.length, 0, '鉴权失败不能写日志');
});

await t('错误 Key → 401', async () => {
  const db = makeDb();
  const r = await call(db, 'POST', '/api/external/record-log', { key: 'wrong', body: { ok: true, summary: 'x' } });
  assert.equal(r.status, 401);
});

await t('成功录制 → runs 记一行 ok（site=record，日志页能认出来）', async () => {
  const db = makeDb();
  const r = await call(db, 'POST', '/api/external/record-log', {
    key: KEY,
    body: { ok: true, summary: '录到 POST example.com（3 个请求头，请求体 42B）', detail: '[扩展录制] 2026-09-30\n抓到：POST https://example.com/api' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(db.__runs.length, 1);
  const row = db.__runs[0];
  assert.equal(row.site, 'record');
  assert.equal(row.name, '🎬 扩展录制');
  assert.equal(row.status, 'ok');
  assert.equal(row.account_id, null);
  assert.ok(row.message.includes('录到 POST'), row.message);
  assert.ok(row.detail.includes('抓到：POST'), row.detail);
});

await t('录制失败（超时/交接失败）→ status=fail，错误信息进 detail', async () => {
  const db = makeDb();
  const r = await call(db, 'POST', '/api/external/record-log', {
    key: KEY,
    body: { ok: false, summary: '录制超时：90 秒内没有抓到签到请求', detail: '错误：90 秒内没有抓到同站点的 XHR 请求' },
  });
  assert.equal(r.status, 200);
  assert.equal(db.__runs[0].status, 'fail');
  assert.ok(db.__runs[0].detail.includes('XHR'), db.__runs[0].detail);
});

await t('空内容 → 400', async () => {
  const db = makeDb();
  const r = await call(db, 'POST', '/api/external/record-log', { key: KEY, body: { ok: true } });
  assert.equal(r.status, 400);
  assert.equal(db.__runs.length, 0);
});

await t('超长内容被截断（summary 200 / detail 8192），写不爆 D1', async () => {
  const db = makeDb();
  const r = await call(db, 'POST', '/api/external/record-log', {
    key: KEY,
    body: { ok: true, summary: 's'.repeat(500), detail: 'd'.repeat(20000) },
  });
  assert.equal(r.status, 200);
  assert.ok(db.__runs[0].message.length <= 200, db.__runs[0].message.length);
  assert.ok(db.__runs[0].detail.length <= 8192, db.__runs[0].detail.length);
});

await t('只留最近 100 条录制日志（D1 不会被撑大）', async () => {
  const db = makeDb();
  for (let i = 0; i < 105; i++) {
    db.__runs.push({ id: i + 1, account_id: null, site: 'record', name: '🎬 扩展录制', status: 'ok', message: '旧' + i, detail: '', duration_ms: 0, created_at: i });
  }
  db.__bumpId(10000); // 真实 D1 自增 id 只增不减：新行 id 最大
  const r = await call(db, 'POST', '/api/external/record-log', { key: KEY, body: { ok: true, summary: '最新一条' } });
  assert.equal(r.status, 200);
  const recs = db.__runs.filter((x) => x.site === 'record');
  assert.equal(recs.length, 100, '实际 ' + recs.length);
  assert.ok(recs.some((x) => x.message === '最新一条'), '最新的一条必须留下');
  assert.ok(!recs.some((x) => x.message === '旧0'), '最旧的应该被清掉');
});

console.log(`\n${n} 组通过`);
