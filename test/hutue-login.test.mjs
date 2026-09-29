// 糊涂鳄：登录态过期时自动重新登录（node test/hutue-login.test.mjs，纯 mock）
//
// 背景（线上 2026-09-29）：hutue.cn 的 WordPress 登录会话 11:05 过期，之后站点每 30 秒
// 都回「请登录后签到」，面板只会说「登录已失效，请重新获取 Cookie」——
// 而用户其实一直在更新 Cookie（他更新的是另一个站 dj.hutue.cn 的那段）。
// 本文件钉住三件事：
//   ① 会话过期 + 存了账号密码 → 面板自己登录一次再签，不再麻烦用户；
//   ② 没存账号密码 → 错误里必须说清「哪段会话属于哪个站、什么时候过期」；
//   ③ 不会反复登录（同一账号 10 分钟内只自动登录一次）。
import assert from 'node:assert/strict';
import { hutue } from '../src/sites/hutue.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const CN_HASH = 'ec35f1949aa62d7b02e78d74b17cb6b5'; // md5('https://hutue.cn')
const DJ_HASH = 'ca7674586a167c665930997282100f84'; // md5('http://dj.hutue.cn')
const CN_EXPIRED = `guo527029137%7C1790651147%7Ctok%7Chmac`; // 2026-09-29 11:05:47 +08（已过期）
const DJ_VALID = `laoguo%7C1791684908%7Ctok%7Chmac`;         // 2026-10-11 10:15:08 +08
const MIXED = `wordpress_logged_in_${DJ_HASH}=${DJ_VALID}; wordpress_logged_in_${CN_HASH}=${CN_EXPIRED}`;

const HOME = '<html><head>'
  + '<script>var caozhuti={"ajaxurl":"https:\\/\\/hutue.cn\\/wp-admin\\/admin-ajax.php"};</script>'
  + '<script src="https://hutue.cn/wp-content/themes/ripro/assets/js/app.js"></script>'
  + '</head><body><div id="wpadminbar">你好，guo527029137</div>'
  + '<a class="click-qiandao" href="javascript:;">打卡签到</a>'
  + '<script>jQuery(".click-qiandao").on("click",function(){jQuery.post(caozhuti.ajaxurl,{action:"user_qiandao"},function(a){})});</script>'
  + '</body></html>';

// 登录成功后的首页：带 wpadminbar / 退出登录，是 wpLogin 验证登录成功用的痕迹
const HOME_LOGGED = '<html><body><div id="wpadminbar">你好，guo527029137</div><a href="/wp-login.php?action=logout">退出登录</a></body></html>';

function mock(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: String(init.body || ''), headers: init.headers || {} });
    const r = handler(u, method, init) || {};
    if (r.throw) throw new Error(r.throw);
    return {
      status: r.status || 200,
      headers: r.headers || { get: () => null, getSetCookie: () => [] },
      text: async () => r.body || '',
    };
  };
  return calls;
}

// 站点侧的典型响应（签到接口 / 登录页 / 首页）
function siteHandler({ signin = { status: 1, msg: '签到成功，赠送5晶石' }, login = 'ok' } = {}) {
  return (u, m) => {
    if (u.includes('/wp-login.php') && m === 'POST') {
      if (login === 'bad') return { body: '<div id="login_error">错误：<strong>密码不正确</strong></div>' };
      return {
        status: 302,
        headers: {
          get: (k) => (String(k).toLowerCase() === 'location' ? 'https://hutue.cn/' : null),
          getSetCookie: () => [`wordpress_logged_in_${CN_HASH}=guo527029137%7C1791859307%7Ctok%7Chmac; Path=/; HttpOnly`],
        },
        body: '',
      };
    }
    if (u.includes('/wp-login.php')) return { body: '<html>登录页</html>' };
    if (u === 'https://hutue.cn/') return { body: HOME_LOGGED };
    if (u.includes('admin-ajax.php')) return { body: JSON.stringify(signin) };
    if (u.endsWith('.js')) return { body: '/* theme */' };
    return { body: '<html>首页</html>' };
  };
}

