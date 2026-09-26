// 新站点模块测试：node test/sites-new.test.mjs（纯 mock）
import assert from 'node:assert/strict';
import { v2ex } from '../src/sites/v2ex.js';
import { misign } from '../src/sites/misign.js';
import { kanxue } from '../src/sites/kanxue.js';
import { wuaipojie } from '../src/sites/wuaipojie.js';
import { nodeseek } from '../src/sites/nodeseek.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const te = new TextEncoder();
// routes: [{ match(url, init)->bool, status, body(string), headers }]
function mockFetch(routes) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const r = routes.find((x) => x.match(u, init));
    if (!r) throw new Error('unexpected fetch: ' + u);
    const bytes = te.encode(r.body || '');
    return {
      status: r.status || 200,
      url: r.finalUrl || String(url),
      headers: { get: (k) => (r.headers && (r.headers[k.toLowerCase()] ?? r.headers[k])) ?? null },
      text: async () => r.body || '',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
}

// ---------- V2EX ----------
await t('v2ex：今日已签到', async () => {
  mockFetch([{ match: (u) => u.includes('/mission/daily'), body: '<html>每日登录奖励已领取</html>' }]);
  const r = await v2ex.run({ cookie: 'A2=x' });
  assert.equal(r.ok, true);
  assert.match(r.message, /已签到/);
});

await t('v2ex：领取成功', async () => {
  let redeemed = '';
  mockFetch([
    { match: (u) => u.includes('/mission/daily') && !u.includes('redeem'), body: '<a href="/mission/daily/redeem?once=98765">领取</a>' },
    { match: (u) => u.includes('redeem'), body: '<html>已成功领取每日登录奖励</html>' },
  ]);
  // 记录实际请求的 redeem URL
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('redeem')) redeemed = String(url);
    return orig(url, init);
  };
  const r = await v2ex.run({ cookie: 'A2=x' });
  assert.equal(r.ok, true);
  assert.ok(redeemed.includes('once=98765'));
});

await t('v2ex：Cookie 失效', async () => {
  mockFetch([{ match: () => true, status: 403, body: 'forbidden' }]);
  await assert.rejects(v2ex.run({ cookie: 'bad' }), /Cookie 已失效/);
});

// ---------- Discuz k_misign ----------
const SIGN_PAGE_SIGNED = '<html>您的签到排名<input id="lxreward" value="10 铜币"></html>';
const SIGN_PAGE_TODO = '<html><a id="JD_sign" href="plugin.php?id=k_misign:sign&amp;operation=qiandao&amp;formhash=abc123">签到</a></html>';

await t('misign：今日已签到', async () => {
  mockFetch([{ match: (u) => u.includes('k_misign'), body: SIGN_PAGE_SIGNED }]);
  const r = await misign.run({ base_url: 'https://www.abooky.com', cookie: 'c=x' });
  assert.equal(r.ok, true);
  assert.match(r.message, /已签到/);
});

await t('misign：签到成功并提取奖励', async () => {
  let signed = false;
  mockFetch([
    { match: (u) => u.includes('operation=qiandao'), body: 'ok' },
    {
      match: (u) => u.includes('k_misign'),
      body: '<html>占位</html>',
    },
  ]);
  // 第二次访问签到页返回已签
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('operation=qiandao')) { signed = true; }
    if (String(url).includes('k_misign') && !String(url).includes('operation=qiandao')) {
      calls++;
      const body = calls === 1 ? SIGN_PAGE_TODO : SIGN_PAGE_SIGNED;
      const bytes = te.encode(body);
      return { status: 200, headers: { get: () => null }, text: async () => body,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
    return orig(url, init);
  };
  const r = await misign.run({ base_url: 'https://www.abooky.com/', cookie: 'c=x' });
  assert.equal(signed, true);
  assert.equal(r.ok, true);
  assert.match(r.message, /10 铜币/);
});

await t('misign：未登录', async () => {
  mockFetch([{ match: () => true, body: '<a href="member.php?mod=logging&action=login">登录</a>' }]);
  await assert.rejects(misign.run({ base_url: 'https://www.abooky.com', cookie: 'bad' }), /Cookie 已失效/);
});

// ---------- 看雪 ----------
await t('kanxue：自动取 token 后签到成功', async () => {
  let posted = '';
  mockFetch([
    { match: (u) => u === 'https://bbs.kanxue.com/', body: '<input type="hidden" name="csrf_token" value="tok123">' },
    { match: (u) => u.includes('user-signin'), body: JSON.stringify({ code: 0, message: '签到成功' }) },
  ]);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('user-signin')) posted = init.body;
    return orig(url, init);
  };
  const r = await kanxue.run({ cookie: 'c=x' });
  assert.equal(r.ok, true);
  assert.ok(String(posted).includes('csrf_token=tok123'));
});

await t('kanxue：重复签到', async () => {
  mockFetch([{ match: () => true, body: JSON.stringify({ code: 1, message: '您已签到' }) }]);
  const r = await kanxue.run({ cookie: 'c=x', csrf_token: 'manual' });
  assert.equal(r.ok, true);
  assert.match(r.message, /已签到/);
});

// ---------- 吾爱破解 ----------
const PJ_HOME_CLEAN = '<html><a href="home.php?mod=space">我的空间</a>论坛首页</html>';

