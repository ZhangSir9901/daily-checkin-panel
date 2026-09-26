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

console.log(`\n${n} 组通过`);
