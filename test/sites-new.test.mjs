// 新站点模块测试：node test/sites-new.test.mjs（纯 mock）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { v2ex } from '../src/sites/v2ex.js';
import { misign } from '../src/sites/misign.js';
import { kanxue } from '../src/sites/kanxue.js';
import { wuaipojie, buttonState } from '../src/sites/wuaipojie.js';
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
// （“签到完毕”是 Discuz 任务页已签到后的按钮文案，见下面两条用例）
const PJ_HOME_CLEAN = '<html><a href="home.php?mod=space">我的空间</a>论坛首页</html>';

await t('52pojie：今日已签到', async () => {
  mockFetch([{ match: (u) => u.includes('portal.php'), body: PJ_HOME_CLEAN + '今日已签到' }]);
  const r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' });
  assert.equal(r.ok, true);
});

// 线上真实现象：当天已经签到过之后，52pojie 每日签到任务页的按钮会变成「签到完毕」，
// 再点没有任何反应。旧逻辑没有这个词，于是报「未识别到成功标识」，面板还显示「未签到」。
await t('52pojie：已签到（签到完毕）算成功，不再报未识别', async () => {
  mockFetch([
    { match: (u) => u.includes('mod=task'), body: '<html><a href="home.php?mod=task">每日签到</a> 签到完毕</html>' },
    { match: (u) => u.includes('portal.php'), body: PJ_HOME_CLEAN },
    { match: () => true, body: '<html>吾爱币 12</html>' },
  ]);
  const r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' });
  assert.equal(r.ok, true);
  assert.match(r.message, /已签到|签到完毕/);
});

// 线上真实现象：本地网络中继下，签到接口被网宿 WAF 吊死到超时（用户看到
// 「中继执行超时（45秒），已放弃该请求」），而那一次其实已经签到成功。
// 修法：先用任务页判定「今天是否已领过」，已签到就直接返回，连签到接口都不打。
await t('52pojie：任务页显示「签到完毕」→ 直接判已签到，不再打签到接口', async () => {
  const urls = [];
  const orig = globalThis.fetch;
  mockFetch([
    { match: (u) => u.includes('mod=task') && !u.includes('do=apply'), body: '<html>每日签到 <span>签到完毕</span></html>' },
    { match: () => true, body: '<html>不该走到这里</html>' },
  ]);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => { urls.push(String(url)); return inner(url, init); };
  const r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }, { relayDb: {} });
  globalThis.fetch = orig;
  assert.equal(r.ok, true);
  assert.match(r.message, /已签到|签到完毕/);
  assert.ok(!urls.some((u) => u.includes('do=apply')), '已签到就不该再去打卡住的签到接口：' + JSON.stringify(urls));
});

// 线上真实现象（已确认根因）：门户页 portal.php 的「最新公告」块里常年挂着
// 「开放注册期间论坛暂停签到」。早期实现拿「暂停签到」扫整个首页，
// 把一个完全正常的账号报成「论坛官方暂停签到，等恢复后再试」，死活签不上。
// 门户页还混着论坛最新帖标题，什么都可能出现，所以首页文本不能当签到结论。
await t('52pojie：门户页公告写着「暂停签到」也不能误判，仍要去打签到页', async () => {
  const urls = [];
  mockFetch([
    { match: (u) => u.includes('mod=task'), body: '<html><a href="home.php?mod=task">每日签到</a> 任务已完成，恭喜获得 2 热心值</html>' },
    { match: (u) => u.includes('portal.php'), body: PJ_HOME_CLEAN + '最新公告 开放注册期间论坛暂停签到、QQ登录绑定、下期开放注册时间' },
    { match: () => true, body: '<html>吾爱币 12</html>' },
  ]);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { urls.push(String(url)); return orig(url, init); };
  const r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' });
  globalThis.fetch = orig;
  assert.equal(r.ok, true, '公告不能把正常可签的账号判成暂停');
  assert.ok(urls.some((u) => u.includes('mod=task')), '必须真的去打签到页');
});

await t('52pojie：门户页帖子标题里的「今日已签到」也不能当结论', async () => {
  mockFetch([
    { match: (u) => u.includes('mod=task'), body: '<html>任务已完成，恭喜获得 1 热心值</html>' },
    { match: (u) => u.includes('portal.php'), body: PJ_HOME_CLEAN + '[经验] 今日已签到，快来领吾爱币吧' },
    { match: () => true, body: '<html>吾爱币 12</html>' },
  ]);
  const r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' });
  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
});

