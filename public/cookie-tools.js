// Cookie 获取工具：把多种常见格式解析成 Cookie 字符串。
// 支持：原始 Cookie 字符串 / 完整请求头文本 / cURL 命令 /
//       Cookie-Editor(EditThisCookie) 导出的 JSON / Netscape cookie.txt。
// 纯函数、无 DOM 依赖：浏览器端 <script src> 引入，Node 端测试时 eval 加载。
// 挂载为全局：parseCookieHeader, extractCookieFromHeaders,
//             parseCookieEditorJson, parseNetscapeCookies, extractCookieFromCurl

function parseCookieHeader(str) {
  const s = String(str == null ? '' : str).trim().replace(/^Cookie\s*:\s*/i, '').trim();
  if (!s) throw new Error('内容为空，请先粘贴 Cookie');
  const parts = s.split(';').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('没有解析到有效的 Cookie');
  return parts.join('; ');
}

function extractCookieFromHeaders(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const found = [];
  let userAgent = '';
  for (const line of lines) {
    const m = line.match(/^\s*cookie\s*:\s*(.+?)\s*$/i);
    if (m && m[1]) found.push(m[1]);
    const u = line.match(/^\s*user-agent\s*:\s*(.+?)\s*$/i);
    if (u && u[1]) userAgent = u[1];
  }
  if (!found.length) throw new Error('没有找到 Cookie 请求头（形如 Cookie: a=1; b=2）');
  return { cookie: parseCookieHeader(found.join('; ')), userAgent };
}

function parseCookieEditorJson(text) {
  let arr;
  try {
    arr = JSON.parse(String(text == null ? '' : text).trim());
  } catch (e) {
    throw new Error('JSON 解析失败：' + e.message);
  }
  if (!Array.isArray(arr)) {
    // 兼容单个对象
    if (arr && typeof arr === 'object' && arr.name) arr = [arr];
    else throw new Error('需要 Cookie-Editor / EditThisCookie 导出的 JSON 数组');
  }
  const parts = [];
  for (const c of arr) {
    if (!c || !c.name) continue;
    parts.push(c.name + '=' + (c.value == null ? '' : c.value));
  }
  if (!parts.length) throw new Error('JSON 里没有可用的 Cookie');
  return parts.join('; ');
}

function parseNetscapeCookies(text) {
  // Netscape cookie.txt：每行 domain \t flag \t path \t secure \t expires \t name \t value
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const parts = [];
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length).trim();
    else if (line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const name = (f[5] || '').trim();
    const value = (f[6] || '').trim();
    if (!name) continue;
    parts.push(name + '=' + value);
  }
  if (!parts.length) throw new Error('没有解析到有效的 Cookie（需要 Netscape cookie.txt 格式，每行 7 列）');
  return parts.join('; ');
}

function extractCookieFromCurl(cmd) {
  // parseCurl 由 curl-import.js 提供（浏览器端先引入该文件，测试时先 eval 它）
  const pc = typeof parseCurl === 'function' ? parseCurl : (typeof globalThis !== 'undefined' && typeof globalThis.parseCurl === 'function' ? globalThis.parseCurl : null);
  if (!pc) throw new Error('cURL 解析器未加载');
  const p = pc(cmd);
  const cookie = p.headers['Cookie'] || p.headers['cookie'];
  if (!cookie || !String(cookie).trim()) throw new Error('这条 cURL 里没有 Cookie（需要 -H "Cookie: ..." 或 -b 参数）');
  const ua = p.headers['User-Agent'] || p.headers['user-agent'] || '';
  return { cookie: parseCookieHeader(cookie), userAgent: ua, url: p.url };
}

if (typeof globalThis !== 'undefined') {
  globalThis.parseCookieHeader = parseCookieHeader;
  globalThis.extractCookieFromHeaders = extractCookieFromHeaders;
  globalThis.parseCookieEditorJson = parseCookieEditorJson;
  globalThis.parseNetscapeCookies = parseNetscapeCookies;
  globalThis.extractCookieFromCurl = extractCookieFromCurl;
}