// ---------- ① 会话过期 + 有账号密码 → 自动登录后签到成功 ----------
await t('hutue：会话已过期时自动登录一次，再签成功', async () => {
  const calls = mock(siteHandler());
  const ctx = { meta: {} };
  const r = await hutue.run(
    { site_url: 'https://hutue.cn', cookie: MIXED, username: 'guo527029137@qq.com', password: 'pw' },
    ctx,
  );
  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
  assert.match(r.detail, /重新登录/);
  assert.match(r.detail, /已剔除属于其它域名的旧会话/, '登录时顺手剔掉另一个站的会话，并让人知道');
  const loginCall = calls.find((c) => c.url.includes('/wp-login.php') && c.method === 'POST');
  assert.ok(loginCall, '应该有一次 wp-login.php 的登录 POST');
  assert.match(loginCall.body, /log=guo527029137%40qq\.com/);
  assert.match(loginCall.body, /pwd=pw/);
  // 登录在后、签到在后：先登录再打签到接口
  assert.ok(calls.findIndex((c) => c.url.includes('admin-ajax.php')) > calls.indexOf(loginCall));
  assert.ok(ctx.meta.wp_login_at > 0, '应记下本次自动登录时间（用于节流）');
});

// ---------- ② 没存账号密码 → 错误必须自解释 ----------
await t('hutue：没账号密码时，错误里带「Cookie 体检」（哪段属于谁、何时过期）', async () => {
  mock(siteHandler({ signin: { status: 0, msg: '请登录后签到' } }));
  const err = await hutue.run(
    { site_url: 'https://hutue.cn', cookie: MIXED },
    { meta: {} },
  ).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /登录已失效/);
  assert.match(err.message, /Cookie 体检：.*属于 hutue\.cn 的会话：guo527029137/);
  assert.match(err.message, /已过期/);
  assert.match(err.message, /laoguo/, '要指出那段仍然有效的其实是另一个站的');
  assert.match(err.message, /没有存账号密码/);
});

// ---------- ③ 节流：不会反复登录 ----------
await t('hutue：同一账号 10 分钟内只自动登录一次', async () => {
  const calls = mock(siteHandler({ signin: { status: 0, msg: '请登录后签到' } }));
  const err = await hutue.run(
    { site_url: 'https://hutue.cn', cookie: MIXED, username: 'u', password: 'p' },
    { meta: { wp_login_at: Date.now() } }, // 刚登录过
  ).catch((e) => e);
  assert.equal(calls.filter((c) => c.url.includes('/wp-login.php')).length, 0, '节流期内不该再登录');
  assert.match(err.message, /登录已失效/);
});

// ---------- ④ 明明是登录态、站点却回未登录 → 兜底再登录一次并重试 ----------
await t('hutue：站点回「请登录后签到」时（会话在运行前刚过期）自动补登录并重试', async () => {
  // 这份 Cookie 里本站那段是「有效」的（exp 设在很远的未来），所以不会触发预登录；
  // 但站点仍然回未登录 —— 这时应当自己登录一次再试。
  const futureHash = CN_HASH;
  const validOwn = `guo527029137%7C1799999999%7Ctok%7Chmac`;
  let firstSignin = true;
  const calls = mock((u, m) => {
    if (u.includes('/wp-login.php') && m === 'POST') return siteHandler().call(null, u, m);
    if (u.includes('/wp-login.php')) return { body: '<html>登录页</html>' };
    if (u === 'https://hutue.cn/') return { body: firstSignin ? HOME : HOME_LOGGED };
    if (u.includes('admin-ajax.php')) {
      if (firstSignin) { firstSignin = false; return { body: JSON.stringify({ status: 0, msg: '请登录后签到' }) }; }
      return { body: JSON.stringify({ status: 1, msg: '签到成功，赠送5晶石' }) };
    }
    if (u.endsWith('.js')) return { body: '/* theme */' };
    return { body: '<html>首页</html>' };
  });
  const r = await hutue.run(
    { site_url: 'https://hutue.cn', cookie: `wordpress_logged_in_${futureHash}=${validOwn}`, username: 'guo527029137@qq.com', password: 'pw' },
    { meta: {} },
  );
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.url.includes('/wp-login.php') && c.method === 'POST'), '应尝试过一次登录');
  assert.match(r.detail, /重新登录/);
});

