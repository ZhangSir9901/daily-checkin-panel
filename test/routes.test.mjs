// 接口冒烟 + 鉴权不变量：node test/routes.test.mjs
//
// 【为什么要有这个】2026-09-29 那个「定时到点没签到」的 bug（`scheduled()` 里
// `changed = true;` 没声明）说明了一件事：**很少被执行到的分支**里藏着的东西，
// 只靠读代码和纯函数单测是抓不住的。这个文件把每个接口都真的调一遍，看它会不会
// 抛异常（顶层 catch 会把它变成 500「服务异常」）。
//
// 同时钉住两条安全不变量（比功能 bug 更要命）：
//   ① /api/external/* 一律要求 API Key —— 不许有任何一条漏在外面
//      （否则任何知道面板地址的人都能指挥用户的浏览器、读账号凭据）；
//   ② 管理接口没登录必须是 401，而不是 500 或者「悄悄成功」。
//
// 注意：这里**不调用**会真的发网络请求的接口（/run、/run-all、/probe、/http-test、
// /diag/relay），它们属于要靠真实站点验证的部分，放在别的测试里。
import assert from 'node:assert/strict';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const KEY = 'k'.repeat(24);
const SID = 's'.repeat(48);

function makeDb() {
  const kv = new Map([['admin_hash', 'pbkdf2$fake'], ['relay_last_poll', String(Date.now())], ['external_api_key', KEY]]);
  const sessions = new Map([[SID, Date.now() + 864e5]]);
  const accounts = [{
    id: 1, name: '测试账号', site: 'wuaipojie', enabled: 1, creds: 'x', meta: '{}',
    last_status: 'ok', last_msg: 'm', last_detail: 'd', last_run_at: Date.now(),
    created_at: Date.now(), updated_at: Date.now(),
  }];
  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  const prepare = (sqlRaw) => {
    const sql = norm(sqlRaw);
    const stmt = {
      _args: [],
      bind(...a) { stmt._args = a; return stmt; },
      async first() {
        if (/^SELECT value FROM settings WHERE key = \?/i.test(sql)) {
          const v = kv.get(stmt._args[0]);
          return v === undefined ? null : { value: v };
        }
        if (/^SELECT expires_at FROM sessions WHERE id = \?/i.test(sql)) {
          const e = sessions.get(stmt._args[0]);
          return e === undefined ? null : { expires_at: e };
        }
        if (/^SELECT \* FROM accounts WHERE id = \?/i.test(sql)) {
          const r = accounts.find((x) => Number(x.id) === Number(stmt._args[0]));
          return r ? { ...r } : null;
        }
        if (/^SELECT COUNT\(\*\) AS n/i.test(sql)) return { n: 0 };
        if (/^SELECT COUNT\(\*\) AS c/i.test(sql)) return { c: 0 };
        return null;
      },
      async all() {
        if (/^PRAGMA table_info/i.test(sql)) return { results: [] };
        if (/FROM accounts/i.test(sql)) return { results: accounts.map((x) => ({ ...x })) };
        return { results: [] };
      },
      async run() {
        const a = stmt._args;
        if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE|DELETE FROM|UPDATE|PRAGMA)/i.test(sql)) return { meta: { changes: 0 } };
        if (/^(INSERT INTO|INSERT OR REPLACE INTO|INSERT OR IGNORE INTO)/i.test(sql)) {
          if (/settings/i.test(sql)) { kv.set(a[0], a[1]); return { meta: { changes: 1 } }; }
          if (/sessions/i.test(sql)) { sessions.set(a[0], Number(a[2])); return { meta: { changes: 1 } }; }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };
  return { kv, sessions, accounts, prepare, async batch(s) { return Promise.all((s || []).map((x) => x.run())); } };
}

const worker = (await import('../src/index.js')).default;
const { encryptJSON } = await import('../src/crypto.js');

// 账号 1 的凭据要用真的加密格式填进去：假字符串会让 /api/accounts/1 这类接口
// 在解密时抛「凭据数据格式异常」—— 那是数据损坏时的预期行为，不是接口 bug。
// 固定一把加密密钥：不固定的话每次假库里查不到 key 就会现生成一把，解不开上一次的密文。
const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
function envFor(db) {
  if (!db.__env) db.__env = { DB: db, ENCRYPT_KEY: ENC_KEY };
  return db.__env;
}
async function fillCreds(db) {
  db.accounts[0].creds = await encryptJSON(envFor(db), db, { cookie: 'a=b', site_url: 'https://www.52pojie.cn' });
}

async function call(db, method, path, { body, key, sid } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['X-Api-Key'] = key;
  if (sid) headers['Cookie'] = 'sid=' + sid;
  const res = await worker.fetch(new Request('https://panel.example' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), envFor(db), {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

// 每个接口的「应该存在」清单。ids 都用 1（假库里有账号 1）。
const ADMIN_ROUTES = [
  ['GET', '/api/status', undefined],
  ['GET', '/api/me', undefined],
  ['GET', '/api/sites', undefined],
  ['GET', '/api/sites/community', undefined],
  ['GET', '/api/accounts', undefined],
  ['GET', '/api/accounts/1', undefined],
  ['GET', '/api/accounts/1/export-config', undefined],
  ['GET', '/api/schedule', undefined],
  ['PUT', '/api/schedule', { time: '08:05', tz: 'Asia/Shanghai' }],
  ['GET', '/api/runs', undefined],
  ['DELETE', '/api/runs', undefined],
  ['GET', '/api/settings', undefined],
  ['PUT', '/api/settings', { notify_url: '' }],
  ['GET', '/api/nodeseek-mode', undefined],
  ['PUT', '/api/nodeseek-mode', { mode: 'random' }],
  ['GET', '/api/ext-key', undefined],
  ['GET', '/api/relay-status', undefined],
  ['GET', '/api/ext-status', undefined],
  ['GET', '/api/ext-security', undefined],
  ['POST', '/api/accounts', { name: '新账号', site: 'wuaipojie', creds: { cookie: 'a=b' } }],
  ['PUT', '/api/accounts/1', { name: '改名', site: 'wuaipojie', creds: { cookie: 'a=b' }, enabled: 1 }],
  ['PUT', '/api/accounts/1/schedule', { hour: '09' }],
  ['PUT', '/api/accounts/1/execution', { execution: '' }],
  ['POST', '/api/accounts/1/toggle', {}],
  ['POST', '/api/accounts/1/browser-sign', {}],
  ['POST', '/api/accounts/1/assist', {}],
  ['POST', '/api/sites/community', { name: 'x', def: {} }],
  ['POST', '/api/sites/community/check', { def: {} }],
  ['PUT', '/api/sites/community/author', { author: 'me' }],
  ['GET', '/api/accounts/1/run-log', undefined],
];

await t('管理接口：没登录一律 401（不许 500，也不许悄悄放行）', async () => {
  const db = makeDb();
  for (const [method, path, body] of ADMIN_ROUTES) {
    if (path === '/api/status') continue; // 公开接口
    const r = await call(db, method, path, { body });
    assert.equal(r.status, 401, `${method} ${path} 没登录时应 401，实际 ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  }
});

await t('管理接口：登录后逐个调用不许抛异常（顶层 catch 会变成 500「服务异常」）', async () => {
  const db = makeDb();
  await fillCreds(db);
  const problems = [];
  for (const [method, path, body] of ADMIN_ROUTES) {
    const r = await call(db, method, path, { body, sid: SID });
    // 400/404（参数不合规 / 假库没有这东西）都正常；500 一律算 bug
    if (r.status >= 500 || (r.json && r.json.error && /服务异常/.test(String(r.json.error)))) {
      problems.push(`${method} ${path} → ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    }
  }
  assert.equal(problems.length, 0, '有接口抛异常：\n' + problems.join('\n'));
});

await t('外部接口（扩展用）没有 API Key 时一律 401 —— 一条都不许漏在外面', async () => {
  const db = makeDb();
  const routes = [
    ['POST', '/api/external/report', { account_id: 1, status: 'ok', message: 'x' }],
    ['POST', '/api/external/handoff', { domain: 'a.com' }],
    ['POST', '/api/external/hello', {}],
    ['GET', '/api/external/commands', undefined],
    ['GET', '/api/external/relay-pending?wait=0', undefined],
    ['GET', '/api/external/relay/r_1', undefined],
    ['POST', '/api/external/relay', { url: 'https://a.com/', method: 'GET', headers: {} }],
    ['POST', '/api/external/relay/r_1/result', { status: 200, body_base64: '' }],
    ['GET', '/api/external/browser-jobs', undefined],
    ['GET', '/api/external/account/1', undefined],
    ['GET', '/api/external/account/1/creds', undefined],
    ['GET', '/api/external/nodeseek-mode', undefined],
    ['GET', '/api/external/ping', undefined],
    ['POST', '/api/external/commands/c_1/result', { ok: true }],
  ];
  const leaked = [];
  for (const [method, path, body] of routes) {
    const r = await call(db, method, path, { body });
    if (r.status !== 401) leaked.push(`${method} ${path} → ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  }
  assert.equal(leaked.length, 0, '这些外部接口没有挡住无 Key 请求：\n' + leaked.join('\n'));
});

await t('扩展轮询带上版本号时，面板会记下来（用于显示「扩展在线 · v2.8」）', async () => {
  const db = makeDb();
  const r = await call(db, 'GET', '/api/external/relay-pending?wait=0&v=2.8', { key: KEY });
  assert.ok([200, 204].includes(r.status), '带 Key 时应正常返回，实际 ' + r.status);
  assert.equal(db.kv.get('relay_version'), '2.8', '版本号要落库（面板顶部那行靠它）');
});

await t('定时任务：没有任何账号时也不许崩（心跳照写）', async () => {
  const db = makeDb();
  db.accounts.length = 0;
  db.kv.set('schedule_time', '08:05');
  db.kv.set('schedule_tz', 'UTC');
  let pending = null;
  await worker.scheduled({}, { DB: db }, { waitUntil: (p) => { pending = p; } });
  await pending;
  const beat = JSON.parse(db.kv.get('cron_last_result') || 'null');
  assert.ok(beat, '即使一个账号都没有，也要留下心跳（否则面板无法区分「没账号」和「定时挂了」）');
  assert.equal(beat.ran, 0);
});

console.log(`\n${n} 组通过`);