await t('52pojie：签到页确实说暂停 → 给出暂停结论', async () => {
  mockFetch([
    { match: (u) => u.includes('mod=task'), body: '<html><b>每日签到</b> 本期签到功能维护中，暂停签到</html>' },
    { match: (u) => u.includes('portal.php'), body: PJ_HOME_CLEAN },
    { match: () => true, body: '<html>吾爱币 12</html>' },
  ]);
  const err = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }).catch((e) => e);
  assert.match(err.message, /暂停签到/);
});

// ---------- 52pojie 的两态识别（用户截图确认的站点按钮语义） ----------
// 未签到 → 顶部按钮「📋 打卡签到」（橙色、可点）；已签到 → 「✅ 签到完毕」（绿色、点了没反应）。
// 注意：<a> 的 title 属性里常年写着「打卡签到」，所以只能读按钮元素自己的文字。
await t('52pojie：buttonState 三态（文字版 / 图片版 / 无按钮）', async () => {
  const signedText = '<html><a class="click-qiandao zzhuti_qd_2" title="打卡签到"><i class="icon-Sign2"></i><br>签到完毕</a></html>';
  const unsignedText = '<html><a class="click-qiandao zzhuti_qd_1" title="打卡签到"><i class="icon-Sign"></i><br>打卡签到</a></html>';
  // 52pojie 实际就是这样（用户 DevTools 截图）：状态被画在 qds.png 里，文本节点是空的，
  // 只能靠「那个「去签到」链接还在不在」来判断
  const unsignedImg = '<html><body><p><a href="home.php?mod=task&do=apply&id=2&referer=%2Fhome.php%3Fmod%3Dspacecp">'
    + '<img src="https://static.52pojie.cn/static/image/common/qds.png" class="qq_bind" align="absmiddle" alt></a>'
    + '<span class="pipe">|</span></p></body></html>';
  const signedImg = '<html><body><p><span class="qq_bind_done"><img src="https://static.52pojie.cn/static/image/common/qds.png"></span>签到完毕</p></body></html>';
  const unknown = '<html>普通页面，没有那个按钮</html>';
  assert.equal(buttonState(signedText), 'signed');
  assert.equal(buttonState(unsignedText), 'unsigned');
  assert.equal(buttonState(unsignedImg), 'unsigned', '图片版状态：链接还在就是未签到');
  assert.equal(buttonState(signedImg), 'signed');
  assert.equal(buttonState(unknown), 'unknown');
});

// 已签到（服务器渲染）→ 顶栏那个 apply 链接已经没了，任务行写着「已完成」
await t('52pojie：任务页显示已签到 → 直接判已签到，不打签到接口', async () => {
  const page = '<html><span>签到完毕</span>'
    + '<table><tr id="task_2"><td>每日签到</td><td>已完成</td></tr></table></html>';
  const urls = [];
  const te0 = new TextEncoder();
  const mkRes = (body) => ({ status: 200, url: 'https://www.52pojie.cn/x', headers: { get: () => null }, text: async () => body, arrayBuffer: async () => te0.encode(body).buffer });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); return mkRes(page); };
  let r = null;
  try { r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }, { relayDb: {} }); } finally { globalThis.fetch = origFetch; }
  assert.ok(r && r.ok, '应判已签到：' + JSON.stringify(r));
  assert.match(r.message, /已签到/);
  assert.ok(!urls.some((u) => u.includes('do=apply')), '已签到就不该再打签到接口：' + JSON.stringify(urls));
});

// 反过来：顶栏还挂着 qds.png 那个「去签到」链接（图片版未签到）→ 去签，不能提前判成功
await t('52pojie：顶栏还挂着「去签到」链接 → 不判已签到，去执行签到', async () => {
  const te0 = new TextEncoder();
  const mkRes = (body) => ({ status: 200, url: 'https://www.52pojie.cn/x', headers: { get: () => null }, text: async () => body, arrayBuffer: async () => te0.encode(body).buffer });
  const UNSIGNED = '<html><p><a href="home.php?mod=task&do=apply&id=2"><img src="https://static.52pojie.cn/static/image/common/qds.png"></a></p>'
    + '<table><tr id="task_2"><td>每日签到</td><td>立即申请</td></tr></table></html>';
  const SUCCESS = '<html><script>showmessage(\'恭喜您，任务已完成\', \'home.php?mod=task\');</script></html>';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => mkRes(String(url).includes('do=apply') ? SUCCESS : UNSIGNED);
  let r = null;
  try { r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }, { relayDb: {} }); } finally { globalThis.fetch = origFetch; }
  assert.ok(r && r.ok, '应真的去签到：' + JSON.stringify(r));
  assert.match(r.message, /签到成功|任务已完成/);
});

