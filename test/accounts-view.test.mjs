// /api/accounts（读账号列表）的「状态 + 反馈」自洽性：node test/accounts-view.test.mjs
//
// 线上真实现象（糊涂鳄，2026-09-28）：
//   今天 10:54 已经签上了，12:07 的一次补跑撞上「中继执行超时」，那一行就变成
//   「状态：✅ 已签到 + 反馈：签到失败：…中继执行超时（45秒）」—— 自相矛盾，
//   用户只能理解为「面板坏了」。修法：读列表时顺手把反馈回填成今天那次成功的原话
//   （失败那一笔仍然完整留在运行日志里）。
//
// 另一个易错点：「今天」得按**站点自己的日界**算 —— 糊涂鳄按 UTC 计日，
// 拿面板时区（Asia/Shanghai）去比，00:00–08:00 之间会把昨天当成今天。
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { dayInTz } from '../src/schedule.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const SID = 'sid_test_1';
const OK_MSG = '今日已签到，请明日再来';
const OK_DETAIL = '网站返回：{"status":"0"} · 接口 user_qiandao';
const FAIL_MSG = '签到失败：本地网络失败：中继执行超时（45秒），已放弃该请求';

function fakeDb(account) {
  const state = { accountUpdates: [] };
  return {
    state,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async first() {
          if (/FROM sessions WHERE id/i.test(sql)) return { expires_at: Date.now() + 3600000 };
          if (/FROM settings/i.test(sql)) {
            return stmt._args[0] === 'schedule_tz' ? { value: 'Asia/Shanghai' } : null;
          }
          if (/SELECT id FROM runs/i.test(sql)) return { id: 1 };
          if (/FROM runs/i.test(sql)) return { message: OK_MSG, detail: OK_DETAIL };
          return null;
        },
        async all() {
          if (/FROM accounts\b/i.test(sql)) return { results: [account] };
          return { results: [] };
        },
        async run() {
          if (/UPDATE accounts/i.test(sql)) state.accountUpdates.push(stmt._args);
          return {};
        },
      };
      return stmt;
    },
    async batch() { return []; },
  };
}

async function get(account) {
  const db = fakeDb(account);
  const env = { DB: db };
  const req = new Request('https://panel.test/api/accounts', { headers: { cookie: `sid=${SID}` } });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  return { body: await res.json(), db };
}

const hutueToday = dayInTz(new Date(), 'UTC'); // 糊涂鳄按 UTC 计日

await t('已签上但最近一条是失败 → 反馈回填成今天那次成功的网站原话', async () => {
  const { body, db } = await get({
    id: 7, name: '单机', site: 'hutue', enabled: 1,
    meta: JSON.stringify({ last_signin_date: hutueToday, exec_route: 'server' }),
    last_status: 'fail', last_msg: FAIL_MSG, last_detail: '网站返回：（无响应）',
    last_run_at: Date.now() - 3600000,
  });
  const a = body.accounts[0];
  assert.equal(a.last_status, 'ok', '账号行状态应是「已签到」');
  assert.equal(a.last_msg, OK_MSG, '反馈应是今天那次成功的原话，实际：' + a.last_msg);
  assert.match(a.last_detail, /user_qiandao/, '网站原文也要一起回填');
  assert.equal(db.state.accountUpdates.length, 1, '应该落库，不能每次刷新都重算');
});

await t('「今天」按站点日界算：UTC 站点不能被面板时区带偏', async () => {
  // 面板时区（Asia/Shanghai）与站点日界（UTC）在 00:00–08:00 之间是**两个不同的「今天」**。
  // 回填必须写站点日界的今天，否则 08:00 之后面板会以为「今天已签」，而站点认为已是新的一天。
  const { body } = await get({
    id: 7, name: '单机', site: 'hutue', enabled: 1,
    meta: JSON.stringify({ last_signin_date: dayInTz(new Date(), 'Asia/Shanghai') }),
    last_status: 'skip', last_msg: '需要浏览器扩展在线（本地网络中继）。', last_detail: '',
    last_run_at: Date.now() - 60000,
  });
  assert.equal(JSON.parse(body.accounts[0].meta).last_signin_date, hutueToday,
    '应写站点日界（UTC）的今天');
  assert.equal(body.accounts[0].last_status, 'ok');
});

await t('本来就是「已签到 + 成功反馈」→ 不做无谓写库', async () => {
  const { db } = await get({
    id: 7, name: '单机', site: 'hutue', enabled: 1,
    meta: JSON.stringify({ last_signin_date: hutueToday }),
    last_status: 'ok', last_msg: OK_MSG, last_detail: OK_DETAIL,
    last_run_at: Date.now() - 60000,
  });
  assert.equal(db.state.accountUpdates.length, 0);
});

await t('今天没有成功记录 → 保持原样，不凭空造一个「已签到」', async () => {
  const db = fakeDb({
    id: 7, name: '单机', site: 'hutue', enabled: 1,
    meta: JSON.stringify({}),
    last_status: 'fail', last_msg: FAIL_MSG, last_detail: '',
    last_run_at: Date.now() - 60000,
  });
  // 这次让 runs 查不到成功记录（first() 返回 null）
  const origFirst = db.prepare;
  db.prepare = (sql) => {
    const stmt = origFirst(sql);
    if (/FROM runs/i.test(sql)) stmt.first = async () => null;
    return stmt;
  };
  const res = await worker.fetch(
    new Request('https://panel.test/api/accounts', { headers: { cookie: `sid=${SID}` } }),
    { DB: db }, { waitUntil() {} },
  );
  const a = (await res.json()).accounts[0];
  assert.equal(a.last_status, 'fail', '没签上就是没签上');
  assert.equal(a.last_msg, FAIL_MSG);
  assert.equal(db.state.accountUpdates.length, 0);
});

console.log(`\n${n} 组通过`);
