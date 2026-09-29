// cookie-tools 测试：node test/cookie-tools.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
eval(readFileSync(join(root, 'public', 'curl-import.js'), 'utf8'));
eval(readFileSync(join(root, 'public', 'cookie-tools.js'), 'utf8'));
const { parseCookieHeader, extractCookieFromHeaders, parseCookieEditorJson, parseNetscapeCookies, extractCookieFromCurl } = globalThis;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('原始 Cookie 字符串规范化', () => {
  assert.equal(parseCookieHeader('a=1;b=2;; c=3 '), 'a=1; b=2; c=3');
  assert.equal(parseCookieHeader('Cookie: x=y'), 'x=y');
});

t('原始字符串为空报错', () => {
  assert.throws(() => parseCookieHeader('   '), /内容为空/);
});

t('从请求头文本提取', () => {
  const txt = 'GET / HTTP/1.1\nHost: www.nodeseek.com\nCookie: a=1; b=2\nUser-Agent: x';
  // 同时带回 UA，便于吾爱等需要 UA 与 Cookie 配对的站点直接填入
  assert.deepEqual(extractCookieFromHeaders(txt), { cookie: 'a=1; b=2', userAgent: 'x' });
});

t('请求头无 Cookie 报错', () => {
  assert.throws(() => extractCookieFromHeaders('Host: a.com\nX: 1'), /没有找到 Cookie/);
});

t('Cookie-Editor JSON 导入', () => {
  const json = JSON.stringify([
    { name: 'a', value: '1', domain: '.nodeseek.com' },
    { name: 'b', value: 'hello world' },
    { name: '', value: 'skip' },
  ]);
  assert.equal(parseCookieEditorJson(json), 'a=1; b=hello world');
});

t('JSON 格式错误报错', () => {
  assert.throws(() => parseCookieEditorJson('not json'), /JSON 解析失败/);
  assert.throws(() => parseCookieEditorJson('{"a":1}'), /JSON 数组/);
});

t('Netscape cookie.txt 导入', () => {
  const txt = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.nodeseek.com\tTRUE\t/\tFALSE\t1234567890\tsess\tabc123',
    '.nodeseek.com\tTRUE\t/\tFALSE\t1234567890\tuid\t42',
    '',
  ].join('\n');
  assert.equal(parseNetscapeCookies(txt), 'sess=abc123; uid=42');
});

t('cookie.txt 无效报错', () => {
  assert.throws(() => parseNetscapeCookies('# only comments\n'), /没有解析到/);
});

t('从 cURL 提取 Cookie（-H）', () => {
  const r = extractCookieFromCurl(`curl 'https://www.nodeseek.com/api/attendance?random=true' -H 'Cookie: a=1;b=2' -H 'User-Agent: MyUA/1.0'`);
  assert.equal(r.cookie, 'a=1; b=2');
  assert.equal(r.userAgent, 'MyUA/1.0');
});

t('从 cURL 提取 Cookie（-b）', () => {
  const r = extractCookieFromCurl(`curl -b 'x=9' 'https://example.com/'`);
  assert.equal(r.cookie, 'x=9');
  assert.equal(r.userAgent, '');
});

t('cURL 无 Cookie 报错', () => {
  assert.throws(() => extractCookieFromCurl(`curl 'https://example.com/'`), /没有 Cookie/);
});

// ---------- Cookie 逐段中文说明（面板「Cookie 解析器」的核心字典）----------
// 目的：用户粘一大串时能看懂哪段是登录必需、哪段是网站安全校验、哪些只是统计。
t('cookie 说明：登录必需 / 安全校验 / 统计 三类能分清', () => {
  assert.equal(describeCookieName('PHPSESSID').kind, 'login');
  assert.match(describeCookieName('PHPSESSID').desc, /PHP 会话/);
  assert.equal(describeCookieName('wordpress_logged_in_abc').kind, 'login');
  assert.match(describeCookieName('wordpress_logged_in_abc').desc, /WordPress/);
  // 吾爱破解的 WAF 校验 Cookie 必须单独归为「安全校验」——它失效就等于 403
  assert.equal(describeCookieName('wzws_cid').kind, 'waf');
  assert.match(describeCookieName('wzws_cid').desc, /网宿/);
  assert.equal(describeCookieName('cf_clearance').kind, 'waf');
  assert.equal(describeCookieName('_ga').kind, 'stat');
  assert.equal(describeCookieName('Hm_lvt_1234').kind, 'stat');
});

t('cookie 说明：不认识的名字归为「站点自定义」，不能瞎猜', () => {
  const d = describeCookieName('some_random_bbs_key');
  assert.equal(d.kind, 'other');
  assert.match(d.desc, /站点自定义/);
});

