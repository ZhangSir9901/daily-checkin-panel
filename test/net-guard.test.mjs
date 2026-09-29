// 出站地址闸门：node test/net-guard.test.mjs
//
// 【为什么要有这个】「导入社区配置」可以直接给一个网址让面板去拉。
// 不管的话，任何能登进面板的人（或将来某个被导入的配置）都能让 Worker 去请求
// 127.0.0.1 / 192.168.x / 169.254.169.254（云元数据），把内网服务的响应带回来。
// 这里把「该拒的拒、该放的放」钉住 —— 尤其是别误伤正常域名（fc2.com 这类以 fc 开头的）。
import assert from 'node:assert/strict';
import { isPrivateHost, checkPublicHttpUrl, isPublicHttpUrl, safePublicFetch } from '../src/lib/net-guard.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('内网 / 回环 / 链路本地地址一律认出来', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.254',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', 'localhost', 'LOCALHOST', 'a.localhost',
    'router.local', 'redis.internal', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateHost(h), true, h + ' 应该被认成内网地址');
  }
});

t('公网地址与正常域名不能被误伤', () => {
  for (const h of ['example.com', 'raw.githubusercontent.com', '8.8.8.8', '1.1.1.1', '203.0.113.9',
    'fc2.com', 'fdic.gov', 'my.local.com', 'api.day.app', '2606:4700::1111']) {
    assert.equal(isPrivateHost(h), false, h + ' 是公网地址，不该被拦');
  }
});

t('checkPublicHttpUrl：只放行 http/https，且拒绝内网', () => {
  assert.equal(checkPublicHttpUrl('https://raw.githubusercontent.com/x/y.json').ok, true);
  assert.equal(checkPublicHttpUrl('http://example.com/a.txt').ok, true);

  assert.equal(checkPublicHttpUrl('').ok, false);
  assert.equal(checkPublicHttpUrl('not a url').ok, false);
  assert.equal(checkPublicHttpUrl('file:///etc/passwd').ok, false);
  assert.equal(checkPublicHttpUrl('gopher://x/1').ok, false);
  assert.equal(checkPublicHttpUrl('https://127.0.0.1/x').ok, false);
  assert.equal(checkPublicHttpUrl('https://192.168.1.1/x').ok, false);
  assert.equal(checkPublicHttpUrl('https://169.254.169.254/latest/meta-data/').ok, false);
  assert.equal(isPublicHttpUrl('https://example.com/x'), true);
});

t('「看着不像 IP」的写法也要认出内网（IPv4 老写法 / IPv6 映射 / 末尾那个点）', () => {
  // 这些都指向 127.0.0.1 或内网，但字符串上看完全不显眼：
  //   127.1 → 127.0.0.1；2130706433 → 127.0.0.1（单个 32 位整数）；
  //   0x7f.0.0.1 / 0177.0.0.1 → 127.0.0.1（十六进制 / 八进制段）；localhost. → localhost（DNS 根域写法）
  for (const h of ['127.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1', '0x7f000001', '192.168.1', '10.1',
    'localhost.', '127.0.0.1.', 'a.localhost.', '::ffff:7f00:1', '::ffff:a00:5']) {
    assert.equal(isPrivateHost(h), true, h + ' 必须被认成内网/本机');
  }
  // 通过 URL 进来时，两种写法（点分十进制 与 归一化后的十六进制）都拦得住
  for (const u of ['http://127.1/', 'http://2130706433/', 'http://localhost./', 'http://[::ffff:127.0.0.1]/']) {
    assert.equal(checkPublicHttpUrl(u).ok, false, u + ' 必须被拦');
  }
});

t('拒绝时要把原因说清楚（前端直接展示这句话）', () => {
  assert.match(checkPublicHttpUrl('https://10.0.0.1/x').error, /内网|本机/);
  assert.match(checkPublicHttpUrl('ftp://x/y').error, /http/);
  assert.match(checkPublicHttpUrl('').error, /空/);
});

// ---------- safePublicFetch：每一跳都要过闸门 ----------
//
// 【为什么光校验输入不够】「先 checkPublicHttpUrl(用户填的地址) → 再 fetch(...)」只盖住了第一跳：
// 任何一个公网地址（包括临时起的短链）只要回一句
//   Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/
// Worker 就会老老实实跟过去，把云元数据当成「社区配置」拉回来。这里把这件事钉住。

