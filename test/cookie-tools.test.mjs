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

console.log(`\n${n} 组通过`);
