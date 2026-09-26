// cURL 命令解析器：把浏览器开发者工具「复制为 cURL」得到的命令，
// 解析成 { url, method, headers, body }，用于一键填入「自定义 HTTP」签到配置。
// 纯函数、无 DOM 依赖：浏览器端直接 <script src> 引入，Node 端测试时 eval 加载。
// 挂载为全局 parseCurl。

function parseCurl(cmd) {
  if (!cmd || !String(cmd).trim()) throw new Error('请先粘贴 cURL 命令');

  // 1) 去掉行尾续行符 "\ + 换行"
  let s = String(cmd).replace(/\\\r?\n/g, ' ');

  // 2) shell 风格分词：处理单引号、双引号、反斜杠转义
  const tokens = [];
  let cur = '';
  let quote = null; // "'" | '"' | null
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { cur += s[i + 1]; i++; }
      else cur += c;
    } else {
      if (c === "'") quote = "'";
      else if (c === '"') quote = '"';
      else if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i++; }
      else if (/\s/.test(c)) {
        if (cur) { tokens.push(cur); cur = ''; }
      } else cur += c;
    }
  }
  if (cur) tokens.push(cur);
  if (!tokens.length) throw new Error('无法解析该命令');

  // 3) 解析参数
  let url = '';
  let method = '';
  const headers = {};
  const bodies = [];

  const takeNext = (i) => (i + 1 < tokens.length ? tokens[i + 1] : '');
  const setHeader = (k, v) => {
    k = k.trim();
    if (!k) return;
    // Cookie 出现多次时合并
    if (/^cookie$/i.test(k) && headers[k]) headers[k] = headers[k] + '; ' + v.trim();
    else headers[k] = v.trim();
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (i === 0 && /^(curl|curl\.exe)$/i.test(t)) continue;

    if (t === '-X' || t === '--request') { method = takeNext(i).toUpperCase(); i++; continue; }
    if (t === '-H' || t === '--header') {
      const h = takeNext(i); i++;
      const ci = h.indexOf(':');
      if (ci > 0) setHeader(h.slice(0, ci), h.slice(ci + 1));
      continue;
    }
    if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii'].includes(t)) {
      bodies.push(takeNext(i)); i++; continue;
    }
    if (t === '--data-urlencode') { bodies.push(takeNext(i)); i++; continue; }
    if (t === '--url') { url = takeNext(i); i++; continue; }
    if (t === '-A' || t === '--user-agent') { setHeader('User-Agent', takeNext(i)); i++; continue; }
    if (t === '-e' || t === '--referer') { setHeader('Referer', takeNext(i)); i++; continue; }
    if (t === '-b' || t === '--cookie') {
      // -b 'a=1; b=2' 或多次 -b，setHeader 会自动用 ; 合并
      const v = takeNext(i); i++;
      if (v) setHeader('Cookie', v);
      continue;
    }
    // 可忽略的开关
    if (/^(--compressed|--location|-L|--insecure|-k|--silent|-s|--show-error|-S|--fail|--http1\.1|--http2|--ipv4|--ipv6|--connect-timeout|--max-time|--retry)$/.test(t)) continue;
    if (/^(--connect-timeout|--max-time|--retry|--max-redirs)$/.test(t)) { i++; continue; } // 带值的开关
    if (/^-/.test(t)) continue; // 其他未知开关直接忽略

    if (!url) url = t; // 第一个非开关 token 即为 URL
  }

  if (!url) throw new Error('命令中没有找到 URL');
  if (!/^https?:\/\//i.test(url)) throw new Error('URL 必须以 http(s):// 开头：' + url.slice(0, 60));

  return {
    url,
    method: method || (bodies.length ? 'POST' : 'GET'),
    headers,
    body: bodies.join('&'),
  };
}

// 浏览器全局挂载；Node 测试时通过 eval 加载后直接调用 parseCurl
if (typeof globalThis !== 'undefined') globalThis.parseCurl = parseCurl;
