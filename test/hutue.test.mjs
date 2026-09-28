// 糊涂鳄（WordPress + RiPro 悬浮窗签到）测试：node test/hutue.test.mjs（纯 mock）
import assert from 'node:assert/strict';
import { hutue, discoverSignin, judgeSigninResponse } from '../src/sites/hutue.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// handler(url, method, init) -> { body, status } ；返回 { throw: '...' } 可模拟网络错误
function mock(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: init.body || '', headers: init.headers || {} });
    const r = handler(u, method, init) || {};
    if (r.throw) throw new Error(r.throw);
    return { status: r.status || 200, text: async () => r.body || '' };
  };
  return calls;
}

// 真实站点首页（截取自 dj.hutue.cn 2026-09-28）：
//   ① 悬浮窗按钮 <a class="click-qiandao zzhuti_qd_1">打卡签到</a>，文案「每天签到 5 晶石」
//   ② 父主题 RiPro app.js：$(".click-qiandao").on("click", … action:"user_qiandao")
//   ③ 子主题 xb-child xb-app.js：$(".user-index-qd") … action:"xb_user_qiandao"（会员中心的另一个签到，只给 1 积分）
const HOME_REAL = '<html><head>'
  + '<script id="app-js-extra">var caozhuti={"ajaxurl":"https:\\/\\/dj.hutue.cn\\/wp-admin\\/admin-ajax.php","nonce":"abc123"};</script>'
  + '<script src="https://dj.hutue.cn/wp-content/themes/ripro/assets/js/app.js?ver=6.6.1"></script>'
  + '</head><body>'
  + '<div class="vip-desc">仙尊会员可享全站资源免费下载（需1晶石，每天签到5晶石）</div>'
  + '<a class="click-qiandao zzhuti_qd_1" href="javascript:void(0);" title="打卡签到">签到</a>'
  + '<script>jQuery(".click-qiandao").on("click",function(){jQuery.post(caozhuti.ajaxurl,{action:"user_qiandao"},function(a){1==a.status&&location.reload()})});'
  + 'jQuery(".user-index-qd").on("click",function(){jQuery.post(caozhuti.ajaxurl,{action:"xb_user_qiandao"},function(n){})});</script>'
  + '</body></html>';

// ---------- 1. 从首页发现悬浮窗真正的 action ----------
// 线上事故：面板一直打的是会员中心的 xb_user_qiandao（奖励 1 积分），它确实回 status:1，
// 于是报「签到成功」——但悬浮窗的真签到（5 晶石）根本没做，用户去网站照样能再签一次。
await t('hutue：从首页悬浮窗发现 action，并优先使用按钮真正绑定的那个', async () => {
  const calls = mock((u, m) => {
    if (u === 'https://dj.hutue.cn/') return { body: HOME_REAL };
    if (u.includes('admin-ajax.php')) return { body: JSON.stringify({ status: 1, msg: '签到成功，赠送 5 晶石' }) };
    return { throw: 'unexpected ' + u };
  });
  const ctx = { meta: {} };
  const r = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, ctx);

  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
  assert.match(r.message, /5 晶石/);
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, '应有 AJAX POST');
  assert.match(post.url, /admin-ajax\.php/);
  assert.match(post.body, /action=user_qiandao/, '必须打真签到：' + post.body);
  assert.doesNotMatch(post.body, /xb_user_qiandao/);
  assert.equal(ctx.meta.hutue_action, 'user_qiandao', '命中后应记住真签到 action');
});

await t('discoverSignin：按钮绑定的 action 排在其他泛匹配之前', async () => {
  const d = discoverSignin('https://dj.hutue.cn', HOME_REAL);
  assert.equal(d.actions[0], 'user_qiandao', JSON.stringify(d.actions));
  assert.deepEqual(d.buttonActions, ['user_qiandao']);
  assert.ok(d.actions.includes('xb_user_qiandao'));
});

// ---------- 2. 首页没有线索 → 兜底 action ----------
await t('hutue：首页无线索时用兜底 action', async () => {
  const calls = mock((u) => {
    if (u === 'https://hutue.cn/') return { body: '<html><body>欢迎来到糊涂鳄</body></html>' };
    if (u.includes('admin-ajax.php')) return { body: JSON.stringify({ status: 1, msg: '签到成功' }) };
    return { throw: 'unexpected ' + u };
  });
  const r = await hutue.run({ site_url: 'https://hutue.cn', cookie: 'c=x' }, { meta: {} });
  assert.equal(r.ok, true);
  const post = calls.find((c) => c.method === 'POST');
  // 实测：首页内联脚本只给 ajaxurl、不写 action 名（处理器在主题 JS 里），
  // 所以硬编码的首位必须是站点真正的签到 action：RiPro 的 user_qiandao
  assert.match(post.body, /action=user_qiandao/);
});

