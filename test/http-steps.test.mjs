// http 多步录制测试：node test/http-steps.test.mjs（纯 mock）
import assert from 'node:assert/strict';
import { runHttpSteps } from '../src/sites/http.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

function mockFetch(handler) {
  globalThis.fetch = async (url, init = {}) => {
    const r = handler(String(url), init);
    return { status: r.status || 200, text: async () => r.body || '' };
  };
}

await t('多步：登录拿 token 再签到', async () => {
  const seen = [];
  mockFetch((url, init) => {
    seen.push({ url, auth: init.headers && init.headers.Authorization });
    if (url.includes('/login')) return { body: JSON.stringify({ data: { token: 'tok123' } }) };
    if (url.includes('/checkin')) {
      assert.equal(init.headers.Authorization, 'tok123'); // {{token}} 替换生效
      return { body: JSON.stringify({ ok: true }) };
    }
    throw new Error('unexpected ' + url);
  });
  const r = await runHttpSteps([
    { name: '登录', method: 'POST', url: 'https://a.com/login', body: '{}', extract: { token: 'data.token' } },
    { name: '签到', method: 'POST', url: 'https://a.com/checkin', headers: '{"Authorization":"{{token}}"}', expect_contains: 'true' },
  ]);
  assert.equal(r.ok, true);
  assert.match(r.message, /2 步全部成功/);
  assert.equal(r.vars.token, 'tok123');
});

await t('变量在 URL 和 Body 中替换', async () => {
  let gotUrl = '', gotBody = '';
  mockFetch((url, init) => {
    if (url.includes('/s1')) return { body: JSON.stringify({ data: { id: 42 } }) };
    gotUrl = url; gotBody = init.body;
    return { body: 'ok' };
  });
  await runHttpSteps([
    { name: 's1', url: 'https://a.com/s1', extract: { uid: 'data.id' } },
    { name: 's2', method: 'POST', url: 'https://a.com/s2?uid={{uid}}', body: '{"uid":"{{uid}}"}' },
  ]);
  assert.ok(gotUrl.includes('uid=42'));
  assert.ok(gotBody.includes('"42"'));
});

await t('某步失败带步骤名抛错', async () => {
  mockFetch(() => ({ status: 500, body: 'boom' }));
  await assert.rejects(
    runHttpSteps([{ name: '登录', url: 'https://a.com/x' }]),
    /登录.*状态码 500/
  );
});

await t('extract 路径不存在抛错', async () => {
  mockFetch(() => ({ body: JSON.stringify({ a: 1 }) }));
  await assert.rejects(
    runHttpSteps([{ name: 's1', url: 'https://a.com/x', extract: { t: 'data.nope' } }]),
    /路径 data\.nope 不存在/
  );
});

await t('空步骤抛错', async () => {
  await assert.rejects(runHttpSteps([]), /至少需要一个步骤/);
});

// ---- 统一网站反馈识别（signals.js 接入后）----
await t('返回登录页时给出可操作提示，而不是只说“不包含期望内容”', async () => {
  mockFetch(() => ({ body: '<html>请先登录后重试</html>' }));
  await assert.rejects(
    runHttpSteps([{ name: '签到', url: 'https://a.com/x', expect_contains: 'success' }]),
    /登录已失效/
  );
});

await t('验证码页给出人机验证提示', async () => {
  mockFetch(() => ({ body: '<div class="slide-verify">请完成滑动验证</div>' }));
  await assert.rejects(
    runHttpSteps([{ name: '签到', url: 'https://a.com/x', expect_contains: 'success' }]),
    /人机验证/
  );
});

await t('今日已签到不算失败（即使状态码非期望）', async () => {
  mockFetch(() => ({ status: 403, body: '<html>今日已签到，请勿重复</html>' }));
  const r = await runHttpSteps([{ name: '签到', url: 'https://a.com/x' }]);
  assert.equal(r.ok, true);
});

await t('状态码不符且无明确结论时，保留原始报错文案', async () => {
  mockFetch(() => ({ status: 500, body: 'boom' }));
  await assert.rejects(
    runHttpSteps([{ name: '签到', url: 'https://a.com/x' }]),
    /状态码 500，期望 200/
  );
});

// ---- 假成功防线：状态码 200 也不能把「被拦 / 要验证」当成签到成功 ----
// 实测（2026-09-28）：吾爱破解 /home.php 从机房 IP 拿到的是网宿 WZWS 的 JS 挑战页，
// 状态码正是 200，页面里连中文提示都没有（只有一句英文 Please enable JavaScript）。
// 老代码只看状态码，于是报出一句「签到成功」—— 最危险的那类假成功。
await t('WZWS/JS 挑战页（状态码 200）必须判为被拦，不能报「签到成功」', async () => {
  const page = '<!DOCTYPE HTML><html><head><meta charset="utf-8"></head><body>'
    + '<noscript><h1><strong>Please enable JavaScript and refresh the page.</strong></h1></noscript>'
    + '<script>var dynamicapi=\'/waf_zw_verify\';</script></body></html>';
  mockFetch(() => ({ status: 200, body: page }));
  const err = await runHttpSteps([{ name: '签到', url: 'https://www.52pojie.cn/home.php' }]).catch((e) => e);
  assert.ok(err instanceof Error, '不该当成成功，实际返回：' + JSON.stringify(err));
  assert.match(err.message, /安全|WAF|验证/);
  assert.equal(err.outcome, 'waf');
});

await t('限流/暂停也是明确结论，不因状态码 200 而报成功', async () => {
  mockFetch(() => ({ status: 200, body: '<html>请求过于频繁，请稍后再试</html>' }));
  const err = await runHttpSteps([{ name: '签到', url: 'https://a.com/x' }]).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /频繁|稍后/);
});

await t('普通的 200 页面仍按原来的规则算完成（不误伤）', async () => {
  mockFetch(() => ({ status: 200, body: '{"ok":true}' }));
  const r = await runHttpSteps([{ name: '签到', url: 'https://a.com/x' }]);
  assert.equal(r.ok, true);
});

console.log(`\n${n} 组通过`);
