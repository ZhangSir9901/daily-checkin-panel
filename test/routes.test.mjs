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
  const loginLimits = new Map(); // ip -> { fails, first_at, locked_until }（登录限速）
  const community = []; // 已导入的社区站点（导入之后要能拿它建账号）
  // 一行字段坏掉的中继任务（见 first()/all() 里的用途）
  const relayJob = {
    id: 'r_1', url: 'https://hutue.cn/', method: 'GET', headers: '{不是 JSON', body: null,
    options: '也坏了', status: 'done', resp_status: 200, resp_headers: '[坏掉的]', resp_body: '',
  };
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
        if (/FROM login_limits WHERE ip = \?/i.test(sql)) {
          const r = loginLimits.get(stmt._args[0]);
          return r ? { ...r } : null;
        }
        // 账号行的各种取法（SELECT * / SELECT id, site, name / SELECT meta）：一律按 id 返回整行，
        // 真 D1 只回被选中的列，但测试只关心值对不对，多给两列不影响。
        if (/^SELECT [\s\S]* FROM accounts WHERE id = \?/i.test(sql)) {
          const r = accounts.find((x) => Number(x.id) === Number(stmt._args[0]));
          return r ? { ...r } : null;
        }
        // 中继任务：故意给一行「JSON 坏掉」的数据（旧版本写的 / 手改的 / 写一半被打断的）——
        // 中继那几列本来就是该存 JSON 的，一行坏数据不该让整条链路瘫成 500。
        if (/FROM relay_jobs WHERE id = \?/i.test(sql)) return { ...relayJob };
        if (/^SELECT COUNT\(\*\) AS n/i.test(sql)) return { n: 0 };
        if (/^SELECT COUNT\(\*\) AS c/i.test(sql)) return { c: 0 };
        return null;
      },
      async all() {
        if (/^PRAGMA table_info/i.test(sql)) return { results: [] };
        if (/FROM community_sites/i.test(sql)) return { results: community.map((x) => ({ ...x })) };
        if (/FROM relay_jobs/i.test(sql)) return { results: [{ ...relayJob }] };
        if (/FROM accounts/i.test(sql)) return { results: accounts.map((x) => ({ ...x })) };
        return { results: [] };
      },
      async run() {
        const a = stmt._args;
        // 登录限速表要真的能读能写：不写进假库的话，recordLoginFail 每次都从 1 开始，
        // 「连错 8 次锁 15 分钟」永远测不出来。
        // 只处理「增删改」，不能把建表语句（CREATE TABLE … login_limits …）也吃进来 ——
        // 那会插出一条 a[0] === undefined 的脏记录，看上去就像「限速计数没被清掉」。
        if (/login_limits/i.test(sql) && /^(INSERT|DELETE|UPDATE)/i.test(sql)) {
          if (/^DELETE FROM login_limits WHERE ip/i.test(sql)) { loginLimits.delete(a[0]); return { meta: { changes: 1 } }; }
          // 清理旧记录（WHERE updated_at < ?）：只能删「确实过期」的。
          // 这里如果写成 clear()，生产代码里那次 10% 概率的清理会把刚记上的失败次数
          // 一起抹掉 —— 测试就会时好时坏（假库太宽松比不写测试更坑）。
          if (/^DELETE FROM login_limits WHERE updated_at/i.test(sql)) {
            let n = 0;
            for (const [k, v] of loginLimits) if (Number(v.updated_at) < Number(a[0])) { loginLimits.delete(k); n++; }
            return { meta: { changes: n } };
          }
          if (/^DELETE FROM login_limits/i.test(sql)) { loginLimits.clear(); return { meta: { changes: 1 } }; }
          const [ip, fails, first, locked, upd] = a;
          loginLimits.set(ip, { fails, first_at: first, locked_until: locked, updated_at: upd });
          return { meta: { changes: 1 } };
        }
        if (/^DELETE FROM sessions/i.test(sql)) { sessions.clear(); return { meta: { changes: 1 } }; }
        // UPDATE accounts 要真的落进假库（外面上报写的是 meta.last_signin_date，不记就测不了）
        if (/^UPDATE accounts SET last_status/i.test(sql)) {
          const [st, msg, detail, at, meta, upd, id] = a;
          const row = accounts.find((x) => Number(x.id) === Number(id));
          if (row) { row.last_status = st; row.last_msg = msg; row.last_detail = detail; row.last_run_at = at; row.meta = meta; row.updated_at = upd; }
          return { meta: { changes: 1 } };
        }
        // 会话续命（/api/external/creds-rotation）写回的凭据 / meta 也要真的落库
        if (/^UPDATE accounts SET creds/i.test(sql)) {
          const [enc, upd, id] = a;
          const row = accounts.find((x) => Number(x.id) === Number(id));
          if (row) { row.creds = enc; row.updated_at = upd; }
          return { meta: { changes: 1 } };
        }
        if (/^UPDATE accounts SET meta/i.test(sql)) {
          const [meta, id] = a;
          const row = accounts.find((x) => Number(x.id) === Number(id));
          if (row) { row.meta = meta; }
          return { meta: { changes: 1 } };
        }
        if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE|DELETE FROM|UPDATE|PRAGMA)/i.test(sql)) return { meta: { changes: 0 } };
        if (/community_sites/i.test(sql)) {
          const [id, name, author, version, source, def, createdAt, updatedAt] = a;
          const i = community.findIndex((x) => x.id === id);
          const row = { id, name, author, version, source, def, created_at: createdAt, updated_at: updatedAt };
          if (i >= 0) community[i] = row; else community.push(row);
          return { meta: { changes: 1 } };
        }
        if (/^(INSERT INTO|INSERT OR REPLACE INTO|INSERT OR IGNORE INTO)/i.test(sql)) {
          if (/settings/i.test(sql)) { kv.set(a[0], a[1]); return { meta: { changes: 1 } }; }
          if (/sessions/i.test(sql)) { sessions.set(a[0], Number(a[2])); return { meta: { changes: 1 } }; }
          if (/accounts/i.test(sql)) {
            // 真 D1 会回 last_row_id，面板就是拿它去「试跑」的
            const id = Math.max(0, ...accounts.map((x) => Number(x.id))) + 1;
            accounts.push({ id, name: a[0], site: a[1], creds: a[2], enabled: a[3] || 1, meta: '{}', created_at: a[4], updated_at: a[5] });
            return { meta: { changes: 1, last_row_id: id } };
          }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };
  return { kv, sessions, accounts, loginLimits, prepare, async batch(s) { return Promise.all((s || []).map((x) => x.run())); } };
}