// ---------- 3. 今日已签到 ----------
// 关键：网站反馈列要的是「网站真实原话」，所以这里必须逐字回传 msg，
// 而不是我们自己的「今日已签到，无需重复」。
await t('hutue：今天已经签到过了 → 成功且回传网站原话', async () => {
  mock((u) => {
    if (u.endsWith('/')) return { body: '<html>首页</html>' };
    return { body: JSON.stringify({ status: 0, msg: '今天已经签到过了' }) };
  });
  const r = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: {} });
  assert.equal(r.ok, true);
  assert.equal(r.message, '今天已经签到过了');
});

// 线上现象：面板显示「签到成功：签到成功，赠送1积分」——前缀是我们自己拼的，
// 既重复又不算真实反馈（积分数字还与站点实际奖励对不上）。
await t('hutue：成功时逐字回传网站 msg，不拼任何前缀', async () => {
  mock((u) => {
    if (u.endsWith('/')) return { body: '<html>首页</html>' };
    return { body: JSON.stringify({ status: 1, msg: '签到成功，赠送5积分' }) };
  });
  const r = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: {} });
  assert.equal(r.ok, true);
  assert.equal(r.message, '签到成功，赠送5积分');
  assert.doesNotMatch(r.message, /^签到成功：/);
});

// 主题自带 action 永远优先：否则某个别的插件 action 先返回 status=1 就会被记住，
// 以后每次都走它，网站反馈变成那个插件的话（奖励对不上本站）。
// 主题自带的真签到 action 永远第一：否则某次命中会员中心那个（1 积分）就会被记住，
// 以后每次都走它，真签到（5 晶石）永远不做——这正是线上的「假签到」。
await t('hutue：站点真签到 action 永远排第一（不被记住的旧 action 顶掉）', async () => {
  const calls = mock((u) => {
    if (u.endsWith('/')) return { body: '<html>首页</html>' };
    return { body: JSON.stringify({ status: 1, msg: '签到成功' }) };
  });
  const ctx = { meta: { hutue_action: 'xb_user_qiandao' } };
  await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, ctx);
  const first = new URLSearchParams(calls.find((c) => c.method === 'POST').body).get('action');
  assert.equal(first, 'user_qiandao');
});

// ---------- 4. 登录失效 ----------
await t('hutue：请先登录 → 明确提示重新获取 Cookie', async () => {
  mock((u) => {
    if (u.endsWith('/')) return { body: '<html>首页</html>' };
    return { body: JSON.stringify({ status: 0, msg: '请先登录' }) };
  });
  const err = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'bad' }, { meta: {} }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /登录已失效/);
});

// ---------- 5. 第一个 action 无效 → 自动试下一个 ----------
await t('hutue：某个 action 无效时自动尝试下一个', async () => {
  let posts = 0;
  const calls = mock((u) => {
    if (u.endsWith('/')) return { body: '<html>首页</html>' };
    posts++;
    if (posts === 1) return { body: JSON.stringify({ success: false, data: { msg: '无效的请求' } }) };
    return { body: JSON.stringify({ status: 1, msg: '签到成功' }) };
  });
  const r = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: {} });
  assert.equal(r.ok, true);
  assert.equal(posts, 2, '应重试一次并成功');
  const actions = calls.filter((c) => c.method === 'POST').map((c) => new URLSearchParams(c.body).get('action'));
  assert.notEqual(actions[0], actions[1], '两次应用不同的 action');
});

// ---------- 6. 首页就是验证码页 → 不瞎试 ----------
await t('hutue：首页要求人机验证时不打接口', async () => {
  const calls = mock(() => ({ body: '<html><div>请完成滑动验证</div></html>' }));
  const err = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: {} }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /人机验证/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, '不应再发签到请求');
});

// ---------- 7. AJAX 返回登录页（HTTP 200） ----------
await t('hutue：AJAX 返回登录页时提示登录失效', async () => {
  mock((u) => {
    if (u.endsWith('/')) return { body: '<html>首页</html>' };
    return { body: '<html><form action="/wp-login.php">请先登录</form></html>' };
  });
  const err = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'bad' }, { meta: {} }).catch((e) => e);
  assert.match(err.message, /登录已失效/);
});

