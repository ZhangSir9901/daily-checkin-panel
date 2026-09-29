// akile 模块测试：node test/akile.test.mjs（纯 mock，不依赖网络）
// token 方式：签到直接用 Authorization 头；临期/失效自动 refreshToken 并回写 D1
import assert from 'node:assert/strict';
import { akile, jwtExp } from '../src/sites/akile.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// mock fetch：按 URL 返回预设响应；支持按顺序返回多个响应
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    globalThis.__calls = calls;
    for (const [match, resp] of routes) {
      if (String(url).includes(match)) {
        const body = typeof resp === 'function' ? resp(calls.length) : resp;
        const status = body && body.__http ? body.__http : 200;
        return { status, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    throw new Error('unexpected url: ' + url);
  };
}

// 构造一个 exp 为 now+delta 秒的假 JWT（签名部分随意，jwtExp 只读 payload）
function fakeJwt(expDeltaSec) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expDeltaSec })}.sig`;
}
const LONG_TOKEN = fakeJwt(30 * 86400); // 30 天后过期：不触发主动刷新
const SOON_TOKEN = fakeJwt(3600);       // 1 小时后过期：触发主动刷新
const NEW_TOKEN = fakeJwt(30 * 86400);

const checkinOk = { status_code: 0, status_msg: '签到成功', data: { amount: 8 } };
const checkinDup = { status_code: 1, status_msg: '今日已签到' };
const authErr = { status_code: 401, status_msg: 'token已过期' };
const refreshOk = (tok) => ({ status_code: 0, status_msg: 'ok', data: { token: tok } });

// 伪造 ctx：验证 saveToken 的 D1 回写
function fakeCtx() {
  const writes = [];
  const FIXED_KEY = Buffer.alloc(32, 7).toString('base64');
  const db = {
    prepare: (sql) => ({
      bind: (...args) => ({ run: async () => { writes.push({ sql, args }); return {}; } }),
      first: async () => ({ value: FIXED_KEY }),
    }),
  };
  return { ctx: { env: {}, db, account: { id: 'acc1' } }, writes };
}

await t('签到成功（token 直接带在 Authorization 头）', async () => {
  mockFetch([['/v1/user/Checkin', checkinOk]]);
  const r = await akile.run({ token: LONG_TOKEN });
  assert.equal(r.ok, true);
  assert.match(r.message, /8/);
  const req = globalThis.__calls[0];
  assert.equal(req.init.headers.Authorization, LONG_TOKEN);
  assert.ok(!String(req.init.headers.Authorization).toLowerCase().startsWith('bearer'));
});

await t('重复签到判为成功', async () => {
  mockFetch([['/v1/user/Checkin', checkinDup]]);
  const r = await akile.run({ token: LONG_TOKEN });
  assert.equal(r.ok, true);
  assert.match(r.message, /已签到/);
});

await t('缺 token 报错提示获取方式', async () => {
  await assert.rejects(akile.run({ token: '' }), /akile-token/);
});

await t('临近过期：先刷新再签到，并回写 D1', async () => {
  mockFetch([
    ['/v1/user/refreshToken', refreshOk(NEW_TOKEN)],
    ['/v1/user/Checkin', checkinOk],
  ]);
  const { ctx, writes } = fakeCtx();
  const r = await akile.run({ token: SOON_TOKEN }, ctx);
  assert.equal(r.ok, true);
  // 第一个请求应是 refreshToken
  assert.ok(globalThis.__calls[0].url.includes('refreshToken'));
  // D1 回写了新 token
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /UPDATE accounts/);
});

await t('签到时 token 失效：刷新后重试成功', async () => {
  let c = 0;
  mockFetch([
    ['/v1/user/refreshToken', refreshOk(NEW_TOKEN)],
    ['/v1/user/Checkin', () => (++c === 1 ? authErr : checkinOk)],
  ]);
  const { ctx, writes } = fakeCtx();
  const r = await akile.run({ token: LONG_TOKEN }, ctx);
  assert.equal(r.ok, true);
  assert.equal(writes.length, 1);
});

await t('刷新也失败：提示重新获取 token', async () => {
  mockFetch([
    ['/v1/user/refreshToken', { status_code: 401, status_msg: '无效token' }],
    ['/v1/user/Checkin', authErr],
  ]);
  await assert.rejects(akile.run({ token: LONG_TOKEN }), /重新.*akile-token/);
});

// ---------- 线上踩坑 2026-09-29：用户一直在更新 **Cookie**，面板却总说「登录已过期」----------
// Akile 要的是 localStorage 里的 akile-token（JWT），两者存放在完全不同的地方，
// 粘错了必须当场说清，而不是白打一次请求再回一句含糊的话。
await t('把 Cookie 粘进 token 框：直接说清「Akile 不吃 Cookie」', async () => {
  mockFetch([['any', checkinOk]]);
  globalThis.__calls = []; // 该用例期待「一次请求都不发」，先清掉上一个用例的计数
  await assert.rejects(
    akile.run({ token: 'PHPSESSID=abc123; cdn_sec_tc=xyz; foo=1' }),
    // 提示里要指出该去哪儿拿，而不是只骂一句
    /不吃 Cookie[\s\S]*localStorage[\s\S]*akile-token/,
  );
  assert.equal((globalThis.__calls || []).length, 0, '形态明显不对时不该发请求');
});

await t('token 已过期：报错里带上它自己的到期时间', async () => {
  const dead = fakeJwt(-3600); // 1 小时前就过期了
  mockFetch([
    ['/v1/user/refreshToken', { status_code: 401, status_msg: '无效token' }],
    ['/v1/user/Checkin', authErr],
  ]);
  const err = await akile.run({ token: dead }).catch((e) => e);
  assert.match(err.message, /已经过期了/);
  assert.match(err.message, /akile-token/);
  // 报错里要有具体的到期时刻（用户拿它跟自己登录的时间对一下就知道差在哪）
  assert.match(err.message, /\d{4}\/\d{1,2}\/\d{1,2}/, '要写出具体时间，实际：' + err.message);
});

await t('jwtExp 解析', async () => {
  assert.ok(jwtExp(fakeJwt(86400)) > Date.now() / 1000);
  assert.equal(jwtExp('not-a-jwt'), 0);
  assert.equal(jwtExp(''), 0);
});

console.log(`\n${n} passed`);