// ---------- ⑤ 登录本身失败（密码错）→ 把站点原话带出来 ----------
await t('hutue：自动登录失败时，报错里带站点原话', async () => {
  mock(siteHandler({ signin: { status: 0, msg: '请登录后签到' }, login: 'bad' }));
  const err = await hutue.run(
    { site_url: 'https://hutue.cn', cookie: MIXED, username: 'u', password: 'wrong' },
    { meta: {} },
  ).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /自动重新登录也没成功|自动重新登录，但没成功/);
  assert.match(err.message, /密码不正确/);
});

// ---------- ⑥ 异站会话不进请求头，并在反馈里说明 ----------
await t('hutue：本站会话有效时，异站会话不发出去且反馈里说清', async () => {
  // 本站那段还没过期 → 不会触发预登录，走的就是「直接用这份 Cookie 签」这条路，
  // 正好验证过滤发生在发请求前。
  const ownValid = 'guo527029137%7C1799999999%7Ctok%7Chmac';
  const jar = `wordpress_logged_in_${DJ_HASH}=${DJ_VALID}; wordpress_logged_in_${CN_HASH}=${ownValid}`;
  const calls = mock(siteHandler());
  const r = await hutue.run(
    { site_url: 'https://hutue.cn', cookie: jar, username: 'u', password: 'p' },
    { meta: {} },
  );
  assert.equal(r.ok, true);
  const signin = calls.find((c) => c.url.includes('admin-ajax.php'));
  assert.doesNotMatch(String(signin.headers.Cookie || ''), /laoguo/, '异站会话不该发出去');
  assert.match(String(signin.headers.Cookie || ''), /guo527029137/, '本站会话照样发出去');
  assert.match(r.detail, /已忽略不属于本站的会话 Cookie/);
});

// ---------- ⑦ 拿到新会话时回写 D1 ----------
await t('hutue：登录拿到新会话后回写加密凭据', async () => {
  const writes = [];
  const db = {
    prepare(sql) {
      return { bind: (...args) => ({ run: async () => { writes.push({ sql, args }); } }) };
    },
  };
  mock(siteHandler());
  const env = { ENCRYPT_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64') };
  const r = await hutue.run(
    { site_url: 'https://hutue.cn', cookie: MIXED, username: 'u', password: 'p' },
    { meta: {}, db, env, account: { id: 8 } },
  );
  assert.equal(r.ok, true);
  const credWrite = writes.find((w) => /UPDATE accounts SET creds=/.test(w.sql));
  assert.ok(credWrite, '应把新会话写回 creds');
  assert.equal(credWrite.args[2], 8);
  assert.ok(String(credWrite.args[0]).length > 20, '写入的应该是密文');
  assert.doesNotMatch(String(credWrite.args[0]), /guo527029137/, '不能把会话明文写进库');
});

// ---------- ⑧ 只填账号密码、完全没 Cookie → 直接登录再签 ----------
await t('hutue：只填账号密码（没有 Cookie）也能一路签下来', async () => {
  const calls = mock(siteHandler());
  const r = await hutue.run(
    { site_url: 'https://hutue.cn', username: 'guo527029137@qq.com', password: 'pw' },
    { meta: {} },
  );
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.url.includes('/wp-login.php') && c.method === 'POST'), '应先登录');
  assert.match(r.detail, /重新登录/);
});

// ---------- ⑨ 连账号密码都没有 → 说清该去哪儿修，而不是发一堆注定被拒的请求 ----------
await t('hutue：既没 Cookie 又没账号密码时给出可执行的下一步', async () => {
  const calls = mock(siteHandler());
  const err = await hutue.run({ site_url: 'https://hutue.cn' }, { meta: {} }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /Cookie 未配置/);
  assert.match(err.message, /账号和密码/);
  assert.equal(calls.length, 0, '什么都不具备时不该白打请求');
});

console.log(`\n${n} 组全部通过`);
