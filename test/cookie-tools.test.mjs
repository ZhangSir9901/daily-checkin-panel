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

t('识别：不认识的内容要报错，不能默默当成 Cookie', () => {
  assert.throws(() => parsePasteText('这是一段普通文字，没有任何等号'), /没看出这是 Cookie/);
  assert.throws(() => parsePasteText(''), /请先在目标网站/);
});

t('explainCookieText：每一段都给出类型 + 中文说明 + 值形态', () => {
  const raw = 'Cookie: PHPSESSID=abc123; wordpress_logged_in_a=laoguo%7C1730000000%7Cabcdef; wzws_cid=0123456789abcdef0123456789abcdef; _ga=GA1.2.99';
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

console.log(`\n${n} 组通过`);