const worker = (await import('../src/index.js')).default;
const { encryptJSON } = await import('../src/crypto.js');
const { decryptJSON } = await import('../src/crypto.js');

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
  ['POST', '/api/notify-report', { ok: 1, fail: 0, lines: ['✅ 测试账号：今日已签到'] }],
  ['POST', '/api/notify-test', {}],
  ['POST', '/api/notify-telegram-chats', {}],
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
    ['POST', '/api/external/creds-rotation', { account_id: 1, cookies: 'x=y' }],
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

await t('手动日报推送接口：登录后可调，参数再脏也不许抛（正文由面板传上来）', async () => {
  const db = makeDb();
  const r1 = await call(db, 'POST', '/api/notify-report', { body: { ok: 2, fail: 1, skip: 1, lines: ['✅ a：x', '❌ b：y'] }, sid: SID });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.ok, true);
  // 没开推送时应该静默成功（不是报错）——否则面板每次都会弹一个「推送失败」
  const r2 = await call(db, 'POST', '/api/notify-report', { body: { lines: 'not-an-array' }, sid: SID });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  const r3 = await call(db, 'POST', '/api/notify-report', { sid: SID }); // 一个字段都不给
  assert.equal(r3.status, 200, JSON.stringify(r3.json));
});

await t('社区站点：导入之后真的能用它建账号（不许「选得到却存不进去」）', async () => {
  // /api/sites 把社区站点也一并返回 → 面板下拉里选得到、表单体检也算通过，
  // 但新建账号曾经只查内置站点，于点保存就回「未知站点」。
  const db = makeDb();
  const def = {
    schema: 'daily-checkin-site/1', id: 'bbs_example_com', name: '示例论坛',
    fields: [{ key: 'cookie', label: 'Cookie', required: true }],
    steps: [{ url: 'https://bbs.example.com/sign', method: 'POST', expect_contains: '签到成功' }],
  };
  const imp = await call(db, 'POST', '/api/sites/community', { body: { config: JSON.stringify(def) }, sid: SID });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
  const sites = await call(db, 'GET', '/api/sites', { sid: SID });
  assert.ok((sites.json.sites || []).some((s) => s.id === 'bbs_example_com'),
    '站点列表里要能看到刚导入的社区站点（用户就是这么选到它的）');
  const created = await call(db, 'POST', '/api/accounts', { body: { name: '示例', site: 'bbs_example_com', creds: { cookie: 'a=b' } }, sid: SID });
  assert.equal(created.status, 200, '社区站点也要能建账号，实际：' + JSON.stringify(created.json));
  assert.ok(created.json.id, '要返回新账号的 id（面板随后会拿它试跑）');
  // 改账号那条路早就是带社区站点的，别哪天又被改回只查内置站点
  const updated = await call(db, 'PUT', `/api/accounts/${created.json.id}`, { body: { name: '示例2', site: 'bbs_example_com', creds: { cookie: 'a=b' } }, sid: SID });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
});

