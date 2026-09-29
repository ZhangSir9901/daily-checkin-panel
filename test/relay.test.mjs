// 本地网络中继（Worker 侧）：node test/relay.test.mjs
// 重点不是「中继能跑」（那要真扩展），而是**出错时面板能不能看出卡在哪里**：
// 吾爱破解线上日志曾只有一句「本地网络失败：中继执行超时（45秒）」，用户在面板上
// 完全不知道卡的是哪个请求。所以失败/超时都必须把请求行写进 err.detail。
import assert from 'node:assert/strict';
import { waitRelayResult } from '../src/lib/relay.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// 极简 D1 fake：一条 relay_jobs 记录
function fakeDb(job) {
  return {
    prepare() {
      const stmt = {
        bind() { return stmt; },
        async first() { return job; },
        async run() { return {}; },
      };
      return stmt;
    },
  };
}

await t('中继：扩展回传失败时，错误里带上卡住的请求（method + url）', async () => {
  const db = fakeDb({ status: 'failed', error: '中继执行超时（45秒），已放弃该请求', method: 'post', url: 'https://www.52pojie.cn/home.php?mod=task&do=apply&id=2' });
  const err = await waitRelayResult(db, 'r1', 200, 20).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /本地网络失败/);
  assert.match(err.detail, /POST https:\/\/www\.52pojie\.cn\/home\.php\?mod=task/);
});

await t('中继：Worker 端等超时，也要说清是哪个请求没回来', async () => {
  const db = fakeDb({ status: 'pending', method: 'GET', url: 'https://example.com/api/sign' });
  const err = await waitRelayResult(db, 'r2', 150, 30).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /等待本地网络响应超时/);
  assert.match(err.detail, /GET https:\/\/example\.com\/api\/sign/);
});

await t('中继：url 过长时截断，不把整串查询参数灌进日志', async () => {
  const long = 'https://example.com/api/sign?' + 'a=1&'.repeat(200);
  const db = fakeDb({ status: 'failed', error: 'boom', method: 'GET', url: long });
  const err = await waitRelayResult(db, 'r3', 200, 20).catch((e) => e);
  assert.ok(err.detail.length < 200, 'detail 应被截断，实际长度 ' + err.detail.length);
});

// ---- runner：中继没等到回包时不能报「失败」 ----
// 线上现象（糊涂鳄）：POST admin-ajax 被吊到超时，面板显示「签到失败」，
// 但服务端很可能已经处理了这次请求（网站那天确实已签）—— 报失败就是冤枉网站。
// 现在记「结果未知」（skip，不写 last_signin_date），并允许定时器稍后自动复核。
function fakeDbRelayTimeout() {
  const inserted = [];
  const now = Date.now();
  let lastUrl = '';
  let lastMethod = 'GET';
  const home = Buffer.from('<html>首页</html>', 'utf8').toString('base64');
  return {
    inserted,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async run() {
          if (/INSERT INTO runs/i.test(sql)) inserted.push({ sql, args: stmt._args });
          // 记下队列里的任务，好让后续查询能区分「主页 GET」与「签到 POST」
          if (/INSERT INTO relay_jobs/i.test(sql)) { lastUrl = String(stmt._args[1]); lastMethod = String(stmt._args[2]).toUpperCase(); }
          return {};
        },
        async all() { return { results: [] }; },
        async first() {
          if (/FROM settings/i.test(sql)) return { value: String(now) }; // 扩展在线
          if (/FROM relay_jobs/i.test(sql)) {
            // 主页能读到，签到 POST 被吊到超时（线上糊涂鳄的真实情形）
            if (lastMethod === 'POST') return { status: 'failed', error: '中继执行超时：请求已发出但没收到回包', method: lastMethod, url: lastUrl };
            return { status: 'done', resp_status: 200, resp_headers: '{}', resp_body: home };
          }
          return null;
        },
      };
      return stmt;
    },
    async batch() { return []; },
  };
}

await t('runner：中继超时 → 记「结果未知」（skip）而不是「失败」，并允许自动补跑', async () => {
  const { encryptJSON } = await import('../src/crypto.js');
  const { runAccount } = await import('../src/runner.js');
  const db = fakeDbRelayTimeout();
  const env = { DB: db, ENCRYPT_KEY: 'El771KvGwTGzl6K9C2dqmMOsOBYgF3LR9pIm/FvTEbs=' };
  const credsEnc = await encryptJSON(env, db, { site_url: 'https://dj.hutue.cn', cookie: 'c=x' });
  const account = { id: 21, site: 'hutue', name: '糊涂鳄', creds: credsEnc, meta: '{"execution":"relay"}', enabled: 1 };
  const r = await runAccount(env, account);
  assert.equal(r.status, 'skip', '不能记成 fail，实际：' + r.status + ' / ' + r.message);
  assert.equal(r.retryable, true, '稍后应能自动补跑复核');
  assert.match(r.message, /结果未知/);
  // 写入 runs 的 status 也必须是 skip（面板才不会显示 ❌ 失败）
  assert.equal(db.inserted[0].args[3], 'skip');
});

// ---- relayBacklog：队列堆积时不再往里塞 ----
// 线上现象（2026-09-28）：定时器重叠 + 扩展单飞执行 → 队列里堆了几十条请求，
// 每个都等到 Worker 侧 90 秒超时，面板上满屏「扩展没有在 90 秒内回传」。
await t('relayBacklog：能数出队列里堆着的请求', async () => {
  const { relayBacklog } = await import('../src/lib/relay.js');
  const db = { prepare: () => ({ bind() { return this; }, async first() { return { n: 7 }; } }) };
  assert.equal(await relayBacklog(db), 7);
  const bad = { prepare: () => { throw new Error('no table'); } };
  assert.equal(await relayBacklog(bad), 0, '老库没有 relay_jobs 表时不能报错');
});

