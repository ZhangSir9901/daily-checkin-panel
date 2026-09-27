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

// ---------- 1. 从首页发现悬浮窗真正的 action / nonce ----------
await t('hutue：从首页悬浮窗发现 action 与 nonce 并优先使用', async () => {
  const HOME = '<html><script>var ripro={"ajaxurl":"\\/wp-admin\\/admin-ajax.php","nonce":"abc123"};'
    + 'jQuery.post(ripro.ajaxurl,{action:"xb_user_qiandao",nonce:ripro.nonce},function(r){})</script>'
    + '<div class="sign-float"><a data-action="xb_user_qiandao">签到</a></div></html>';
  const calls = mock((u, m) => {
    if (u === 'https://dj.hutue.cn/') return { body: HOME };
    if (u.includes('admin-ajax.php')) return { body: JSON.stringify({ status: 1, msg: '签到成功，获得 10 积分' }) };
    return { throw: 'unexpected ' + u };
  });
  const ctx = { meta: {} };
  const r = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, ctx);

  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
  assert.match(r.message, /10 积分/);
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, '应有 AJAX POST');
  assert.match(post.url, /admin-ajax\.php/);
  assert.match(post.body, /action=xb_user_qiandao/);
  assert.match(post.body, /nonce=abc123/);
  assert.equal(ctx.meta.hutue_action, 'xb_user_qiandao', '命中后应记住 action');
  assert.equal(ctx.meta.hutue_use_nonce, true);
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
  assert.match(post.body, /action=user_qiandao/);
});

// ---------- 3. 今日已签到 ----------
await t('hutue：今天已经签到过了 → 成功且提示已签到', async () => {
  mock((u) => {
    if (u.endsWith('/')) return { body: '<html>首页</html>' };
    return { body: JSON.stringify({ status: 0, msg: '今天已经签到过了' }) };
  });
  const r = await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: {} });
  assert.equal(r.ok, true);
  assert.match(r.message, /已签到/);
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

// ---------- 8. 记住上次命中的 action，下次优先 ----------
await t('hutue：下次优先用上次命中的 action', async () => {
  const calls = mock((u) => {
    if (u.endsWith('/')) return { body: '<html>首页</html>' };
    return { body: JSON.stringify({ status: 1, msg: '签到成功' }) };
  });
  await hutue.run({ site_url: 'https://dj.hutue.cn', cookie: 'c=x' }, { meta: { hutue_action: 'xb_user_qiandao' } });
  const first = calls.find((c) => c.method === 'POST');
  assert.match(first.body, /action=xb_user_qiandao/);
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

console.log(`\n${n} 组通过`);