// 把「现在」钉在一个 UTC 与北京不在同一天的时刻：
// 2026-09-29T18:00:00Z → 北京时间已经是 09-30 02:00，而 UTC 还是 09-29。
// 糊涂鳄按 UTC 计日，所以它那边「今天」应该是 09-29。
function withNow(iso, fn) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
    static now() { return fixed; }
  }
  globalThis.Date = FakeDate;
  return Promise.resolve().then(fn).finally(() => { globalThis.Date = RealDate; });
}

await t('扩展上报成功时，「今天」按**站点自己的日界**算（糊涂鳄是 UTC，不是面板时区）', async () => {
  // 不这么算的后果：扩展刚报「签到成功」，账号行却写着「未签到」——
  // 因为那一行的判据用的是站点日界（前端 accountDay），而入库的日期用的是面板时区。
  const db = makeDb();
  await fillCreds(db);
  db.accounts[0].site = 'hutue'; // hutue 声明了 dayTz: 'UTC'
  db.accounts[0].meta = '{}';
  db.kv.set('schedule_tz', 'Asia/Shanghai');
  let r;
  await withNow('2026-09-29T18:00:00Z', async () => {
    r = await call(db, 'POST', '/api/external/report', { key: KEY, body: { account_id: 1, status: 'ok', message: '今日已签到，请明日再来' } });
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const meta = JSON.parse(db.accounts[0].meta || '{}');
  assert.equal(meta.last_signin_date, '2026-09-29', '糊涂鳄按 UTC 计日，此刻它的「今天」还是 09-29');
  assert.equal(db.accounts[0].last_status, 'ok');
});

await t('扩展上报失败时不许写「今日已签到」', async () => {
  const db = makeDb();
  db.accounts[0].meta = '{}';
  const r = await call(db, 'POST', '/api/external/report', { key: KEY, body: { account_id: 1, status: 'fail', message: '登录已失效' } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(db.accounts[0].meta || '{}').last_signin_date, undefined, '失败不能冒充成功');
  assert.equal(db.accounts[0].last_status, 'fail');
});

await t('登录限速：连续输错会被临时锁住（挡住「拿脚本一直猜管理密码」）', async () => {
  const db = makeDb();
  const { hashPassword } = await import('../src/crypto.js');
  db.kv.set('admin_hash', await hashPassword('correct-horse-battery'));
  let last = null;
  for (let i = 0; i < 8; i++) last = await call(db, 'POST', '/api/login', { body: { password: 'wrong-' + i } });
  assert.equal(last.status, 429, '错到第 8 次要锁住，实际 ' + last.status + ' ' + JSON.stringify(last.json));
  assert.match(String(last.json.error), /锁定|太多/);
  // 锁住期间就算给对密码也不放行 —— 否则限速形同虚设
  const blocked = await call(db, 'POST', '/api/login', { body: { password: 'correct-horse-battery' } });
  assert.equal(blocked.status, 429);
  // 提示里要说清楚还要等多久，不能只说「不行」
  assert.match(String(blocked.json.error), /分钟/);
});

await t('登录限速：密码正确会清掉失败计数（自己人不被自己的手误锁在外面）', async () => {
  const db = makeDb();
  const { hashPassword } = await import('../src/crypto.js');
  db.kv.set('admin_hash', await hashPassword('correct-horse-battery'));
  const bad = await call(db, 'POST', '/api/login', { body: { password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.match(String(bad.json.error), /还可以再试/, '要告诉用户还剩几次机会');
  const ok = await call(db, 'POST', '/api/login', { body: { password: 'correct-horse-battery' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(db.loginLimits.size, 0, '登录成功后计数要清掉');
});

await t('跨站写操作被拒：带了会话 Cookie 但 Origin 不是本面板 → 403', async () => {
  const db = makeDb();
  const post = (origin) => worker.fetch(new Request('https://panel.example/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: 'sid=' + SID, Origin: origin },
    body: JSON.stringify({ enabled: false }),
  }), envFor(db), {});
  const evil = await post('https://evil.example');
  assert.equal(evil.status, 403, '跨站写操作必须被拦');
  const same = await post('https://panel.example');
  assert.equal(same.status, 200, '同源照旧能用，实际 ' + await same.text());
  // 扩展 / curl 这类没有 Origin 的客户端不受影响
  const noOrigin = await worker.fetch(new Request('https://panel.example/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: 'sid=' + SID },
    body: JSON.stringify({ enabled: false }),
  }), envFor(db), {});
  assert.equal(noOrigin.status, 200);
});

await t('社区配置拉取：内网地址一律拒绝（不许拿面板当内网探针）', async () => {
  const db = makeDb();
  const urls = ['http://127.0.0.1:8080/x.json', 'http://192.168.1.1/a.json', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/x.json', 'file:///etc/passwd'];
  for (const url of urls) {
    const r = await call(db, 'POST', '/api/sites/community', { body: { url }, sid: SID });
    assert.equal(r.status, 400, url + ' 应该被拒，实际 ' + r.status);
  }
});

// ---------- 首次设置 / 登录：跨站请求必须挡住 ----------
//
// 【为什么这两条特别危险】它们是**唯一两个在没有会话 Cookie 时也能写库的接口**，
// 而上面那条 Origin 兜底是「带了 sid 才校验」——正好盖不到它们：
//   ├─ /api/setup：全新实例还没设密码，恶意页面可以用你的浏览器替你设一个 → 真正的部署者被锁在门外；
//   └─ /api/login：登录 CSRF，把你登成攻击者的账号，你之后做的事全落在别人的账号上。
await t('/api/setup 带跨站 Origin → 403（不许替面板主人初始化）', async () => {
  const db = makeDb();
  db.kv.delete('admin_hash'); // 全新实例
  const raw = (origin) => worker.fetch(new Request('https://panel.example/api/setup', {
    method: 'POST',
    headers: origin ? { 'Content-Type': 'application/json', Origin: origin } : { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'attacker-password' }),
  }), envFor(db), {});
  const evil = await raw('https://evil.example');
  assert.equal(evil.status, 403, '跨站首装必须被拦');
  assert.equal(db.kv.get('admin_hash'), undefined, '拦下来时一个字都不许写进库');
  // 同源（面板自己）照旧能用；没有 Origin 的客户端（curl / 脚本）也不受影响
  const fresh = makeDb(); fresh.kv.delete('admin_hash');
  const same = await worker.fetch(new Request('https://panel.example/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://panel.example' },
    body: JSON.stringify({ password: 'a-good-password' }),
  }), envFor(fresh), {});
  assert.equal(same.status, 200, '同源首装要能正常用，实际 ' + same.status);
  const cli = await worker.fetch(new Request('https://panel.example/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'a-good-password' }),
  }), envFor(makeDbF() ), {});
  assert.equal(cli.status, 200, '命令行初始化（没有 Origin）不能被误伤');
  function makeDbF() { const d = makeDb(); d.kv.delete('admin_hash'); return d; }
});

await t('/api/login 带跨站 Origin → 403（登录 CSRF）', async () => {
  const { hashPassword } = await import('../src/crypto.js');
  const db = makeDb();
  db.kv.set('admin_hash', await hashPassword('correct-horse-battery'));
  const post = (origin) => worker.fetch(new Request('https://panel.example/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password: 'correct-horse-battery' }),
  }), envFor(db), {});
  const evil = await post('https://evil.example');
  assert.equal(evil.status, 403, '跨站登录必须被拦');
  assert.equal(evil.headers.get('Set-Cookie'), null, '拦下来时不能发出会话');
  const same = await post('https://panel.example');
  assert.equal(same.status, 200, '同源登录照旧，实际 ' + same.status);
  // 密码错误时也要先过跨站那道 —— 不然它就是一个人肉的「密码对不对」探测口
  const evilWrong = await post('https://evil.example');
  assert.equal(evilWrong.status, 403);
});

// ---------- 脏输入不许变成 500 ----------
//
// 【真实影响】`Cookie: a=%` 就够让 decodeURIComponent 抛 URIError，一路冒到顶层 catch → 500。
// 未登录就能触发，监控里看就是「面板全线挂了」（实际什么都没坏）。
await t('畸形 Cookie 头（a=%）不许变成 500：公开接口照常、管理接口老实回 401', async () => {
  const db = makeDb();
  const withBadCookie = (path) => worker.fetch(new Request('https://panel.example' + path, {
    headers: { Cookie: 'sid=%;a=%zz;b=ok' },
  }), envFor(db), {});
  const status = await withBadCookie('/api/status');
  assert.equal(status.status, 200, '/api/status 不该被一个畸形 Cookie 打挂，实际 ' + status.status + ' ' + await status.clone().text());
  const body = await status.json();
  assert.equal(body.logged_in, false, '解不开的 sid 不能被当成有效会话（也不该被当成已登录）');
  const accounts = await withBadCookie('/api/accounts');
  assert.equal(accounts.status, 401, '管理接口要老实回 401，实际 ' + accounts.status);
});

await t('交接码里塞一段编码垃圾（/api/handoff/%）→ 400，不是 500', async () => {
  const db = makeDb();
  const r = await worker.fetch(new Request('https://panel.example/api/handoff/%', {}), envFor(db), {});
  assert.equal(r.status, 400, '实际 ' + r.status + ' ' + await r.clone().text());
  const r2 = await worker.fetch(new Request('https://panel.example/api/handoff/zzzz', {}), envFor(db), {});
  assert.equal(r2.status, 400, '格式不对的短码也是 400');
});

// ---------- 改账号：必填项与「换站点别留着旧凭据」 ----------
await t('PUT 改账号：必填项留空 / 换了站点却不给凭据 → 400（而不是先存进去、等运行时才失败）', async () => {
  const db = makeDb();
  await fillCreds(db);
  db.accounts[0].site = 'wuaipojie';
  // ① 必填项（wuapoijie 要 cookie）留空
  const empty = await call(db, 'PUT', '/api/accounts/1', { sid: SID, body: { name: 'x', site: 'wuaipojie', creds: { cookie: '   ' } } });
  assert.equal(empty.status, 400, '实际 ' + empty.status + ' ' + JSON.stringify(empty.json));
  assert.match(String(empty.json.error), /必填/);
  // ② 换了站点但没给 creds：旧站点的 Cookie 不能留给新站点用
  const switched = await call(db, 'PUT', '/api/accounts/1', { sid: SID, body: { name: 'x', site: 'nodeseek' } });
  assert.equal(switched.status, 400, '实际 ' + switched.status + ' ' + JSON.stringify(switched.json));
  assert.match(String(switched.json.error), /重新填写凭据/);
  // ③ 只改开关（不带 creds、不改站点）照旧能用 —— 面板上那个「启用/停用」就靠它
  const toggle = await call(db, 'PUT', '/api/accounts/1', { sid: SID, body: { enabled: 0 } });
  assert.equal(toggle.status, 200, JSON.stringify(toggle.json));
});

// ---------- 中继：不许拿「用户自己的网络」去打内网 ----------
//
// 中继真正执行请求的是**用户浏览器里的扩展**，出口是他的家庭/公司网络。
// 以前这里只检查「以 http 开头」，于是有 API Key 的人（或一份恶意社区配置）就能让面板
// 代他去请求 192.168.1.1/admin 或云元数据地址，再把响应正文读走 ——
// 面板自己那个出站闸门管不到这一段（那是 Worker 发的请求，这是用户浏览器发的）。
await t('中继：内网/本机地址一律拒绝（域名照旧放行，公司内网域名要能用）', async () => {
  const db = makeDb();
  const deny = ['http://127.0.0.1:8080/admin', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://localhost./x', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/', 'http://user:pw@127.0.0.1/'];
  for (const url of deny) {
    const r = await call(db, 'POST', '/api/external/relay', { key: KEY, body: { url, method: 'GET' } });
    assert.equal(r.status, 400, url + ' 应该被拒，实际 ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 100));
  }
  // 正常公网地址（包括「域名解析到内网」的内网域名）必须照旧能用
  const ok = await call(db, 'POST', '/api/external/relay', { key: KEY, body: { url: 'https://intranet.example.com/sign', method: 'GET' } });
  assert.equal(ok.status, 200, '公网域名不能被误伤：' + JSON.stringify(ok.json));
  assert.ok(ok.json.job_id, '要真的建出中继任务');
});

await t('中继：库里一行 JSON 坏也不许 500（否则扩展一整轮轮询全废）', async () => {
  const db = makeDb();
  const one = await call(db, 'GET', '/api/external/relay/r_1', { key: KEY });
  assert.equal(one.status, 200, '面板查任务结果不该被坏数据打挂：' + one.status + ' ' + JSON.stringify(one.json).slice(0, 120));
  assert.equal(one.json.status, 'done');
  assert.deepEqual(one.json.response.headers, {}, '解不开的 resp_headers 就当没有头，而不是抛出去');
  const poll = await call(db, 'GET', '/api/external/relay-pending?wait=0', { key: KEY });
  assert.equal(poll.status, 200, '扩展轮询更不该被打挂（它 500 一次，本地网络就全停了）：' + poll.status);
  assert.deepEqual(poll.json.jobs[0].headers, {});
  assert.deepEqual(poll.json.jobs[0].options, {});
  assert.equal(poll.json.jobs[0].url, 'https://hutue.cn/', '坏字段当空值，任务本身照旧交给扩展');
});

await t('面板出口连通性：没登录不给测（不能拿它当「免费测速 / 探测」服务）', async () => {
  const db = makeDb();
  // 注意：故意**不**把它放进上面那张 ADMIN_ROUTES 冒烟表 ——
  // 那个循环会带会话把每个接口真调一遍，而这条会真的往外发 6 个请求。
  const r = await call(db, 'GET', '/api/net-check');
  assert.equal(r.status, 401, '没登录应该 401，实际 ' + r.status);
});

await t('推送出站地址：Webhook / Bark 填内网地址一律拒绝（它们是面板自己去 POST 的地址）', async () => {
  const db = makeDb();
  const w = await call(db, 'PUT', '/api/settings', { sid: SID, body: { webhook_url: 'http://192.168.1.10:9000/hook' } });
  assert.equal(w.status, 400, '实际 ' + w.status + ' ' + JSON.stringify(w.json));
  assert.match(String(w.json.error), /Webhook 地址不可用/);
  const b = await call(db, 'PUT', '/api/settings', { sid: SID, body: { bark_server: 'http://127.0.0.1:8080' } });
  assert.equal(b.status, 400, '实际 ' + b.status);
  // 正常地址、空值（用默认）都要照旧能用
  const ok = await call(db, 'PUT', '/api/settings', { sid: SID, body: { webhook_url: 'https://api.day.app/abc', bark_server: '' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

// ---------- 中继回传：写进库的字段要有闸门 ----------
await t('中继回传：非法 base64 / 越界状态码 / 超大正文都不许落库', async () => {
  const db = makeDb();
  const bad = await call(db, 'POST', '/api/external/relay/r_1/result', { key: KEY, body: { status: 200, body_base64: 'not base64 ##' } });
  assert.equal(bad.status, 400, '不是合法 base64 要当场挡住（否则运行时 atob 只会报一句 Invalid character）：' + JSON.stringify(bad.json));
  const weird = await call(db, 'POST', '/api/external/relay/r_1/result', { key: KEY, body: { status: 99999, body_base64: '' } });
  assert.equal(weird.status, 400, '状态码越界要挡住（面板上会出现一个不存在的状态）：' + JSON.stringify(weird.json));
  const huge = await call(db, 'POST', '/api/external/relay/r_1/result', { key: KEY, body: { status: 200, body_base64: 'A'.repeat(430 * 1024) } });
  assert.equal(huge.status, 413, '超大正文要挡住，实际 ' + huge.status);
  const okres = await call(db, 'POST', '/api/external/relay/r_1/result', { key: KEY, body: { status: 200, body_base64: Buffer.from('{"status":"0"}').toString('base64') } });
  assert.equal(okres.status, 200, '正常回传照旧，实际 ' + JSON.stringify(okres.json));
});

await t('修改密码：至少 8 位；改完会把其它浏览器上的登录全部踢掉', async () => {
  const db = makeDb();
  const { hashPassword } = await import('../src/crypto.js');
  db.kv.set('admin_hash', await hashPassword('old-password-9'));
  const short = await call(db, 'POST', '/api/change-password', { sid: SID, body: { old_password: 'old-password-9', new_password: 'abc123' } });
  assert.equal(short.status, 400, JSON.stringify(short.json));
  assert.match(String(short.json.error), /8 位/);

  const okr = await call(db, 'POST', '/api/change-password', { sid: SID, body: { old_password: 'old-password-9', new_password: 'new-password-9' } });
  assert.equal(okr.status, 200, JSON.stringify(okr.json));
  assert.equal(db.sessions.has(SID), false, '旧会话必须失效（否则「觉得密码泄露了→改密码」根本不起作用）');
  assert.equal(db.sessions.size, 1, '同时给当前浏览器发了一把新的会话');
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

await t('会话续命（alist 式）：扩展回写轮换后的 Cookie，只换提交的那几条、其他凭据字段不动', async () => {
  const db = makeDb();
  await fillCreds(db);
  const r = await call(db, 'POST', '/api/external/creds-rotation', {
    key: KEY,
    body: { account_id: 1, domain: 'https://www.52pojie.cn/', cookies: 'a=NEW; saltkey=ab12cd34' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  const row = db.accounts[0];
  // fillCreds 里存的旧值是 a=b；回写后 a 应变成 NEW，saltkey 追加，site_url 必须原样保留
  const saved = await decryptJSON(envFor(db), db, row.creds);
  assert.match(String(saved.cookie), /(?:^|; )a=NEW(?:;|$)/, '轮换的那条要更新');
  assert.match(String(saved.cookie), /(?:^|; )saltkey=ab12cd34(?:;|$)/, '新增的登录名要写入');
  assert.equal(saved.site_url, 'https://www.52pojie.cn', '其他凭据字段绝不能动');
  // 留痕
  const meta = JSON.parse(row.meta || '{}');
  assert.ok(meta.cred_rotated_at > 0, '要记 cred_rotated_at 痕迹');
});

await t('会话续命：域不同（拿别的站的 Cookie 污染账号）→ 400；内容没变化 → 409 不白写库', async () => {
  const db = makeDb();
  await fillCreds(db);
  const before = db.accounts[0].creds;
  const cross = await call(db, 'POST', '/api/external/creds-rotation', {
    key: KEY,
    body: { account_id: 1, domain: 'https://evil.example/', cookies: 'a=HACKED' },
  });
  assert.equal(cross.status, 400, '跨域回写要拒绝');
  assert.equal(db.accounts[0].creds, before, '被拒后库里的凭据不能变');

  const same = await call(db, 'POST', '/api/external/creds-rotation', {
    key: KEY,
    body: { account_id: 1, domain: 'https://www.52pojie.cn/', cookies: 'a=b; color_scheme=dark' },
  });
  assert.equal(same.status, 400, '没有登录名的回写要拒绝（纯噪音）');

  const dup = await call(db, 'POST', '/api/external/creds-rotation', {
    key: KEY,
    body: { account_id: 1, domain: 'https://www.52pojie.cn/', cookies: 'a=b' },
  });
  assert.equal(dup.status, 409, '内容一致要 409，免得每次签到都白写一遍库');
  assert.equal(db.accounts[0].creds, before, '409 时库里凭据不能变');
});

await t('会话续命：不存在账号 → 404；空 Cookie → 400', async () => {
  const db = makeDb();
  const r404 = await call(db, 'POST', '/api/external/creds-rotation', {
    key: KEY, body: { account_id: 999, cookies: 'a=1' },
  });
  assert.equal(r404.status, 404);
  const r400 = await call(db, 'POST', '/api/external/creds-rotation', {
    key: KEY, body: { account_id: 1, cookies: '' },
  });
  assert.equal(r400.status, 400);
});
