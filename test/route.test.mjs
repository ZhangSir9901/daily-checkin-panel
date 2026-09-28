// 执行路线（HTTP 从哪个网络出去）测试：node test/route.test.mjs
//
// 背景（线上 2026-09-28 实测）：糊涂鳄 dj.hutue.cn 从 Cloudflare 直连**完全正常**
// —— 首页 200、签到接口 0.4 秒回 {"status":"0","msg":"今日已签到，请明日再来"}。
// 但旧策略是「扩展在线就一律走本地中继」，中继是单飞执行，前面吾爱破解的浏览器工单
// 要占掉将近一分钟，糊涂鳄就被挤成「中继执行超时（45秒）」→ 面板记「失败」，
// 网站那边其实早就签好了：用户看到的就是「面板跟网站对不上」。
//
// 本文件钉住修好之后的规矩：
//   ① 站点默认 server 的账号（糊涂鳄），自动模式先走「CF 直连」，不该碰中继队列；
//   ② 直连走不通（网络层失败）→ 自动换本地网络，并把换路写进 meta.route_note；
//   ③ 站点已给出业务结论（Cookie 失效 / 人机验证）→ 不换路，不白打第二遍；
//   ④ 手动固定的路线不许被偷偷换掉。
import assert from 'node:assert/strict';
import { encryptJSON } from '../src/crypto.js';
import { runAccount, isRouteFailure } from '../src/runner.js';
import { getSite } from '../src/sites/index.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const origFetch = globalThis.fetch; // 每个用例收尾都还原，避免相互污染

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const HOME = '<!DOCTYPE html><html><head><link rel="stylesheet" href="/wp-content/themes/ripro/assets/css/main.css"></head>'
  + '<body><a class="click-qiandao zzhuti_qd_1" href="javascript:;">打卡签到</a></body></html>';
const OK_JSON = JSON.stringify({ status: '1', msg: '签到成功，赠送5晶石' });

// 极简 D1 fake：够 runner + lib/relay.js 跑完一条链路
function fakeDb({ relayOnline = true, relayBody = OK_JSON, backlog = 0, lastOkRun = null } = {}) {
  const state = { relayJobs: [], runs: [], accountUpdates: [] };
  const jobs = {};
  return {
    state,
    jobs,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async run() {
          if (/INSERT INTO relay_jobs/i.test(sql)) {
            state.relayJobs.push({ id: stmt._args[0], url: stmt._args[1], method: stmt._args[2] });
            // 扩展「立刻领走并回传」：中继一旦被使用，就一定能拿到响应
            jobs[stmt._args[0]] = { status: 'done', resp_status: 200, resp_headers: '{}', resp_body: b64(relayBody) };
          }
          if (/INSERT INTO runs/i.test(sql)) state.runs.push(stmt._args);
          if (/UPDATE accounts/i.test(sql)) state.accountUpdates.push(stmt._args);
          return {};
        },
        async all() { return { results: [] }; },
        async first() {
          if (/COUNT\(\*\)/i.test(sql)) return { n: backlog };
          if (/FROM settings/i.test(sql)) {
            const key = stmt._args[0];
            if (key === 'relay_last_poll') return { value: String(relayOnline ? Date.now() : Date.now() - 10 * 60000) };
            if (key === 'schedule_tz') return { value: 'Asia/Shanghai' };
            return null;
          }
          if (/FROM relay_jobs WHERE id = \?/i.test(sql)) return jobs[stmt._args[0]] || null;
          // 今天最近一次成功记录（runner 在「已签过又被补跑失败」时要拿它回填账号行）
          if (/FROM runs/i.test(sql) && /status = 'ok'/i.test(sql)) return lastOkRun;
          return null;
        },
      };
      return stmt;
    },
    async batch() { return []; },
  };
}

async function account(db, site, meta) {
  const env = { DB: db, ENCRYPT_KEY: 'El771KvGwTGzl6K9C2dqmMOsOBYgF3LR9pIm/FvTEbs=' };
  const creds = await encryptJSON(env, db, { site_url: 'https://dj.hutue.cn', cookie: 'c=x' });
  return { env, acc: { id: 7, site, name: '单机', creds, meta: JSON.stringify(meta), enabled: 1 } };
}

