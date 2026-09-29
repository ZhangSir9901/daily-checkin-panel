// 站点自动识别测试：node test/detect.test.mjs（纯函数，无网络）
// 覆盖 public/ext-src/detect.js 的 detectSite 判定规则。
// detect.js 是浏览器 classic script，这里用 module 桩把它载进来。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(join(root, 'public', 'ext-src', 'detect.js'), 'utf8');
const module = { exports: {} };
new Function('module', 'exports', code)(module, module.exports);
const { detectSite, collectPageFingerprint, DETECT_SITE_NAMES } = module.exports;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

await t('akile：localStorage 有 akile-token → 高置信', () => {
  const r = detectSite(null, [], ['akile-token', 'other'], 'akile.ai');
  assert.equal(r.site, 'akile');
  assert.equal(r.confidence, 'high');
});

await t('糊涂鳄：wordpress_logged_in_ Cookie → 高置信', () => {
  const r = detectSite(null, ['wordpress_logged_in_abc123', 'wp-settings-1'], [], 'hutue.cn');
  assert.equal(r.site, 'hutue');
  assert.equal(r.confidence, 'high');
});

await t('吾爱：Discuz saltkey + 52pojie 域名 → 高置信', () => {
  const r = detectSite(null, ['aY9R_2132_saltkey', 'aY9R_2132_auth'], [], 'www.52pojie.cn');
  assert.equal(r.site, 'wuaipojie');
  assert.equal(r.confidence, 'high');
});

await t('看雪：Discuz saltkey + kanxue 域名 → 高置信', () => {
  const r = detectSite(null, ['xx_2132_saltkey'], [], 'bbs.kanxue.com');
  assert.equal(r.site, 'kanxue');
  assert.equal(r.confidence, 'high');
});

await t('未知 Discuz 站：saltkey 但域名不在内置站点 → medium 推荐通用 Discuz', () => {
  const r = detectSite(null, ['ab12_saltkey'], [], 'bbs.example.com');
  assert.equal(r.site, 'misign');
  assert.equal(r.confidence, 'medium');
});

await t('域名关键词：nodeseek → 高置信', () => {
  const r = detectSite(null, ['session'], [], 'www.nodeseek.com');
  assert.equal(r.site, 'nodeseek');
  assert.equal(r.confidence, 'high');
});

await t('V2Board：页面含 v2board 字样 → 高置信', () => {
  const r = detectSite({ html: '<html><title>V2Board 面板</title></html>', path: '/' }, [], [], 'example.com');
  assert.equal(r.site, 'v2board');
  assert.equal(r.confidence, 'high');
});

await t('V2Board：69 登录页实测指纹（metron-assets）→ medium 推荐', () => {
  const html = '<link href="/metron-assets-3.0.2/metron/css/style.bundle.css"><form id="login_form">';
  const r = detectSite({ html, path: '/auth/login' }, ['remember'], [], '69yun69.com');
  assert.equal(r.site, 'v2board');
  assert.equal(r.confidence, 'medium');
  assert.ok(r.reason.includes('metron'));
});

await t('V2Board：/api/v1/ 引用 → medium 推荐', () => {
  const r = detectSite({ html: '<script>fetch("/api/v1/user/info")</script>', path: '/user' }, [], [], 'airport.example');
  assert.equal(r.site, 'v2board');
  assert.equal(r.confidence, 'medium');
});

await t('V2Board：/auth/login 路由 → medium 推荐', () => {
  const r = detectSite({ html: '<html></html>', path: '/auth/login' }, [], [], 'airport.example');
  assert.equal(r.site, 'v2board');
  assert.equal(r.confidence, 'medium');
});

await t('认不出 → null（面板走原来的手动选择）', () => {
  assert.equal(detectSite(null, ['foo', 'bar'], [], 'example.com'), null);
  assert.equal(detectSite({ html: '', path: '/' }, [], [], ''), null);
});

await t('规则优先级：akile-token 优先于域名关键词', () => {
  const r = detectSite(null, [], ['akile-token'], 'akile.example.com');
  assert.equal(r.site, 'akile');
});

await t('collectPageFingerprint：用桩跑通，字段齐全', () => {
  globalThis.document = {
    title: 'T',
    documentElement: { outerHTML: '<html>x</html>' },
  };
  globalThis.location = { pathname: '/auth/login' };
  const store = { 'akile-token': 'jwt' };
  globalThis.localStorage = {
    length: 1,
    key: (i) => (i === 0 ? 'akile-token' : null),
    getItem: (k) => store[k] || null,
  };
  const fp = collectPageFingerprint();
  assert.equal(fp.title, 'T');
  assert.equal(fp.path, '/auth/login');
  assert.deepEqual(fp.lsKeys, ['akile-token']);
  assert.ok(fp.html.includes('<html>'));
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.localStorage;
});

await t('DETECT_SITE_NAMES：识别结果里的站点都有中文名', () => {
  for (const id of ['akile', 'hutue', 'wuaipojie', 'kanxue', 'misign', 'nodeseek', 'v2ex', 'quark', 'cloud189', 'v2board']) {
    assert.ok(DETECT_SITE_NAMES[id], id);
  }
});

console.log(`\n${n} 组通过`);