await t('52pojie：今日已签到', async () => {
  mockFetch([{ match: (u) => u.includes('portal.php'), body: PJ_HOME_CLEAN + '今日已签到' }]);
  const r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' });
  assert.equal(r.ok, true);
});

await t('52pojie：WAF 拦截提示', async () => {
  mockFetch([{ match: () => true, body: '<html>waf_zw_verify 请完成安全验证</html>' }]);
  await assert.rejects(wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }), /安全验证/);
});

await t('52pojie：Cookie 失效', async () => {
  mockFetch([{ match: () => true, body: '<html>请先登录</html>' }]);
  await assert.rejects(wuaipojie.run({ cookie: 'bad', user_agent: 'UA' }), /Cookie 已失效/);
});

await t('52pojie：重定向链签到成功', async () => {
  const seen = [];
  let portalCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.push(u);
    const resp = (status, body, headers) => {
      const bytes = te.encode(body || '');
      return {
        status, headers: { get: (k) => (headers && (headers[k.toLowerCase()] ?? headers[k])) ?? null },
        text: async () => body || '',
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    };
    if (u.includes('do=apply')) return resp(302, '', { location: 'https://www.52pojie.cn/home.php?mod=task&do=draw&id=2' });
    if (u.includes('do=draw')) return resp(302, '', { location: '/portal.php' });
    if (u.includes('portal.php')) {
      portalCalls++;
      return resp(200, portalCalls === 1 ? PJ_HOME_CLEAN : '<html>恭喜，签到成功，获得吾爱币</html>');
    }
    throw new Error('unexpected fetch: ' + u);
  };
  const r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' });
  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
  assert.ok(seen.some((u) => u.includes('do=apply')));
});

await t('52pojie：缺 UA 报错', async () => {
  await assert.rejects(wuaipojie.run({ cookie: 'c=x', user_agent: '' }), /User-Agent/);
});

// ---------- NodeSeek ----------
await t('nodeseek：签到成功', async () => {
  mockFetch([{ match: (u) => u.includes('/api/attendance'), body: JSON.stringify({ success: true, message: '获得 5 个鸡腿' }) }]);
  const r = await nodeseek.run({ cookie: 'a=1' }, { meta: { toggles: { random: false } } });
  assert.equal(r.ok, true);
  assert.match(r.message, /鸡腿/);
});

await t('nodeseek：CF 验证页报错带人机验证提示', async () => {
  const html = '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';
  mockFetch([{ match: (u) => u.includes('/api/attendance'), status: 200, body: html }]);
  await assert.rejects(nodeseek.run({ cookie: 'a=1' }, {}), /人机验证/);
});

await t('nodeseek：非 JSON 非 CF 页面短报错，详情进 detail', async () => {
  mockFetch([{ match: (u) => u.includes('/api/attendance'), status: 200, body: '<html><body>Service Busy</body></html>' }]);
  const err = await nodeseek.run({ cookie: 'a=1' }, {}).catch((e) => e);
  assert.match(err.message, /网站返回异常/);
  assert.ok(err.message.length < 30, '报错应为一句话短判，实际：' + err.message);
  assert.match(err.detail || '', /页面片段.*Service Busy/);
});

await t('nodeseek：被跳到首页判为登录信息未被识别', async () => {
  const html = '<html><body><a href="/signIn.html" class="login-btn">登录</a><a class="btn-signin">立即登录</a></body></html>';
  mockFetch([{ match: (u) => u.includes('/api/attendance'), status: 200, body: html, finalUrl: 'https://www.nodeseek.com/' }]);
  const err = await nodeseek.run({ cookie: 'a=1' }, {}).catch((e) => e);
  assert.match(err.message, /没认出登录信息/);
  assert.match(err.detail || '', /最终地址 https:\/\/www\.nodeseek\.com\//);
});

await t('nodeseek：成功时返回网站原始回馈 detail', async () => {
  const body = JSON.stringify({ success: true, message: '获得 5 个鸡腿', data: { rank: 123 } });
  mockFetch([{ match: (u) => u.includes('/api/attendance'), body }]);
  const r = await nodeseek.run({ cookie: 'a=1' }, {});
  assert.equal(r.ok, true);
  assert.match(r.detail || '', /网站返回/);
  assert.match(r.detail || '', /鸡腿/);
});

await t('nodeseek：今日已签到算成功并带回馈', async () => {
  const body = JSON.stringify({ success: false, message: '今日已签到' });
  mockFetch([{ match: (u) => u.includes('/api/attendance'), body }]);
  const r = await nodeseek.run({ cookie: 'a=1' }, {});
  assert.equal(r.ok, true);
  assert.match(r.message, /今日已签到/);
});

await t('nodeseek：失败时错误带 detail', async () => {
  const body = JSON.stringify({ success: false, message: '参数错误' });
  mockFetch([{ match: (u) => u.includes('/api/attendance'), body }]);
  const err = await nodeseek.run({ cookie: 'a=1' }, {}).catch((e) => e);
  assert.match(err.message, /签到失败/);
  assert.match(err.detail || '', /网站返回.*参数错误/);
});

console.log(`\n${n} 组通过`);