// ---------- 8. 记住上次命中的 action：跳过首页发现（省一次中继往返），但真签到仍排第一 ----------
await t('hutue：有记住的 action 时跳过首页抓取，且先打真签到', async () => {
  const calls = mock((u) => {
    if (u.endsWith('/')) return { body: HOME_REAL };
    return { body: JSON.stringify({ status: 1, msg: '签到成功，赠送 5 晶石' }) };
  });
  // 故意把上次命中的记成错误的那个（线上真实状态）：也不该被它抢走
  const r = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: { hutue_action: 'xb_user_qiandao' } });
  assert.equal(r.ok, true);
  assert.ok(!calls.some((c) => c.method === 'GET' && c.url === 'https://dj.hutue.cn/'), '记住 action 后不再抓首页');
  const first = calls.find((c) => c.method === 'POST');
  assert.match(first.body, /action=user_qiandao/);
});

// ---------- 9. discoverSignin 纯函数 ----------
await t('discoverSignin：提取 ajaxurl / action / nonce / wp-json 路由', async () => {
  const html = `<script>var t={"ajaxurl":"https:\\/\\/dj.hutue.cn\\/wp-admin\\/admin-ajax.php","nonce":"n_123456"};`
    + `fetch('/wp-json/ripro/v1/qiandao');</script><button data-action="user_qiandao">签到</button>`;
  const d = discoverSignin('https://dj.hutue.cn', html);
  assert.equal(d.ajaxUrl, 'https://dj.hutue.cn/wp-admin/admin-ajax.php');
  assert.ok(d.actions.includes('user_qiandao'), JSON.stringify(d.actions));
  assert.equal(d.nonce, 'n_123456');
  assert.ok(d.routes.some((r) => r.includes('wp-json/ripro/v1/qiandao')), JSON.stringify(d.routes));
});

// ---------- 10. judgeSigninResponse 契约 ----------
await t('judgeSigninResponse：成功/已签/登录失效/线索不足', async () => {
  assert.equal(judgeSigninResponse('{"status":1,"msg":"ok"}', 200).result.ok, true);
  assert.equal(judgeSigninResponse('{"status":0,"msg":"今日已签到"}', 200).result.ok, true);
  const bad = judgeSigninResponse('{"status":0,"msg":"请先登录"}', 200);
  assert.equal(bad.done, true);
  assert.equal(bad.result.ok, false);
  assert.equal(bad.result.outcome, 'need_login');
  const unclear = judgeSigninResponse('{"success":false,"data":{"msg":"无效的请求"}}', 200);
  assert.equal(unclear.done, false);
});

// ---------- 11. 回归：首页带「请先登录」字样但其实是登录态 → 不得误报 Cookie 失效 ----------
// 线上真实踩坑：RiPro 首页的登录弹窗/内联脚本里就带「请先登录」「登录后查看」「wp-login.php」，
// 旧逻辑只看这些字样 + 没有 admin-ajax 字样，就把刚复制的**新鲜 Cookie** 判成失效。
await t('hutue：首页含「请先登录」文案但已有登录态 → 不误报 Cookie 失效', async () => {
  const HOME = '<html><body><div id="wpadminbar">你好，xxx</div>'
    + '<div class="login-modal">请先登录后查看内容</div>'
    + '<script>jQuery("#login").on("click",function(){location.href="/wp-login.php"});</script>'
    + '<script>var t={"ajaxurl":"\\/wp-admin\\/admin-ajax.php"};jQuery.post(t.ajaxurl,{action:"user_qiandao"},function(r){})</script>'
    + '</body></html>';
  const calls = mock((u) => {
    if (u === 'https://dj.hutue.cn/') return { body: HOME };
    if (u.includes('admin-ajax.php')) return { body: JSON.stringify({ status: 1, msg: '签到成功，获得 5 积分' }) };
    return { throw: 'unexpected ' + u };
  });
  const r = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'fresh=1' }, { meta: {} });
  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
  assert.ok(calls.some((c) => c.method === 'POST'), '应真的去打了签到接口');
});