const res = (status, headers = {}) => ({
  status,
  headers: { get: (k) => headers[k.toLowerCase()] || headers[k] || null },
  ok: status >= 200 && status < 300,
  url: '',
});

const t2 = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

await t2('safePublicFetch：正常地址一跳直达，不改写请求', async () => {
  const seen = [];
  const impl = async (u, init) => { seen.push({ u, redirect: init.redirect }); return res(200); };
  const got = await safePublicFetch('https://example.com/a.json', {}, { fetchImpl: impl });
  assert.equal(got.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].u, 'https://example.com/a.json');
  // 必须自己管重定向（关掉自动跟随），否则下面那些「跳进内网」根本拦不住
  assert.equal(seen[0].redirect, 'manual');
});

await t2('safePublicFetch：重定向到内网/云元数据 → 当场拦住，不去请求它', async () => {
  const seen = [];
  const impl = async (u) => {
    seen.push(u);
    if (seen.length === 1) return res(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    return res(200);
  };
  const got = await safePublicFetch('https://evil.example/conf.json', {}, { fetchImpl: impl });
  assert.equal(got.ok, false);
  assert.match(got.error, /重定向后指向了被禁止的地址/);
  assert.equal(seen.length, 1, '绝不应该真的去请求那个内网地址');
});

await t2('safePublicFetch：多跳公网重定向（相对 Location）照常跟到底', async () => {
  const seen = [];
  const impl = async (u) => {
    seen.push(u);
    if (seen.length === 1) return res(301, { location: '/v2/conf.json' });          // 相对地址
    if (seen.length === 2) return res(302, { location: 'https://cdn.example/c.json' }); // 跨主机
    return res(200);
  };
  const got = await safePublicFetch('https://raw.example/api/conf.json', {}, { fetchImpl: impl });
  assert.equal(got.ok, true);
  assert.deepEqual(seen, [
    'https://raw.example/api/conf.json',
    'https://raw.example/v2/conf.json', // 相对 Location 按上一跳的地址解析
    'https://cdn.example/c.json',
  ]);
});

await t2('safePublicFetch：重定向成死循环也要收口（不会一直转下去）', async () => {
  let calls = 0;
  const impl = async () => { calls++; return res(302, { location: 'https://a.example/loop' }); };
  const got = await safePublicFetch('https://a.example/loop', {}, { fetchImpl: impl, maxRedirects: 3 });
  assert.equal(got.ok, false);
  assert.match(got.error, /重定向次数过多/);
  assert.equal(calls, 4, '首跳 + 3 次跟随就该停');
});

await t2('safePublicFetch：manual 给出不透明响应（status 0）时退回 follow，并事后核对落地地址', async () => {
  const opaque = { status: 0, headers: { get: () => null }, ok: false, url: '' };
  // ① 落地地址是公网：放行（保护弱一点，但不能因此把功能弄坏）
  const okImpl = async (u, init) => (init.redirect === 'manual' ? opaque : { ...res(200), url: 'https://cdn.example/real' });
  const a = await safePublicFetch('https://example.com/x', {}, { fetchImpl: okImpl });
  assert.equal(a.ok, true);
  // ② 落地地址是内网：拦住 —— 响应正文不能再带回给调用方
  const badImpl = async (u, init) => (init.redirect === 'manual' ? opaque : { ...res(200), url: 'http://169.254.169.254/latest/meta-data/' });
  const b = await safePublicFetch('https://example.com/x', {}, { fetchImpl: badImpl });
  assert.equal(b.ok, false);
  assert.match(b.error, /重定向到了不该访问的地方/);
});

await t2('safePublicFetch：首跳就不合法时一个请求都不发', async () => {
  let calls = 0;
  const impl = async () => { calls++; return res(200); };
  const got = await safePublicFetch('http://127.0.0.1:8080/admin', {}, { fetchImpl: impl });
  assert.equal(got.ok, false);
  assert.equal(calls, 0);
});

await t2('safePublicFetch：3xx 但没带 Location → 报错而不是当成正常响应', async () => {
  const impl = async () => res(302, {});
  const got = await safePublicFetch('https://example.com/x', {}, { fetchImpl: impl });
  assert.equal(got.ok, false);
  assert.match(got.error, /没带 Location/);
});

console.log(`\n${n} 组通过`);
