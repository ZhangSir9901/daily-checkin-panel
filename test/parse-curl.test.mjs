// parseCurl 测试：node test/parse-curl.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
eval(readFileSync(join(root, 'public', 'curl-import.js'), 'utf8'));
const parse = globalThis.parseCurl;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

// 1. 最简 GET
t('基础 GET', () => {
  const r = parse(`curl 'https://example.com/api/sign'`);
  assert.equal(r.url, 'https://example.com/api/sign');
  assert.equal(r.method, 'GET');
  assert.deepEqual(r.headers, {});
  assert.equal(r.body, '');
});

// 2. Chrome 开发者工具风格（含续行、--compressed、--data-raw）
t('Chrome 复制的 cURL', () => {
  const r = parse(`curl 'https://www.nodeseek.com/api/attendance?random=true' \\
  -H 'accept: application/json' \\
  -H 'Cookie: session=abc; x=1' \\
  -H 'User-Agent: Mozilla/5.0' \\
  --data-raw '{"a":1}' \\
  --compressed`);
  assert.equal(r.url, 'https://www.nodeseek.com/api/attendance?random=true');
  assert.equal(r.method, 'POST'); // 有 body 默认 POST
  assert.equal(r.headers['Cookie'], 'session=abc; x=1');
  assert.equal(r.headers['accept'], 'application/json');
  assert.equal(r.body, '{"a":1}');
});

// 3. 双引号 + -X 显式方法
t('双引号与 -X', () => {
  const r = parse(`curl "https://a.com/x" -X "PUT" -H "X-A: b c" --data-binary "p=1"`);
  assert.equal(r.method, 'PUT');
  assert.equal(r.headers['X-A'], 'b c');
  assert.equal(r.body, 'p=1');
});

// 4. -b 多次出现合并 Cookie
t('-b 合并 Cookie', () => {
  const r = parse(`curl https://a.com -b 'a=1' -b 'b=2'`);
  assert.equal(r.headers['Cookie'], 'a=1; b=2');
});

// 5. -A / -e 转请求头
t('-A 与 -e', () => {
  const r = parse(`curl https://a.com -A 'MyUA/1.0' -e 'https://ref.com/'`);
  assert.equal(r.headers['User-Agent'], 'MyUA/1.0');
  assert.equal(r.headers['Referer'], 'https://ref.com/');
});

// 6. 多个 -d 用 & 连接
t('多个 -d 连接', () => {
  const r = parse(`curl https://a.com -d 'a=1' --data 'b=2'`);
  assert.equal(r.body, 'a=1&b=2');
  assert.equal(r.method, 'POST');
});

// 7. 头部值含冒号（如 Cookie 里的时间）
t('头部值含冒号', () => {
  const r = parse(`curl https://a.com -H 'Cookie: t=12:34:56; x=1'`);
  assert.equal(r.headers['Cookie'], 't=12:34:56; x=1');
});

// 8. 异常输入
t('空命令报错', () => assert.throws(() => parse(''), /粘贴/));
t('非 http URL 报错', () => assert.throws(() => parse('curl ftp://a.com/x'), /http/));

console.log(`\n全部通过：${n} 组`);