// 直连侧：按 URL 给响应（绝对不带中继）
function mockServerFetch({ fail = false, home = HOME, post = OK_JSON } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || 'GET' });
    if (fail) throw new TypeError('fetch failed');
    const body = u.endsWith('/') ? home : post;
    return { status: 200, text: async () => body };
  };
  return calls;
}

// ---- ① 站点声明：糊涂鳄默认 server（直连实测可用，不需要中继） ----
await t('糊涂鳄站点默认走 CF 直连（execution=server），不再默认依赖中继', async () => {
  const s = getSite('hutue');
  assert.ok(s, 'hutue 站点应已注册');
  assert.equal(s.execution, 'server', '糊涂鳄从 CF 直连实测正常，默认路线必须是 server');
});

await t('自动模式 + server 站点 + 扩展在线：先走直连，**不碰**中继队列', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', {}); // meta.execution 为空 = 自动
  const calls = mockServerFetch();
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok', '直连应该就能签上，实际：' + r.message);
  assert.equal(db.state.relayJobs.length, 0, '自动模式不该把糊涂鳄塞进中继队列（这正是线上超时的根因）');
  assert.ok(calls.some((c) => c.url === 'https://dj.hutue.cn/'), '应直连访问过站点首页');
  const meta = JSON.parse(db.state.accountUpdates[0][4]);
  assert.equal(meta.exec_route, 'server', '应记住「直连走通了」，下次优先直连');
  assert.equal(meta.route_note, '路线：CF 直连', '没换路时只记路线，不该有换路文案');
});

// ---- ② 直连走不通 → 自动改走本地网络 ----
await t('直连网络层失败时自动改走本地网络，并如实记下「换过路」', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', {});
  mockServerFetch({ fail: true }); // 直连：连不上
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok', '换到本地网络后应该签上，实际：' + r.message);
  assert.ok(db.state.relayJobs.length > 0, '直连不通时必须真的走中继');
  const meta = JSON.parse(db.state.accountUpdates[0][4]);
  assert.equal(meta.exec_route, 'relay', '应记住「本地网络走通了」');
  assert.match(meta.route_note, /自动改走/, '换过路要写进 route_note，实际：' + meta.route_note);
  assert.match(meta.route_note, /CF 直连失败/, '要写清楚是哪条路线失败才换的，实际：' + meta.route_note);
});

await t('记住的路线优先：exec_route=relay 的账号先走本地网络，不再先试直连', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', { exec_route: 'relay' });
  const calls = mockServerFetch(); // 直连侧不该被调到
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok');
  assert.ok(db.state.relayJobs.length >= 1, '应直接走中继');
  assert.ok(db.state.relayJobs.some((j) => j.url === 'https://dj.hutue.cn/'), '中继里应能看到站点首页请求');
  assert.equal(calls.length, 0, '记住 relay 后不该再先打一次直连');
});

// ---- ③ 业务结论不换路（换个网络出口结果一样，白跑还多打一次签到接口） ----
await t('站点回「Cookie 已失效」时**不**换路线（业务结论与网络出口无关）', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', {});
  const LOGIN_HOME = '<html><body><form id="loginform" action="/wp-login.php" method="post">'
    + '<input name="log"><input name="pwd"></form></body></html>';
  mockServerFetch({ home: LOGIN_HOME });
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'fail');
  assert.match(r.message, /Cookie 已失效/);
  assert.equal(db.state.relayJobs.length, 0, '业务结论不该触发换路（白跑一次中继）');
  const meta = JSON.parse(db.state.accountUpdates[0][4]);
  assert.equal(meta.route_note, undefined, '没走通的这一次不该留路线记录');
});

await t('扩展离线时：走不通的路线不白打（直连被跳过时不会去中继队列排队）', async () => {
  const db = fakeDb({ relayOnline: false });
  const { env, acc } = await account(db, 'hutue', { exec_route: 'relay' });
  mockServerFetch({ fail: true });
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  // 记住的是 relay，但扩展离线：不该死等中继，应换直连（失败也是真实结果）
  assert.equal(db.state.relayJobs.length, 0, '扩展离线时不该往中继队列里塞任务');
});