// 线上真实现象：本地网络中继下签到接口被吊死到超时（用户看到「中继执行超时（45秒）」）。
// 修法之后：超时不再拍脑袋报失败——先看站点按钮，还是「打卡签到」就是明确的未签到，
// 直说原因 + 下一步怎么操作（以前只会报一句「未识别到成功标识」）。
await t('52pojie：中继超时 + 网站按钮仍是「打卡签到」→ 明确报未签到并给操作建议', async () => {
  const te0 = new TextEncoder();
  const mkRes = (body) => ({
    status: 200,
    url: 'https://www.52pojie.cn/x',
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () => te0.encode(body).buffer,
  });
  const UNSIGNED_PAGE = '<html><a class="click-qiandao zzhuti_qd_1"><br>打卡签到</a> 每日签到</html>';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('mod=task') && !u.includes('do=apply')) return mkRes(UNSIGNED_PAGE);
    throw new Error('中继执行超时（45秒），已放弃该请求');
  };
  const err = await (async () => { try { await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }, { relayDb: {} }); } catch (e) { return e; } finally { globalThis.fetch = origFetch; } return null; })();
  assert.ok(err instanceof Error, '不应报成功');
  assert.match(err.message, /打卡签到/);
  assert.match(err.message, /没有生效/);
  assert.equal(err.outcome, 'unsigned');
});

// 反向：超时前其实已经签上了（按钮已经是「签到完毕」）→ 必须判成功，不能报失败
await t('52pojie：中继超时但按钮已是「签到完毕」→ 判已签到', async () => {
  const te0 = new TextEncoder();
  const mkRes = (body) => ({ status: 200, url: 'https://www.52pojie.cn/x', headers: { get: () => null }, text: async () => body, arrayBuffer: async () => te0.encode(body).buffer });
  const SIGNED_PAGE = '<html><a class="click-qiandao zzhuti_qd_2" title="打卡签到"><br>签到完毕</a></html>';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('mod=task') && !u.includes('do=apply')) return mkRes(SIGNED_PAGE);
    throw new Error('中继执行超时（45秒），已放弃该请求');
  };
  let r = null;
  try { r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }, { relayDb: {} }); } finally { globalThis.fetch = origFetch; }
  assert.ok(r, '应返回结果而不是抛错');
  assert.equal(r.ok, true);
  assert.match(r.message, /已签到/);
});

// 浏览器/导航模式（52pojie 的默认执行方式）也要认两态：
// 扩展把标签页导航到签到地址后读页面，不能把「打卡签到」当成签到成功。
await t('52pojie：浏览器模式巡检 — 按钮两态各自的结论', async () => {
  const fn = new Function('return (' + wuaipojie.browserScript + ')')();
  const mkDoc = (btnText) => ({
    documentElement: { innerHTML: '<a class="click-qiandao"><br>' + (btnText || '') + '</a>' },
    body: { innerText: btnText || '' },
    title: '每日签到',
    querySelector: () => (btnText === null ? null : { innerText: btnText, textContent: btnText }),
  });
  const origDoc = globalThis.document;
  try {
    globalThis.document = mkDoc('签到完毕');
    const signed = await fn({});
    assert.equal(signed.ok, true, JSON.stringify(signed));
    assert.match(signed.message, /已签到/);

    globalThis.document = mkDoc('打卡签到');
    const unsigned = await fn({});
    assert.equal(unsigned.ok, false, '「打卡签到」是未签到，不能算成功：' + JSON.stringify(unsigned));
    assert.match(unsigned.message, /打卡签到/);
  } finally {
    globalThis.document = origDoc;
  }
});

await t('52pojie：WAF 拦截提示', async () => {
  mockFetch([{ match: () => true, body: '<html>waf_zw_verify 请完成安全验证</html>' }]);
  await assert.rejects(wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }), /安全验证/);
});

// 线上真实现象：云端（Cloudflare 出口 IP）请求 52pojie 被网宿 WAF 用 UrlACL 碾掉，
// 返回体里根本没有 WAF 特征串，只有一行 403 文本，旧逻辑会报成「未识别到成功标识」这种废话。
await t('52pojie：403 UrlACL（云端 IP 被封）→ 明确提示切本地网络', async () => {
  mockFetch([{ match: () => true, status: 403, body: '403 Forbidden 403 Forbidden Client IP: 172.70.215.118 eventID: 1249-1790535085.403-waf02whc reason:UrlACL' }]);
  const err = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }).catch((e) => e);
  assert.match(err.message, /UrlACL|403/);
  assert.match(err.message, /本地网络/);
  assert.doesNotMatch(err.message, /未识别到成功标识/);
});