t('cookie 值说明：只讲形态、不展开值，长度和类型都要报出来', () => {
  const jwt = describeCookieValue('eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjEyMzQ1Njc4fQ.abcdefghijklmn');
  assert.match(jwt, /长度 \d+/);
  assert.match(jwt, /JWT/);
  assert.match(describeCookieValue(String(Math.floor(Date.now() / 1000))), /Unix 时间戳/);
  assert.match(describeCookieValue(''), /空值/);
  // 值不能整段吐出来：只留头尾做比对用
  const long = 'x'.repeat(40);
  const shown = describeCookieValue(long);
  assert.ok(!shown.includes(long), '不应把完整值原样展示');
});

// ---------- parsePasteText / explainCookieText：面板「Cookie 解析器」的底座 ----------
// 用户会粘进来的东西很杂（扩展 JSON / 请求头 / cURL / cookie.txt / 裸串），都要认。
t('识别：裸 Cookie 串', () => {
  const r = parsePasteText('a=1; b=2');
  assert.equal(r.format, '纯 Cookie 字符串');
  assert.equal(r.cookie, 'a=1; b=2');
});

t('识别：F12 请求头（Cookie + UA 一起拿）', () => {
  const r = parsePasteText('Accept: */*\nCookie: PHPSESSID=abc; token=xyz\nUser-Agent: MyUA/9.9');
  assert.equal(r.format, '浏览器复制的请求头');
  assert.equal(r.cookie, 'PHPSESSID=abc; token=xyz');
  assert.equal(r.userAgent, 'MyUA/9.9');
});

t('识别：扩展「一键复制全部信息」的 JSON', () => {
  const payload = JSON.stringify({
    domain: 'www.52pojie.cn', cookies: 'wzws_cid=abc; cdb_sid=1', userAgent: 'UA-from-ext',
    cookieList: [{ name: 'wzws_cid', value: 'abc', httpOnly: true }, { name: 'cdb_sid', value: '1' }],
    localStorage: { a: '1' },
  });
  const r = parsePasteText(payload);
  assert.equal(r.format, '扩展「一键复制全部信息」');
  assert.equal(r.domain, 'www.52pojie.cn');
  assert.equal(r.userAgent, 'UA-from-ext');
  assert.equal(r.cookieList.length, 2);
});

t('识别：扩展 JSON 里的 pageUrl（采集时的完整页面地址）被带出来', () => {
  const payload = JSON.stringify({
    domain: 'www.v2ex.com', pageUrl: 'https://www.v2ex.com/mission/daily',
    cookies: 'A2=abc', userAgent: 'UA/1',
  });
  const r = parsePasteText(payload);
  assert.equal(r.pageUrl, 'https://www.v2ex.com/mission/daily');
  // 旧版扩展没这个字段：解析不能炸，缺省为空
  const r2 = parsePasteText(JSON.stringify({ domain: 'a.com', cookies: 'x=1' }));
  assert.equal(r2.pageUrl, '');
});

t('识别：不认识的内容要报错，不能默默当成 Cookie', () => {
  assert.throws(() => parsePasteText('这是一段普通文字，没有任何等号'), /没看出这是 Cookie/);
  assert.throws(() => parsePasteText(''), /请先在目标网站/);
});

t('explainCookieText：每一段都给出类型 + 中文说明 + 值形态', () => {
  const raw = 'Cookie: PHPSESSID=abc123; wordpress_logged_in_a=other-user%7C1730000000%7Cabcdef; wzws_cid=0123456789abcdef0123456789abcdef; _ga=GA1.2.99';
  const info = explainCookieText(raw);
  assert.equal(info.parts.length, 4);
  const byName = Object.fromEntries(info.parts.map((p) => [p.name, p]));
  assert.equal(byName.PHPSESSID.kind, 'login');
  assert.match(byName.PHPSESSID.desc, /PHP 会话/);
  assert.equal(byName.wordpress_logged_in_a.kind, 'login');
  // 吾爱破解的 WAF cookie 必须被单独标出来，用户才知道它不能丢
  assert.equal(byName.wzws_cid.kind, 'waf');
  assert.equal(byName._ga.kind, 'stat');
  // 值形态：长度 + 特征，不把整段值吐出来
  assert.match(byName.PHPSESSID.detail, /长度 6/);
  assert.ok(!byName.PHPSESSID.detail.includes('abc123'), '不应原样展示值');
  // 小结要把“几段登录必需 / 几段安全校验”说人话
  assert.match(info.summary, /共 4 段/);
  assert.match(info.summary, /登录必需 2 段/);
  assert.match(info.summary, /安全校验 1 段/);
  assert.match(info.summary, /纯统计 1 段/);
});