// ---- ④ 手动固定路线不许被偷偷换掉 ----
await t('手动固定「CF 网络」时，即使直连失败也不许偷偷走中继', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', { execution: 'server' });
  mockServerFetch({ fail: true });
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  // 直连连不上时站点模块会把结论定为「结果未知」（请求可能送到、也可能没送到）——
  // 这里不冒充成功也不武断说失败，重点是：手动固定的路线不许被自动换成中继。
  assert.equal(r.status, 'skip', '直连连不上 → 记「待确认」，实际：' + r.status + ' / ' + r.message);
  assert.equal(db.state.relayJobs.length, 0, '手动固定的路线不许被自动换掉');
});

await t('手动固定「本地网络」时，走的就是中继（不做直连兜底）', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', { execution: 'relay' });
  const calls = mockServerFetch({});
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok');
  assert.equal(calls.length, 0, '手动指定中继时不该有直连请求');
  assert.ok(db.state.relayJobs.length >= 1, '手动指定中继就该真的走中继');
});

// ---- ⑤ 已签到当天：补跑失败不许改写「今天的结果」 ----
await t('今天已签上过，之后一次补跑失败不会把账号行改成「已签到 + 签到失败」', async () => {
  const { dayInTz } = await import('../src/schedule.js');
  const todayUtc = dayInTz(new Date(), 'UTC'); // 糊涂鳄按 UTC 计日
  const okMsg = '今日已签到，请明日再来';
  const db = fakeDb({ lastOkRun: { message: okMsg, detail: '网站返回：{"status":"0"} · 接口 user_qiandao' } });
  const { env, acc } = await account(db, 'hutue', { last_signin_date: todayUtc, execution: 'server' });
  mockServerFetch({ fail: true }); // 这次补跑连不上（直连失败、且手动固定不许换路）
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  // 运行日志必须如实记下这次失败……
  assert.equal(r.status, 'skip');
  assert.equal(db.state.runs.length, 1);
  assert.equal(db.state.runs[0][3], 'skip');
  // ……但账号那一行显示的是**今天那次成功**的原话（状态与反馈自洽）
  const row = db.state.accountUpdates[0];
  assert.equal(row[0], 'ok', '账号行状态应保持「已签到」');
  assert.equal(row[1], okMsg, '账号行反馈应仍是今天那次成功的网站原话，实际：' + row[1]);
  assert.match(String(row[2] || ''), /user_qiandao/, '网站原文也要回填');
});

// ---- ⑥ 失败分类：哪些才值得换一条网络路线 ----
await t('isRouteFailure：网络层失败算「值得换路」，业务/验证结论不算', async () => {
  assert.equal(isRouteFailure(new Error('等待本地网络响应超时：扩展没有在 90 秒内回传')), true);
  assert.equal(isRouteFailure(new Error('本地网络失败：中继执行超时（45秒），已放弃该请求')), true);
  assert.equal(isRouteFailure(new Error('fetch failed')), true);
  assert.equal(isRouteFailure(new Error('HTTP 403 Forbidden Client IP 1.2.3.4 reason:UrlACL')), true);
  const relayUnknown = new Error('签到结果未知：请求已发出但没等到回包');
  relayUnknown.outcome = 'relay-unknown';
  assert.equal(isRouteFailure(relayUnknown), true, '结果未知时更该换条路问出真相');

  assert.equal(isRouteFailure(new Error('Cookie 已失效，请重新登录后复制新的 Cookie')), false);
  const login = new Error('登录已失效'); login.outcome = 'need-login';
  assert.equal(isRouteFailure(login), false);
  const cap = new Error('遇到人机验证'); cap.outcome = 'captcha';
  assert.equal(isRouteFailure(cap), false);
  assert.equal(isRouteFailure(new Error('签到失败：还没绑定手机号')), false);
});

console.log(`\n${n} 组通过`);
