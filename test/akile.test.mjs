// akile 模块测试：node test/akile.test.mjs（纯 mock，不依赖网络）
import assert from 'node:assert/strict';
import { akile } from '../src/sites/akile.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// mock fetch：按 URL 返回预设响应
function mockFetch(routes) {
  globalThis.fetch = async (url, init = {}) => {
    for (const [match, resp] of routes) {
      if (String(url).includes(match)) {
        // 记录请求以便断言
        globalThis.__lastReq = { url: String(url), init };
        return { status: 200, json: async () => resp, text: async () => JSON.stringify(resp) };
      }
    }
    throw new Error('unexpected url: ' + url);
  };
}

const TOKEN = 'tok_abc123';
const loginOk = { status_code: 0, status_msg: '登录成功', data: { userId: 8318, token: TOKEN } };

await t('登录+签到成功', async () => {
  mockFetch([
    ['/v1/user/login', loginOk],
    ['/v1/user/Checkin', { status_code: 0, status_msg: '签到成功', data: { amount: 8 } }],
  ]);
  const r = await akile.run({ email: 'a@b.c', password: 'pw' });
  assert.equal(r.ok, true);
  assert.match(r.message, /8/);
  // 鉴权头为纯 token（无 Bearer 前缀）
  assert.equal(globalThis.__lastReq.init.headers.Authorization, TOKEN);
  assert.equal(globalThis.__lastReq.init.method, 'GET');
});

await t('登录请求为 POST JSON 且带邮箱密码', async () => {
  let loginReq;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/v1/user/login')) {
      loginReq = { url: String(url), init };
      return { status: 200, json: async () => loginOk, text: async () => '{}' };
    }
    return { status: 200, json: async () => ({ status_code: 0, status_msg: 'ok', data: null }), text: async () => '{}' };
  };
  await akile.run({ email: 'a@b.c', password: 'pw' });
  assert.equal(loginReq.init.method, 'POST');
  assert.match(loginReq.init.headers['Content-Type'], /application\/json/);
  assert.deepEqual(JSON.parse(loginReq.init.body), { email: 'a@b.c', password: 'pw' });
});

await t('今日已签到视为成功', async () => {
  mockFetch([
    ['/v1/user/login', loginOk],
    ['/v1/user/Checkin', { status_code: 1, status_msg: '今日已签到', data: null }],
  ]);
  const r = await akile.run({ email: 'a@b.c', password: 'pw' });
  assert.equal(r.ok, true);
  assert.match(r.message, /已签到/);
});

await t('登录失败抛错', async () => {
  mockFetch([['/v1/user/login', { status_code: 1001, status_msg: '邮箱或密码错误', data: null }]]);
  await assert.rejects(() => akile.run({ email: 'a@b.c', password: 'bad' }), /邮箱或密码错误/);
});

await t('签到失败抛错', async () => {
  mockFetch([
    ['/v1/user/login', loginOk],
    ['/v1/user/Checkin', { status_code: 500, status_msg: '系统繁忙', data: null }],
  ]);
  await assert.rejects(() => akile.run({ email: 'a@b.c', password: 'pw' }), /系统繁忙/);
});

await t('缺凭据抛错', async () => {
  await assert.rejects(() => akile.run({ email: '', password: '' }), /请填写/);
});

await t('站点元信息完整', async () => {
  assert.equal(akile.id, 'akile');
  assert.ok(akile.fields.find((f) => f.key === 'email' && f.required));
  assert.ok(akile.fields.find((f) => f.key === 'password' && f.type === 'password'));
});

console.log(`\n${n} 组通过`);