await t('52pojie：本地网络模式的重定向走 follow（页面拿不到 opaqueredirect 的头）', async () => {
  const seen = [];
  mockFetch([
    // 注意：签到 URL 的 referer 参数里也含 portal.php，所以 mod=task 必须先匹配
    { match: (u) => u.includes('mod=task'), body: '<html>任务已完成，恭喜获得 2 热心值</html>' },
    { match: (u) => u.includes('portal.php'), body: '<html>首页正常</html>' },
    { match: () => true, body: '<html>吾爱币 12 威望 3</html>' },
  ]);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { seen.push(init.redirect || '(未指定)'); return orig(url, init); };
  const r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }, { relayDb: {} });
  assert.equal(r.ok, true);
  const taskCalls = seen.filter((m) => m !== '(未指定)');
  assert.ok(taskCalls.length > 0, '应该有带 redirect 的请求');
  assert.ok(taskCalls.every((m) => m === 'follow'), '中继模式下应全部用 follow，实际：' + JSON.stringify(seen));
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

await t('nodeseek：被跳到 IPv6 提示页 → 提示切本地网络', async () => {
  mockFetch([{ match: (u) => u.includes('/api/attendance'), status: 200, body: '<html><body>您的网络未启用 IPv6</body></html>', finalUrl: 'https://warning.nodeseek.com/ipv6-is-disabled?f=https%3A%2F%2Fwww.nodeseek.com%2Fapi%2Fattendance' }]);
  const err = await nodeseek.run({ cookie: 'a=1' }, {}).catch((e) => e);
  assert.match(err.message, /IPv6/);
  assert.match(err.message, /本地网络/);
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

// 线上真实响应（面板「网站反馈」列展示的就是这句）：
// {"success":false,"message":"今天已完成签到，请勿重复操作"}
// 以前这里被归纳成我们自己的「今日已签到，不能重复签到」，用户看不到网站怎么说。
await t('nodeseek：已签到的反馈用网站原话，不再换成我们的套话', async () => {
  const body = JSON.stringify({ success: false, message: '今天已完成签到，请勿重复操作' });
  mockFetch([{ match: (u) => u.includes('/api/attendance'), body }]);
  const r = await nodeseek.run({ cookie: 'a=1' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.message, '今天已完成签到，请勿重复操作');
  assert.doesNotMatch(r.message, /不能重复签到/);
});

// 线上真实成功响应：{"success":true,"message":"今天的签到收益是2个鸡腿","gain":2,"current":1811}
await t('nodeseek：成功反馈＝网站原话 + 响应里的收益数字', async () => {
  const body = JSON.stringify({ success: true, message: '今天的签到收益是2个鸡腿', gain: 2, current: 1811 });
  mockFetch([{ match: (u) => u.includes('/api/attendance'), body }]);
  const r = await nodeseek.run({ cookie: 'a=1' }, {});
  assert.equal(r.ok, true);
  assert.match(r.message, /^今天的签到收益是2个鸡腿/);
  assert.match(r.message, /本次 \+2，累计 1811/);
});

await t('nodeseek：失败时错误带 detail', async () => {
  const body = JSON.stringify({ success: false, message: '参数错误' });
  mockFetch([{ match: (u) => u.includes('/api/attendance'), body }]);
  const err = await nodeseek.run({ cookie: 'a=1' }, {}).catch((e) => e);
  assert.match(err.message, /签到失败/);
  assert.match(err.detail || '', /网站返回.*参数错误/);
});

await t('52pojie：签到成功后附带吾爱币/威望（参考 Discuz 签到脚本的积分反馈）', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const raw = (bytes, status = 200) => ({
      status, headers: { get: () => null }, text: async () => '',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    // 注意：apply 的 URL 里也带 referer=%2Fportal.php，需先判 do=apply
    if (u.includes('ac=credit')) return raw(te.encode('<html><em>吾爱币:</em>123<em>威望:</em>45<em>热心值:</em>7</html>'));
    if (u.includes('do=apply')) return raw(te.encode('<html>恭喜，签到成功，获得吾爱币</html>'));
    if (u.includes('portal.php')) return raw(te.encode(PJ_HOME_CLEAN));
    throw new Error('unexpected fetch: ' + u);
  };
  const r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' });
  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
  assert.match(r.message, /吾爱币 123/);
  assert.match(r.message, /威望 45/);
  assert.match(r.message, /热心值 7/);
});

await t('52pojie：GBK 页面按 GBK 解码，网站回馈不乱码', async () => {
  // '恭喜签到成功' 的 GBK 字节（utf8 解码会成乱码，gbk 解码正常）
  const GBK = Uint8Array.from([0xB9, 0xA7, 0xCF, 0xB2, 0xC7, 0xA9, 0xB5, 0xBD, 0xB3, 0xC9, 0xB9, 0xA6]);
  globalThis.fetch = async (url) => {
    const u = String(url);
    const raw = (bytes) => ({
      status: 200, headers: { get: () => null }, text: async () => '',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    if (u.includes('do=apply')) return raw(GBK);
    if (u.includes('portal.php')) return raw(te.encode('<html>论坛首页</html>'));
    throw new Error('unexpected fetch: ' + u);
  };
  const r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' });
  assert.equal(r.ok, true);
  assert.match(r.message, /恭喜签到成功/, '实际：' + r.message);
  assert.ok(!/ï¿½|\uFFFD/.test(r.message), '不应出现替换字符');
});

// 52pojie 浏览器任务：扩展要先去「首页」，自己找那个「去签到」入口再点它。
// 为什么是首页而不是任务页（2026-09-28 用真实登录态 curl 逐条实测）：
//   GET /                                → 200，登录态首页；`#um` 里挂着
//                                          <a href="home.php?mod=task&do=apply&id=2"><img src="…/qds.png"></a>
//                                          `#res-sign` 里是文字版「领取今日签到奖励」；
//                                          图片名就是当天状态（qds.png 未签 / wbs.png 已签）；
//   GET /home.php?mod=task               → 200，但 32KB 的**网宿 WZWS JS 挑战页**；
//   GET /home.php?mod=task&do=apply&id=2 → 同样是挑战页（带不带 Cookie、带不带 Referer 都一样）。
// 所以导航目标改成首页（不会被挑战，而且状态就在这页上）。
await t('52pojie：browserJob 先落「首页」（唯一不会被 WAF 挑战的页面）', async () => {
  const job = wuaipojie.browserJob();
  assert.equal(job.domain, 'www.52pojie.cn');
  assert.equal(job.navigate_url, 'https://www.52pojie.cn/', '先落到首页：/home.php* 一律会先回 WZWS 挑战页');
  assert.match(job.sign_url, /do=apply&id=\d+/, '兜底的签到地址');
  const wj = readFileSync(new URL('../src/sites/wuaipojie.js', import.meta.url), 'utf8');
  assert.match(wj, /const HOME_URL = 'https:\/\/www\.52pojie\.cn\/'/, '首页地址要有一个有名字的常量');
  assert.match(wj, /waf_zw_verify/, '实测依据（WZWS 挑战接口）要写进注释，否则下次又会被“顺手改回去”');
});

// 触发签到后要能「回任务页复查」：申请页常常既不报成功也不报未签（Discuz 点完只是刷新），
// 而任务页上那条 do=apply 链接就是服务端状态——链接还在 = 今天没签，链接没了 = 已签。
// 这一步今天缺了，面板上吾爱那一行就永远只有一句含糊的「未识别到成功标识」。
await t('52pojie：browserJob 声明复查地址，且面板要把 verify_url 下发到扩展', async () => {
  const job = wuaipojie.browserJob();
  assert.equal(job.verify_url, 'https://www.52pojie.cn/', '复查地址是首页：状态正本（qds→wbs）就在它上面');
  assert.equal(job.verify_urls[0], job.verify_url, '首页必须排第一；任务页只能算补充（脚本侧读它只会拿到挑战页）');
  assert.equal(new URL(job.verify_url).host, new URL(job.navigate_url).host, '复查必须同域');
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(idx, /verify_url: j\.verify_url \|\| ''/, 'index.js 的 browser-jobs 工单必须带上 verify_url');
  const ext = readFileSync(new URL('../public/ext-src/background.js', import.meta.url), 'utf8');
  assert.match(ext, /job\.verify_urls/, '扩展必须真的用 verify_urls 复查（任务页 + 首页）');
  // 2.4 起「同域校验」收敛成一个共用函数 sameSiteHttpUrl（navigate_url / sign_url / verify_urls 都走它）
  assert.match(ext, /sameSiteHttpUrl/, '复查/导航地址只允许同域（页面内容不可信）');
  assert.match(ext, /isPrivateHost/, '中继不允许访问内网地址');
  assert.match(idx, /verify_urls: Array\.isArray\(j\.verify_urls\)/, '面板要把 verify_urls 下发下去');
});

// 吾爱这条路的完整闭环（2026-09-28 实测后定下）：
//   签到只能由浏览器亲自发（WAF 只放行真实页面导航），而服务端认的是**浏览器 cookie jar** 里的登录态。
//   所以：① 面板把凭据一并交给扩展，由它写回浏览器（不需要人先去浏览器手工登录）；
//        ② 报成功之前必须回首页核对（结果页文案不算数，首页的入口/图标才是服务端状态）。
await t('52pojie：声明「需要浏览器登录态」并把凭据交给扩展写回浏览器', async () => {
  const wj = readFileSync(new URL('../src/sites/wuaipojie.js', import.meta.url), 'utf8');
  const job = wuaipojie.browserJob();
  assert.equal(wuaipojie.needsBrowserSession, true, '站点要声明这一点，面板才知道该不该下发凭据');
  assert.equal(job.inject_cookies, true, 'browserJob 要告诉扩展把凭据写回浏览器');
  assert.equal(job.confirm_before_report, true, '报成功前必须先跟站点核对');
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  // 只有站点主动声明的才下发（其他站点一律不带 cookie 字段）
  assert.match(idx, /inject_cookies: !!j\.inject_cookies/, '面板要按声明透传 inject_cookies');
  assert.match(idx, /cookie: j\.inject_cookies \? String\(creds\.cookie \|\| ''\) : ''/, '只有声明了的站点才带上凭据');
  assert.match(idx, /confirm_before_report: !!j\.confirm_before_report/, '面板要透传 confirm_before_report');
  // 凭据不能进地址栏/历史：只能走 cookie API，不能拼进 URL
  assert.doesNotMatch(idx, /navigate_url:[^\n]*creds\.cookie/, '凭据绝不能出现在导航地址里');
});

// 社区脚本（XIU2「吾爱破解论坛增强」、lyc8503「签到脚本 lite」）都用 wbs.png 判「今天已签」：
// 站点把状态画在图片里（qds.png 未签 / wbs.png 已签），文字节点是空的。
// 我们的按钮状态判定必须认这个图标，不能只认文字。
await t('52pojie：buttonState 认「签到完毕」图标 wbs.png', async () => {
  const html = '<div id="um"><span><img src="https://static.52pojie.cn/static/image/common/wbs.png" alt="状态图标"></span></div>';
  assert.equal(buttonState(html), 'signed', '只有 wbs.png、没有任何文字时也必须判为已签到');
  assert.equal(buttonState('<div id="um"><a href="home.php?mod=task&do=apply&id=2"><img src="static/image/common/qds.png"></a></div>'), 'unsigned');
});

// 站点改版把任务 id 换掉时，面板不能只会打 id=2：要能从任务页上读出真实链接
await t('52pojie：任务页上的签到链接（id 变了）优先于硬编码 id', async () => {
  const te0 = new TextEncoder();
  const mkRes = (body) => ({ status: 200, url: 'https://www.52pojie.cn/x', headers: { get: () => null }, text: async () => body, arrayBuffer: async () => te0.encode(body).buffer });
  const TASKLIST = '<html><p><a href="home.php?mod=task&do=apply&id=77&amp;referer=%2Fportal.php">'
    + '<img src="https://static.52pojie.cn/static/image/common/qds.png"></a></p>'
    + '<table><tr><td>每日签到</td><td>立即申请</td></tr></table></html>';
  const urls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url); urls.push(u);
    if (u.includes('do=apply')) return mkRes('<html><script>showmessage(\'恭喜您，任务已完成\');</script></html>');
    return mkRes(TASKLIST);
  };
  let r = null;
  try { r = await wuaipojie.run({ cookie: 'c=x', user_agent: 'UA' }); } finally { globalThis.fetch = origFetch; }
  assert.ok(r && r.ok, JSON.stringify(r));
  assert.ok(urls.some((u) => u.includes('id=77')), '应该照页面上的链接签：' + JSON.stringify(urls));
  assert.ok(!urls.some((u) => /do=apply&id=2(?!\d)/.test(u)), '不该打过期硬编码的 id=2');
});

console.log(`\n${n} 组通过`);