// ---------------------------------------------------------------------------
// 粘贴内容的体检（checkPastedCreds）：保存前把能查的都查一遍
// ---------------------------------------------------------------------------
t('体检：一份正常的扩展 JSON → 通过，并说清每一段是什么', () => {
  const info = parsePasteText(JSON.stringify({
    domain: 'dj.hutue.cn',
    cookies: 'wordpress_logged_in_a=other-user%7C1; _ga=GA1.2.3',
    userAgent: 'UA',
  }));
  const r = globalThis.checkPastedCreds(info);
  assert.equal(r.level, 'ok');
  assert.ok(r.items.some((i) => /认出了格式/.test(i.title)));
  assert.ok(r.items.some((i) => /会话|登录必需/.test(i.detail || '')));
  assert.ok(r.items.some((i) => /来自网站：dj\.hutue\.cn/.test(i.title)));
});

t('体检：只有统计类 Cookie → 提醒可能没登录态', () => {
  const r = globalThis.checkPastedCreds(parsePasteText('_ga=GA1.2.3; theme=dark'));
  assert.equal(r.level, 'warn');
  assert.ok(r.items.some((i) => i.level === 'warn' && /没看出「登录必需」/.test(i.title)));
  // 裸 Cookie 串里没有域名 —— 必须提醒得手动选站点
  assert.ok(r.items.some((i) => i.level === 'warn' && /没带域名/.test(i.title)));
  assert.ok(!r.items.some((i) => i.level === 'bad'));
});

t('体检：空 Cookie → 硬错误，不许保存', () => {
  const r = globalThis.checkPastedCreds({ cookie: '', format: '扩展「一键复制全部信息」' });
  assert.equal(r.level, 'bad');
  assert.match(r.items[0].title, /没有读到 Cookie/);
  assert.match(r.items[0].detail, /一键复制全部信息/);
});

t('体检：空值 Cookie 会被点名（最容易“看着成功其实没抓到”）', () => {
  const r = globalThis.checkPastedCreds(parsePasteText('PHPSESSID=; cdb_sid='));
  assert.equal(r.level, 'warn');
  const empty = r.items.find((i) => /空值/.test(i.title));
  assert.ok(empty);
  assert.match(empty.detail, /PHPSESSID/);
});

t('粘贴没复制全的 JSON：要说“像没复制全”，而不是只报 JSON 错了', () => {
  assert.throws(
    () => parsePasteText('{"domain":"dj.hutue.cn","cookies":"a=1"'),
    /没复制全/);
  assert.throws(() => parsePasteText('{"a":1}'), /没有 Cookie/);
});

// 线上真实案例（2026-09-29）：hutue.cn 的账号里混着 dj.hutue.cn 的登录会话，
// 用户一直以为「我更新了 Cookie」，而属于 hutue.cn 的那段早就过期了。
t('体检：登录会话已过期 → 提醒（不再硬拦），并给出两条出路', () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const r = globalThis.checkPastedCreds({
    cookie: `wordpress_logged_in_ec35f1949aa62d7b02e78d74b17cb6b5=demo-user%7C${past}%7Ct%7Ch`,
    format: '扩展「一键复制全部信息」', domain: 'hutue.cn',
  });
  assert.equal(r.level, 'warn', '不再判 bad：填了账号密码的站点能自动重新登录，不该把保存按钮封死');
  const it = r.items.find((i) => /登录会话已经过期/.test(i.title));
  assert.ok(it, JSON.stringify(r.items.map((i) => i.title)));
  assert.match(it.detail, /账号密码/);
  assert.match(it.detail, /重新登录/);
});

t('体检：一份 Cookie 里混了两个域名的登录会话 → 点名说出来', () => {
  const future = Math.floor(Date.now() / 1000) + 86400;
  const r = globalThis.checkPastedCreds({
    cookie: `wordpress_logged_in_ec35f1949aa62d7b02e78d74b17cb6b5=u1%7C${future}%7Ct%7Ch; `
      + `wordpress_logged_in_ca7674586a167c665930997282100f84=u2%7C${future}%7Ct%7Ch`,
    cookieList: [
      { name: 'wordpress_logged_in_ec35f1949aa62d7b02e78d74b17cb6b5', value: 'x', domain: '.hutue.cn' },
      { name: 'wordpress_logged_in_ca7674586a167c665930997282100f84', value: 'x', domain: 'dj.hutue.cn' },
    ],
    format: '扩展「一键复制全部信息」', domain: 'hutue.cn',
  });
  assert.equal(r.level, 'warn');
  const mixed = r.items.find((i) => /混了两个域名/.test(i.title));
  assert.ok(mixed, JSON.stringify(r.items.map((i) => i.title)));
  assert.match(mixed.detail, /另一个站/);
  // 会话那段要说清是哪个域名来的，用户才能自己去对
  const sess = r.items.find((i) => /登录会话有效/.test(i.title));
  assert.match(sess.detail, /来自 \.hutue\.cn/);
  assert.match(sess.detail, /来自 dj\.hutue\.cn/);
});

console.log(`\n${n} 组通过`);
