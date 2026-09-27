// 天翼云盘登录链路测试：node test/cloud189.test.mjs（纯 mock，不依赖网络）
// 覆盖参考项目借鉴来的关键改动：loginUrl.action → appConf.do → needcaptcha.do → loginSubmit，
// 以及 Cookie 缓存复用、失效重登、验证码识别。
import assert from 'node:assert/strict';
import { cloud189, parseNeedCaptcha, rsaEncryptPkcs1 } from '../src/sites/cloud189.js';
import { OUTCOME } from '../src/lib/signals.js';

// 测试用 1024 位 RSA 公钥（SPKI DER base64）
const PUB =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDAzpHHrsf42I0+qFPVa78ltjiwswY2pDHd4a1rKQ2A/fXxqoZSKgMIeu1almrtYY4KMtfuEB1ZLc5JWKBsjyz2Fgn6DmEMkUt0oInJkPozOn164SpU6+6j7x54dhgaUPNUkgJQ77JtQ9Q+9BACFDhTgQFCCRpxMFysAaeQIS5udQIDAQAB';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

function makeRes(body, { status = 200, url = '', setCookies = [] } = {}) {
  return {
    status,
    url,
    headers: { get: () => null, getSetCookie: () => setCookies },
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

// routes: [{ match(url, init) -> bool, res: () => makeRes | makeRes }]
function mockFetch(routes, calls = []) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || 'GET').toUpperCase(), body: init.body || '', headers: init.headers || {} });
    const r = routes.find((x) => x.match(u, init));
    if (!r) throw new Error('unexpected fetch: ' + u);
    return typeof r.res === 'function' ? r.res(u, init) : r.res;
  };
  return calls;
}

const LOGIN_PAGE_URL = 'https://open.e.189.cn/api/logbox/oauth2/loginUrl.action?lt=LT123&reqId=REQ456';

// 一套「登录成功 + 签到成功」的标准应答
function standardRoutes(overrides = {}) {
  const base = {
    loginUrl: (u) => u.includes('loginUrl.action'),
    appConf: (u) => u.includes('appConf.do'),
    encrypt: (u) => u.includes('encryptConf.do'),
    needcaptcha: (u) => u.includes('needcaptcha.do'),
    loginSubmit: (u) => u.includes('loginSubmit.do'),
    toUrl: (u) => u.includes('web/main.action'),
    sign: (u) => u.includes('userSign.action'),
    size: (u) => u.includes('getUserSizeInfo.action'),
  };
  const m = { ...base, ...overrides };
  return [
    { match: (u) => u.includes('loginUrl.action'),
      res: makeRes('<html>login page</html>', { url: LOGIN_PAGE_URL, setCookies: ['JSESSIONID=pre; Path=/'] }) },
    { match: m.appConf,
      res: makeRes(JSON.stringify({ data: { paramId: 'PID-1', returnUrl: 'https://cloud.189.cn/web/main/', mailSuffix: '@189.cn' } })) },
    { match: m.encrypt, res: makeRes(JSON.stringify({ data: { pubKey: PUB, pre: 'PRE' } })) },
    { match: m.needcaptcha, res: makeRes('false') },
    { match: m.loginSubmit, res: makeRes(JSON.stringify({ result: 0, toUrl: 'https://cloud.189.cn/web/main.action' })) },
    { match: (u) => u.includes('web/main.action'), res: makeRes('<html>main</html>', { setCookies: ['SESSION=abc123; Path=/'] }) },
    { match: m.sign, res: makeRes(JSON.stringify({ isSign: false, netdiskBonus: 123 })) },
    { match: m.size, res: makeRes(JSON.stringify({ cloudCapacityInfo: { totalSize: 10 * 1024 * 1024 * 1024 } })) },
  ];
}

