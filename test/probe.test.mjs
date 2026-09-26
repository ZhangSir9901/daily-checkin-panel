// probeSignEndpoints 测试：node test/probe.test.mjs（纯 mock，不依赖网络）
import assert from 'node:assert/strict';
import { probeSignEndpoints } from '../src/probe.js';

const HTML = `
<html><head>
<script>var cfg={"ajaxurl":"https:\\/\\/example.com\\/wp-admin\\/admin-ajax.php"};</script>
<script src="/static/jquery.min.js"></script>
<script src="/static/app.js"></script>
</head>
<body>
<nav><a href="/user/sign">每日签到</a><a href="/design/gallery">设计作品</a></nav>
<button data-url="/api/checkin">打卡领奖</button>
<div onclick="go('/promo/sign-wall')">签到墙</div>
<script>fetch("/api/v1/attendance/record",{method:"POST"});</script>
<a href="https://cdn.example.com/box/box_1002671_signed.apk">下载 App</a>
</body></html>`;
const JS = `var u="/api/sign/do"; $.post(ajaxurl,{action:"user_qiandao"},function(){}); var d="/design/icons";`;

const mockFetch = async (u) => {
  const s = String(u);
  const body = s.includes('/static/app.js') ? JS : HTML;
  return { ok: true, status: 200, text: async () => body };
};

const urls = (r) => r.candidates.map((c) => c.url);

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

await t('找到页面签到链接', async () => {
  const r = await probeSignEndpoints({ url: 'https://example.com/', fetchImpl: mockFetch });
  assert.ok(urls(r).includes('https://example.com/user/sign'));
});

await t('排除 design 误伤', async () => {
  const r = await probeSignEndpoints({ url: 'https://example.com/', fetchImpl: mockFetch });
  assert.ok(!urls(r).some((u) => u.includes('/design/')));
});

await t('排除 signed.apk 误伤', async () => {
  const r = await probeSignEndpoints({ url: 'https://example.com/', fetchImpl: mockFetch });
  assert.ok(!urls(r).some((u) => u.includes('.apk')), 'signed.apk 不应被当成签到接口');
});

await t('找到按钮 data-url', async () => {
  const r = await probeSignEndpoints({ url: 'https://example.com/', fetchImpl: mockFetch });
  assert.ok(urls(r).includes('https://example.com/api/checkin'));
});

await t('找到页面代码中的接口', async () => {
  const r = await probeSignEndpoints({ url: 'https://example.com/', fetchImpl: mockFetch });
  assert.ok(urls(r).includes('https://example.com/api/v1/attendance/record'));
});

await t('JS 中发现接口（库文件靠后仍能抓到 app.js）', async () => {
  const r = await probeSignEndpoints({ url: 'https://example.com/', fetchImpl: mockFetch });
  assert.ok(urls(r).includes('https://example.com/api/sign/do'));
});

await t('识别 WP 风格签到动作 action=user_qiandao', async () => {
  const r = await probeSignEndpoints({ url: 'https://example.com/', fetchImpl: mockFetch });
  const c = r.candidates.find((x) => x.body === 'action=user_qiandao');
  assert.ok(c, '应识别出 user_qiandao 动作');
  assert.equal(c.url, 'https://example.com/wp-admin/admin-ajax.php');
  assert.match(c.label, /action=user_qiandao/);
});

await t('onclick 中的签到链接', async () => {
  const r = await probeSignEndpoints({ url: 'https://example.com/', fetchImpl: mockFetch });
  assert.ok(urls(r).includes('https://example.com/promo/sign-wall'));
});

await t('相对路径解析为绝对地址', async () => {
  const r = await probeSignEndpoints({ url: 'https://example.com/sub/page', fetchImpl: mockFetch });
  assert.ok(r.candidates.every((c) => c.url.startsWith('https://example.com/')));
});

await t('去重', async () => {
  const r = await probeSignEndpoints({ url: 'https://example.com/', fetchImpl: mockFetch });
  const u = urls(r);
  assert.equal(u.length, new Set(u.map((x, i) => x + '|' + r.candidates[i].body)).size);
});

await t('非法 URL 报错', async () => {
  await assert.rejects(() => probeSignEndpoints({ url: 'not-a-url', fetchImpl: mockFetch }), /http/);
});

await t('首页抓取失败时报错', async () => {
  const bad = async () => ({ ok: false, status: 403, text: async () => '' });
  await assert.rejects(() => probeSignEndpoints({ url: 'https://example.com/', fetchImpl: bad }), /403/);
});

console.log(`\n全部通过：${n} 组`);