// 反过来：真的是登录页（有 loginform 表单）时，仍要明确报失效
await t('hutue：首页真的是登录表单 → 报 Cookie 失效', async () => {
  mock((u) => {
    if (u === 'https://dj.hutue.cn/') {
      return { body: '<html><form id="loginform" action="https://dj.hutue.cn/wp-login.php" method="post"><input name="log"><input name="pwd"></form></html>' };
    }
    return { body: '[]' };
  });
  const err = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'bad' }, { meta: {} }).catch((e) => e);
  assert.match(err.message, /Cookie 已失效/);
  assert.match(err.detail, /网站返回/);
});

// ---------- 12. 「不再用别的接口冒充成功」 ----------
// 线上真相（用户投诉的核心）：真签到接口 user_qiandao 就算本次给不出成功，
// 也不能偷偷换成会员中心的 xb_user_qiandao（它确实会回「签到成功」，但只给 1 积分），
// 否则面板显示「已签到」而网站悬浮窗照样能再签一次 —— 那就是「假签到」。
await t('hutue：真接口给出业务回答（非成功）时，不再换接口冒充成功', async () => {
  const calls = mock((u) => {
    if (u.endsWith('/')) return { body: '<html>首页</html>' };
    return { body: JSON.stringify({ status: 0, msg: '签到失败：今天还没到签到时间' }) };
  });
  const err = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: {} }).catch((e) => e);
  assert.ok(err instanceof Error, '不能报成功');
  assert.match(err.message, /今天还没到签到时间/);
  const actions = calls.filter((c) => c.method === 'POST').map((c) => new URLSearchParams(c.body).get('action'));
  assert.deepEqual(actions, ['user_qiandao'], '只该打真签到接口，实测：' + JSON.stringify(actions));
  assert.match(err.detail || '', /接口 user_qiandao/, 'detail 要说清打的是哪个接口');
});

// 只有「站点不认这个接口」（WordPress 对不存在的 action 回字符串 0）才允许换下一个接口，
// 并且要在反馈里明说「本次是会员中心签到，只给 1 积分」。
await t('hutue：真接口不存在（返回 0）→ 才换到会员中心接口，并在反馈里标注', async () => {
  let posts = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/')) return { status: 200, text: async () => '<html>首页</html>' };
    posts++;
    const action = new URLSearchParams(String(init.body || '')).get('action');
    if (action === 'user_qiandao') return { status: 200, text: async () => '0' }; // 站点不认这个 action
    return { status: 200, text: async () => JSON.stringify({ status: 1, msg: '签到成功，赠送1积分' }) };
  };
  const r = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: {} });
  assert.equal(r.ok, true);
  assert.equal(posts, 2, '第一次被站点拒绝后才试第二个接口');
  assert.match(r.detail || '', /接口 xb_user_qiandao/, '要说清用的是哪个接口');
  assert.match(r.detail || '', /只给 1 积分/, '降级用会员中心接口时必须明说');
});

// ---------- 13. 中继超时：请求可能已经送达，不能直接当失败 ----------
// 线上现象（2026-09-28 糊涂鳄）：中继打 admin-ajax 挂到 45 秒，扩展回「已放弃该请求」，
// 面板记「失败」；但服务端很可能已经处理了这次 POST（网站那天确实已签）。
// 现在的做法：同一接口再打一次 —— 若上一次真的生效了，站点会直接回「今日已签到」。
await t('hutue：中继超时后重试一次，站点回「今日已签到」→ 判为已签（说明请求其实已送达）', async () => {
  let posts = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/')) return { status: 200, text: async () => '<html>首页</html>' };
    posts++;
    if (posts === 1) throw new Error('本地网络失败：中继执行超时（45秒），已放弃该请求');
    return { status: 200, text: async () => JSON.stringify({ status: 0, msg: '今日已签到，请明日再来' }) };
  };
  const r = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: {} });
  assert.equal(r.ok, true);
  assert.equal(r.message, '今日已签到，请明日再来');
  assert.equal(posts, 2, '超时后应重试同一个接口');
  assert.match(r.detail || '', /重试/, '反馈里要留下「重试过」的痕迹');
});

await t('hutue：重试仍等不到回包 → 报「结果未知」（不是「失败」，不冤枉网站）', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/')) return { status: 200, text: async () => '<html>首页</html>' };
    throw new Error('本地网络失败：中继执行超时（45秒），已放弃该请求');
  };
  const err = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: {} }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.outcome, 'relay-unknown');
  assert.match(err.message, /结果未知/);
  assert.doesNotMatch(err.message, /^签到失败/);
});

console.log(`\n${n} 组通过`);