// ---------- 1. 完整登录 + 签到成功 ----------
await t('cloud189：完整登录链路并签到成功', async () => {
  const calls = mockFetch(standardRoutes());
  const ctx = { meta: {} };
  const r = await cloud189.run({ username: '13800000000', password: 'pw' }, ctx);

  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
  assert.match(r.message, /123M/);

  const urls = calls.map((c) => c.url);
  const order = ['loginUrl.action', 'appConf.do', 'encryptConf.do', 'needcaptcha.do', 'loginSubmit.do', 'web/main.action', 'userSign.action'];
  const idx = order.map((k) => urls.findIndex((u) => u.includes(k)));
  assert.ok(idx.every((i) => i >= 0), '缺少环节：' + JSON.stringify(order.map((k, i) => [k, idx[i]])));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), '登录环节顺序错误：' + JSON.stringify(idx));

  // 登录参数对齐最新客户端：appKey=cloud / accountType=01 / 密码字段 epd
  const submit = calls.find((c) => c.url.includes('loginSubmit.do'));
  const p = new URLSearchParams(String(submit.body));
  assert.equal(p.get('appKey'), 'cloud');
  assert.equal(p.get('accountType'), '01');
  assert.ok(p.get('epd'), '应使用 epd 作为密码字段');
  assert.equal(p.get('password'), null, '不应再发 password 字段');
  assert.ok(p.get('userName') && p.get('userName').startsWith('PRE'), 'userName 应带 pre 前缀');
  assert.equal(p.get('paramId'), 'PID-1');

  // 签到接口走 api.cloud.189.cn + 移动端 App UA
  const sign = calls.find((c) => c.url.includes('userSign.action'));
  assert.match(sign.url, /^https:\/\/api\.cloud\.189\.cn\/mkt\/userSign\.action/);
  assert.match(sign.url, /clientType=TELEANDROID/);
  assert.match(String(sign.headers['User-Agent']), /Ecloud\/8\.6\.3/);

  // 登录态写入缓存
  assert.ok(ctx.meta.cloud189_cookies && ctx.meta.cloud189_cookies.includes('SESSION=abc123'));
});

// ---------- 2. 登录前检测到需要验证码 ----------
await t('cloud189：needcaptcha=true 时明确报需要验证码', async () => {
  // 覆盖 needcaptcha 应答为 true
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), body: init.body || '', headers: init.headers || {} });
    const u = String(url);
    if (u.includes('loginUrl.action')) return makeRes('<html>login</html>', { url: LOGIN_PAGE_URL });
    if (u.includes('appConf.do')) return makeRes(JSON.stringify({ data: { paramId: 'PID-1' } }));
    if (u.includes('encryptConf.do')) return makeRes(JSON.stringify({ data: { pubKey: PUB, pre: 'PRE' } }));
    if (u.includes('needcaptcha.do')) return makeRes('true');
    throw new Error('不应继续请求：' + u);
  };
  const err = await cloud189.run({ username: '1', password: '2' }, { meta: {} }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.outcome, OUTCOME.CAPTCHA);
  assert.match(err.message, /验证码/);
  assert.ok(!calls.some((c) => c.url.includes('loginSubmit.do')), '检测到验证码后不应再提交登录');
});

// ---------- 3. 今日已签到 ----------
await t('cloud189：isSign=true 判为今日已签到', async () => {
  const routes = standardRoutes();
  routes[routes.length - 2] = { match: (u) => u.includes('userSign.action'), res: makeRes(JSON.stringify({ isSign: true, netdiskBonus: 66 })) };
  mockFetch(routes);
  const r = await cloud189.run({ username: '1', password: '2' }, { meta: {} });
  assert.equal(r.ok, true);
  assert.match(r.message, /今日已签到/);
  assert.match(r.message, /66M/);
});