await t('runner：中继队列已堆积 → 跳过（不添乱）且可自动重试', async () => {
  const { encryptJSON } = await import('../src/crypto.js');
  const { runAccount } = await import('../src/runner.js');
  const inserted = [];
  const db = {
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async run() { if (/INSERT INTO runs/i.test(sql)) inserted.push(stmt._args); return {}; },
        async all() { return { results: [] }; },
        async first() {
          if (/FROM settings/i.test(sql)) return { value: String(Date.now()) };      // 扩展在线
          if (/COUNT\(\*\)/i.test(sql)) return { n: 9 };                              // 队列堆积
          return null;
        },
      };
      return stmt;
    },
    async batch() { return []; },
  };
  const env = { DB: db, ENCRYPT_KEY: 'El771KvGwTGzl6K9C2dqmMOsOBYgF3LR9pIm/FvTEbs=' };
  const credsEnc = await encryptJSON(env, db, { cookie: 'c=x' });
  const account = { id: 31, site: 'nodeseek', name: 'NS忙', creds: credsEnc, meta: '{"execution":"relay"}', enabled: 1 };
  let hitSite = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { hitSite = true; return { status: 200, text: async () => '{}' }; };
  let r;
  try { r = await runAccount(env, account); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'skip');
  assert.equal(r.retryable, true);
  assert.match(r.message, /中继正忙/);
  assert.equal(hitSite, false, '忙的时候不该再去打站点');
  assert.equal(inserted.length, 1);
});

// ---- 浏览器工单去重 ----
// 线上现象：吾爱破解每分钟被排一次浏览器工单，扩展反复开标签页。
await t('runner：同一账号 10 分钟内不重复排浏览器带路工单', async () => {
  const { encryptJSON } = await import('../src/crypto.js');
  const { runAccount } = await import('../src/runner.js');
  const jobs = [];
  const now = Date.now();
  const db = {
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...a) { stmt._args = a; return stmt; },
        async run() { if (/INSERT INTO browser_manual_jobs/i.test(sql)) jobs.push(stmt._args); return {}; },
        async all() { return { results: [] }; },
        async first() {
          if (/FROM settings/i.test(sql)) return { value: String(now) };
          if (/COUNT\(\*\)/i.test(sql)) return { n: 0 };
          if (/FROM browser_manual_jobs/i.test(sql)) return { id: 99 }; // 已有一张刚排的工单
          return null;
        },
      };
      return stmt;
    },
    async batch() { return []; },
  };
  const env = { DB: db, ENCRYPT_KEY: 'El771KvGwTGzl6K9C2dqmMOsOBYgF3LR9pIm/FvTEbs=' };
  const credsEnc = await encryptJSON(env, db, { cookie: 'c=x' });
  const account = { id: 32, site: 'wuaipojie', name: '吾爱', creds: credsEnc, meta: '{}', enabled: 1 };
  const r = await runAccount(env, account);
  assert.equal(r.status, 'skip');
  assert.equal(jobs.length, 0, '已有工单时不应再排一张');
});

// ---- relayFetch 的透传与容错 ----
// ① foreground：站点用 `fetch(url, { foreground: true })` 声明「超时可以把这个标签页提到前台重试」
//    （README 与文档里写明的唯一开关）。它必须真的进到任务里 —— 曾经 relayFetch 漏传这个字段，
//    于是无论怎么声明都不会抢焦点，那个开关等于不存在。
// ② 回传的响应头不是合法 JSON 时，不能把异常抛在「解析结果」这一步，
//    那会让面板把「链路小毛病」误报成站点的问题。
function fakeRelayDb(job) {
  const inserted = [];
  return {
    inserted,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...a) { stmt._args = a; return stmt; },
        async run() { if (/INSERT INTO relay_jobs/i.test(sql)) inserted.push(stmt._args); return {}; },
        async first() { return job; },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
  };
}

await t('relayFetch：foreground 声明必须传到任务里（否则那个开关永远不会生效）', async () => {
  const { relayFetch } = await import('../src/lib/relay.js');
  const b64 = Buffer.from('{"ok":true}', 'utf8').toString('base64');
  const db = fakeRelayDb({ status: 'done', resp_status: 200, resp_headers: '{}', resp_body: b64, method: 'POST', url: 'https://x/y' });
  const res = await relayFetch(db, 'https://x/y', { method: 'POST', body: 'a=1', foreground: true });
  assert.equal(res.status, 200);
  const opts = JSON.parse(db.inserted[0][5]);
  assert.equal(opts.foreground, true, 'foreground 必须进 options');
});

await t('relayFetch：不声明 foreground 时不会抢焦点（默认关闭）', async () => {
  const { relayFetch } = await import('../src/lib/relay.js');
  const db = fakeRelayDb({ status: 'done', resp_status: 200, resp_headers: '{}', resp_body: 'e30=', method: 'GET', url: 'https://x/y' });
  await relayFetch(db, 'https://x/y', {});
  const opts = JSON.parse(db.inserted[0][5]);
  assert.equal(opts.foreground, undefined);
});

await t('中继：回传的头不是合法 JSON 时照旧把响应交给站点（不许在这里抛错）', async () => {
  const b64 = Buffer.from('{"status":"0"}', 'utf8').toString('base64');
  const db = fakeRelayDb({ status: 'done', resp_status: 200, resp_headers: '{{{坏掉的头', resp_body: b64, method: 'GET', url: 'https://x/y' });
  const r = await waitRelayResult(db, 'r9', 300, 20);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.headers), []);
  assert.equal(new TextDecoder().decode(r.body), '{"status":"0"}');
});

console.log(`\n${n} 组通过`);
