// Set-Cookie 静默回写测试：node test/cookie-refresh.test.mjs
//
// 背景：借鉴 OpenList quark 驱动「响应 Set-Cookie 里轮换出新 Cookie → 静默写回存储」
// 的做法。站点模块签到成功时可通过 res.cookieRefresh 带回新 Cookie，runner 合并
// 进账号凭据并加密存回 D1。只测三件事：
//   ① 站点侧：Set-Cookie 能被收集成 cookieRefresh 带回来；
//   ② runner 侧：合并逻辑对（标准 cookie 字段 / headers JSON / 多步 steps / 模板跳过）；
//   ③ 无变化时不写库，写库后能解密还原。
import assert from 'node:assert/strict';
import { runHttpSteps } from '../src/sites/http.js';
import { v2ex } from '../src/sites/v2ex.js';
import { applyCookieRefresh } from '../src/runner.js';
import { decryptJSON } from '../src/crypto.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// 32 字节 base64，符合 ENCRYPT_KEY 校验
const ENCRYPT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const env = { ENCRYPT_KEY };

// 带 Set-Cookie 的 fetch 仿真（Workers 下 getSetCookie 语义）
function mockFetch(handler) {
  globalThis.fetch = async (url, init = {}) => {
    const r = handler(String(url), init);
    return {
      status: r.status || 200,
      headers: {
        getSetCookie: () => r.setCookies || [],
        get: () => null,
      },
      text: async () => r.body || '',
    };
  };
}

// 极简 D1 仿真：只记录 UPDATE accounts creds 的写入
function makeDb() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...a) { stmt._args = a; return stmt; },
        async run() {
          if (/UPDATE accounts SET creds/i.test(sql)) writes.push({ args: stmt._args });
          return {};
        },
        async first() { return null; },
      };
      return stmt;
    },
  };
}

// ---------- ① 站点侧收集 ----------

await t('runHttpSteps：多步的 Set-Cookie 被收集成 cookieRefresh', async () => {
  mockFetch((url) => {
    if (url.includes('/login')) return { body: '{"ok":1}', setCookies: ['sess=AAA; Path=/; HttpOnly'] };
    return { body: '{"ok":1}', setCookies: ['sess=BBB; Path=/; HttpOnly', 'trk=1; Path=/'] };
  });
  const r = await runHttpSteps([
    { name: '登录', method: 'POST', url: 'https://ex.com/login' },
    { name: '签到', method: 'POST', url: 'https://ex.com/sign' },
  ]);
  assert.equal(r.ok, true);
  // 同名以后者为准：sess=BBB；trk=1 新增
  assert.equal(r.cookieRefresh, 'sess=BBB; trk=1');
});

await t('runHttpSteps：没有 Set-Cookie 时不带 cookieRefresh', async () => {
  mockFetch(() => ({ body: '{"ok":1}' }));
  const r = await runHttpSteps([{ name: '签到', method: 'GET', url: 'https://ex.com/sign' }]);
  assert.equal(r.ok, true);
  assert.equal('cookieRefresh' in r, false);
});

await t('v2ex：已签到 + 响应带 Set-Cookie → 返回 cookieRefresh', async () => {
  mockFetch(() => ({ body: '<html>每日登录奖励已领取</html>', setCookies: ['A2=NEW123; Path=/; HttpOnly'] }));
  const r = await v2ex.run({ cookie: 'A2=OLD' });
  assert.equal(r.ok, true);
  assert.equal(r.cookieRefresh, 'A2=NEW123');
});

await t('v2ex：无 Set-Cookie 时不带 cookieRefresh', async () => {
  mockFetch(() => ({ body: '<html>每日登录奖励已领取</html>' }));
  const r = await v2ex.run({ cookie: 'A2=OLD' });
  assert.equal(r.ok, true);
  assert.equal('cookieRefresh' in r, false);
});

// ---------- ② runner 侧合并 ----------

await t('applyCookieRefresh：标准 cookie 字段合并（同名覆盖、异名保留）', async () => {
  const db = makeDb();
  const creds = { cookie: 'a=1; b=2' };
  const changed = await applyCookieRefresh(env, db, { id: 7 }, creds, 'b=3; c=4');
  assert.equal(changed, true);
  assert.equal(creds.cookie, 'a=1; b=3; c=4');
  assert.equal(db.writes.length, 1);
  // 写库的是加密串，且能解密还原
  const back = await decryptJSON(env, db, db.writes[0].args[0]);
  assert.equal(back.cookie, 'a=1; b=3; c=4');
});

await t('applyCookieRefresh：内容无变化时不写库', async () => {
  const db = makeDb();
  const creds = { cookie: 'a=1; b=2' };
  const changed = await applyCookieRefresh(env, db, { id: 7 }, creds, 'a=1; b=2');
  assert.equal(changed, false);
  assert.equal(db.writes.length, 0);
});

await t('applyCookieRefresh：空 refresh 直接返回 false', async () => {
  const db = makeDb();
  const changed = await applyCookieRefresh(env, db, { id: 7 }, { cookie: 'a=1' }, '   ');
  assert.equal(changed, false);
  assert.equal(db.writes.length, 0);
});

await t('applyCookieRefresh：自定义 HTTP 单步 headers JSON 里的 Cookie 头被合并', async () => {
  const db = makeDb();
  const creds = { headers: JSON.stringify({ Cookie: 'sess=OLD', 'User-Agent': 'UA/1' }) };
  const changed = await applyCookieRefresh(env, db, { id: 7 }, creds, 'sess=NEW');
  assert.equal(changed, true);
  const h = JSON.parse(creds.headers);
  assert.equal(h.Cookie, 'sess=NEW');
  assert.equal(h['User-Agent'], 'UA/1'); // 别的头不动
});

await t('applyCookieRefresh：模板写法 {{cookie}} 的 headers 不动（真值在 creds.cookie 里）', async () => {
  const db = makeDb();
  const creds = { cookie: 'sess=OLD', headers: JSON.stringify({ Cookie: '{{cookie}}' }) };
  const changed = await applyCookieRefresh(env, db, { id: 7 }, creds, 'sess=NEW');
  assert.equal(changed, true);
  assert.equal(creds.cookie, 'sess=NEW');
  assert.equal(JSON.parse(creds.headers).Cookie, '{{cookie}}'); // 模板原样保留
});

await t('applyCookieRefresh：多步 steps 里带 Cookie 头的步骤被合并', async () => {
  const db = makeDb();
  const creds = {
    steps: [
      { name: '登录', url: 'https://ex.com/login', headers: JSON.stringify({ Cookie: 'sess=OLD' }) },
      { name: '签到', url: 'https://ex.com/sign', headers: JSON.stringify({ 'X-T': '1' }) },
    ],
  };
  const changed = await applyCookieRefresh(env, db, { id: 7 }, creds, 'sess=NEW; x=9');
  assert.equal(changed, true);
  assert.equal(JSON.parse(creds.steps[0].headers).Cookie, 'sess=NEW; x=9');
  assert.equal(JSON.parse(creds.steps[1].headers).Cookie, undefined); // 没 Cookie 头的不动
});

await t('applyCookieRefresh：headers 不是合法 JSON 时跳过、不抛错', async () => {
  const db = makeDb();
  const creds = { cookie: 'a=1', headers: 'not json' };
  const changed = await applyCookieRefresh(env, db, { id: 7 }, creds, 'a=2');
  assert.equal(changed, true);
  assert.equal(creds.cookie, 'a=2');
  assert.equal(creds.headers, 'not json');
});

console.log(`\n✅ cookie-refresh.test.mjs：${n} 组通过`);