// ---------- 4. Cookie 缓存命中：跳过登录 ----------
await t('cloud189：登录态缓存命中时不重新登录', async () => {
  const calls = mockFetch(standardRoutes());
  const ctx = { meta: { cloud189_cookies: 'SESSION=cached', cloud189_cookies_at: Date.now() } };
  const r = await cloud189.run({ username: '1', password: '2' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(!calls.some((c) => c.url.includes('loginUrl.action')), '缓存有效时不应走登录');
  const sign = calls.find((c) => c.url.includes('userSign.action'));
  assert.equal(sign.headers.Cookie, 'SESSION=cached');
});

// ---------- 5. 缓存失效：自动重新登录 ----------
await t('cloud189：登录态失效时自动重新登录', async () => {
  const calls = [];
  let signCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || 'GET').toUpperCase(), body: init.body || '', headers: init.headers || {} });
    if (u.includes('loginUrl.action')) return makeRes('<html>login</html>', { url: LOGIN_PAGE_URL });
    if (u.includes('appConf.do')) return makeRes(JSON.stringify({ data: { paramId: 'PID-1' } }));
    if (u.includes('encryptConf.do')) return makeRes(JSON.stringify({ data: { pubKey: PUB, pre: 'PRE' } }));
    if (u.includes('needcaptcha.do')) return makeRes('false');
    if (u.includes('loginSubmit.do')) return makeRes(JSON.stringify({ result: 0, toUrl: 'https://cloud.189.cn/web/main.action' }));
    if (u.includes('web/main.action')) return makeRes('<html>main</html>', { setCookies: ['SESSION=new'] });
    if (u.includes('userSign.action')) {
      signCalls++;
      return signCalls === 1
        ? makeRes(JSON.stringify({ errorCode: 'InvalidSessionKey' }))
        : makeRes(JSON.stringify({ isSign: false, netdiskBonus: 8 }));
    }
    if (u.includes('getUserSizeInfo.action')) return makeRes(JSON.stringify({}));
    throw new Error('unexpected fetch: ' + u);
  };
  const ctx = { meta: { cloud189_cookies: 'SESSION=stale', cloud189_cookies_at: Date.now() } };
  const r = await cloud189.run({ username: '1', password: '2' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
  assert.ok(calls.some((c) => c.url.includes('loginUrl.action')), '失效后应重新登录');
  assert.equal(signCalls, 2, '应先试缓存再重登各一次');
  assert.ok(ctx.meta.cloud189_cookies.includes('SESSION=new'), '新登录态应回写缓存');
});

// ---------- 6. 登录失败带出网站原文 ----------
await t('cloud189：登录失败抛错（带网站提示）', async () => {
  const routes = standardRoutes();
  routes[4] = { match: (u) => u.includes('loginSubmit.do'), res: makeRes(JSON.stringify({ result: 1, msg: '密码错误' })) };
  mockFetch(routes);
  const err = await cloud189.run({ username: '1', password: 'bad' }, { meta: {} }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /密码错误/);
});

// ---------- 7. parseNeedCaptcha 多种返回格式 ----------
await t('parseNeedCaptcha 兼容纯文本与 JSON', async () => {
  assert.equal(parseNeedCaptcha('true'), true);
  assert.equal(parseNeedCaptcha('false'), false);
  assert.equal(parseNeedCaptcha('  '), false);
  assert.equal(parseNeedCaptcha('{"data":true}'), true);
  assert.equal(parseNeedCaptcha('{"data":false}'), false);
  assert.equal(parseNeedCaptcha(true), false); // 非字符串按空处理
});

// ---------- 8. RSA 加密输出 hex ----------
await t('rsaEncryptPkcs1 输出定长 hex', async () => {
  const hex = rsaEncryptPkcs1(PUB, 'hello');
  // 1024 位密钥 → 128 字节 → 256 个十六进制字符
  assert.equal(hex.length, 256);
  assert.match(hex, /^[0-9a-f]+$/);
  // 随机填充：两次加密结果应不同
  assert.notEqual(hex, rsaEncryptPkcs1(PUB, 'hello'));
});

console.log(`\n${n} passed`);
