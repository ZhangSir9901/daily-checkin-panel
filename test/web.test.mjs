// web.js 通用登录模拟工具测试：node test/web.test.mjs（纯 mock，不依赖网络）
import assert from 'node:assert/strict';
import { browserHeaders, cookiesFrom, mergeCookies, postForm, postJSON, getPage } from '../src/lib/web.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

function mockFetch(handler) {
  globalThis.fetch = async (url, init = {}) => {
    globalThis.__last = { url: String(url), init };
    const { body, setCookies = [] } = handler(String(url), init);
    const headers = new Headers();
    for (const c of setCookies) headers.append('set-cookie', c);
    return { status: 200, headers, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

await t('browserHeaders 带 Referer/Origin/UA', async () => {
  const h = browserHeaders('https://example.com/uuid/auth/login');
  assert.match(h['User-Agent'], /Chrome/);
  assert.equal(h.Referer, 'https://example.com/uuid/auth/login');
  assert.equal(h.Origin, 'https://example.com');
  assert.match(h.Accept, /application\/json/);
});

await t('postForm 发表单编码并带浏览器头', async () => {
  mockFetch(() => ({ body: { ret: 1 } }));
  await postForm('https://example.com/auth/login', { email: 'a@b.c', passwd: 'pw' }, { pageUrl: 'https://example.com/auth/login' });
  const { init } = globalThis.__last;
  assert.match(init.headers['Content-Type'], /x-www-form-urlencoded/);
  assert.equal(init.headers.Referer, 'https://example.com/auth/login');
  assert.equal(init.headers.Origin, 'https://example.com');
  const params = new URLSearchParams(init.body);
  assert.equal(params.get('email'), 'a@b.c');
  assert.equal(params.get('passwd'), 'pw');
});

await t('postForm 收集登录 Cookie', async () => {
  mockFetch(() => ({ body: { ret: 1 }, setCookies: ['PHPSESSID=xyz; Path=/; HttpOnly'] }));
  const { j, cookie } = await postForm('https://example.com/auth/login', { a: '1' }, {});
  assert.equal(j.ret, 1);
  assert.match(cookie, /PHPSESSID=xyz/);
});

await t('postJSON 带浏览器头', async () => {
  mockFetch(() => ({ body: { ret: 1 } }));
  await postJSON('https://example.com/api', { x: 1 }, { cookie: 'a=b', pageUrl: 'https://example.com/page' });
  const { init } = globalThis.__last;
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Cookie, 'a=b');
  assert.equal(init.headers.Referer, 'https://example.com/page');
});

await t('mergeCookies 同名以后者为准', async () => {
  const m = mergeCookies('a=1; b=2', 'b=3; c=4');
  assert.match(m, /a=1/);
  assert.match(m, /b=3/);
  assert.match(m, /c=4/);
});

await t('getPage 模拟浏览器访问登录页', async () => {
  mockFetch(() => ({ body: {}, setCookies: ['init=1; Path=/'] }));
  const { cookie } = await getPage('https://example.com/auth/login', {});
  assert.match(cookie, /init=1/);
  assert.equal(globalThis.__last.init.method, 'GET');
});

console.log(`\n${n} passed`);
