// 出站地址闸门（防 SSRF）
// ---------------------------------------------------------------------------
// 面板有几处会「按用户给的地址去抓东西」：导入社区站点配置时的 raw 链接、
// 「自动探测签到接口」。如果不管，这些地址就能被用来探内网：
//
//   输入 http://127.0.0.1:8080/ 、http://192.168.1.1/ 、http://169.254.169.254/…
//   → Worker 替你去请求，把内网服务的响应带回来。
//
// 所以：只允许 http/https，且主机名不能是回环 / 内网 / 链路本地 / 云元数据地址。

// 把 IPv4 的「各种老写法」归一成一个 32 位整数。
//
// 【为什么必须做这一步】浏览器（以及 undici / Node 的 URL 解析）都沿用这套老规矩，
// 于是这些写法的**指向都是 127.0.0.1**，但正则上看它们「不像 IP」，于是直接绕过了闸门：
//   127.1        → 127.0.0.1
//   2130706433   → 127.0.0.1（单个 32 位十进制整数）
//   0x7f.0.0.1   → 127.0.0.1（十六进制段）
//   0177.0.0.1   → 127.0.0.1（前导 0 = 八进制）
//   192.168.1    → 192.168.0.1
// 返回 null 表示「不是一个数字形式的 IPv4」（普通域名走这条）。
function parseLegacyIpv4(host) {
  const parts = String(host == null ? '' : host).split('.');
  if (!parts.length || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!p) return null;
    let v = null;
    if (/^0x[0-9a-f]+$/i.test(p)) v = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p, 8);
    else if (/^\d+$/.test(p)) v = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(v) || v < 0) return null;
    nums.push(v);
  }
  // 最后一段把剩下的位数全吃掉：127.1 → 127<<24 | 1
  const last = nums.pop();
  const room = Math.pow(256, 4 - nums.length);
  if (last >= room) return null;
  let val = last;
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] > 255) return null;
    val += nums[i] * Math.pow(256, 3 - i);
  }
  return val >>> 0;
}

// 这个 32 位地址是不是「内网/本机/保留」
function isPrivateV4(v4) {
  const a = v4 >>> 24;
  const b = (v4 >>> 16) & 255;
  const c = (v4 >>> 8) & 255;
  if (a === 0 || a === 10 || a === 127) return true;       // 0/8（含 0.0.0.0）、10/8、回环 127/8
  if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT 100.64/10
  if (a === 169 && b === 254) return true;                 // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16/12
  if (a === 192 && b === 168) return true;                 // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24、192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true;    // 198.18/15（RFC 2544 基准段）
  if (a >= 224) return true;                               // 组播 / 保留
  // 注：203.0.113/24、198.51.100/24 这些「文档用段」**不拦** ——
  // 它们本来就不可路由，拦了只会误伤（有人真的拿它做测试地址），安全上也毫无收益。
  return false;
}

// 主机名是不是「不该让服务器去访问」的地址
export function isPrivateHost(host) {
  const h = String(host == null ? '' : host).trim().toLowerCase()
    .replace(/^\[|\]$/g, '')
    // 【末尾那个点】`localhost.` / `127.0.0.1.` 是合法的「根域写法」（DNS 会当成同一个名字），
    // 浏览器与 undici 都会正常解析 —— 而下面按名字比对的判断会被这一个点全部绕过。
    .replace(/\.+$/, '');
  if (!h) return true;
  if (h === 'localhost' || h === 'localhost.localdomain'
    || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
    || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;

  // IPv6 字面量。只有「含冒号」时才判断 fc/fd —— 否则 fc2.com 这种正常域名会被误拦。
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;            // 回环 / 未指定
    if (h.startsWith('fe80:')) return true;                // 链路本地
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // 唯一本地（ULA）
    if (h.startsWith('ff')) return true;                   // 组播
    // IPv4-mapped（::ffff:127.0.0.1 这类）。
    // 【踩过】URL 解析器会把里面的 IPv4 归一成**十六进制**：
    //   http://[::ffff:127.0.0.1]/ 的 hostname 是 `[::ffff:7f00:1]` ——
    //   以前只按 `::ffff:127.` 这样的形式匹配，于是它整条绕过了闸门。这里两种写法都要认。
    const mapped = /^::ffff:(.+)$/.exec(h);
    if (mapped) {
      const tail = mapped[1];
      if (tail.includes('.')) {
        const v = parseLegacyIpv4(tail);
        if (v !== null && isPrivateV4(v)) return true;
      } else {
        const g = tail.split(':');
        if (g.length === 2 && /^[0-9a-f]{1,4}$/.test(g[0]) && /^[0-9a-f]{1,4}$/.test(g[1])) {
          const v = ((parseInt(g[0], 16) << 16) | parseInt(g[1], 16)) >>> 0;
          if (isPrivateV4(v)) return true;
        }
      }
    }
    return false;
  }

  // 数字形式的 IPv4（含 127.1 / 2130706433 / 0x7f.0.0.1 这些老写法）
  const v4 = parseLegacyIpv4(h);
  if (v4 === null) return false; // 普通域名（由 DNS 解析后再说；这里挡的是「直接给 IP」）
  return isPrivateV4(v4);
}

// 校验一个「要被服务器抓取」的地址。返回 { ok, url?, error? }（不抛异常，方便直接回给前端）
export function checkPublicHttpUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, error: '地址是空的' };
  let u = null;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: '不是合法的网址（要以 http:// 或 https:// 开头）' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '只允许 http/https 地址' };
  if (isPrivateHost(u.hostname)) {
    return { ok: false, error: '拒绝访问内网/本机地址（' + u.hostname + '）：面板不会替你请求这类地址' };
  }
  return { ok: true, url: u };
}

export function isPublicHttpUrl(raw) {
  return checkPublicHttpUrl(raw).ok;
}

// 真实的「替用户去抓一个地址」出口：**每一跳都过闸门**。
//
// 【为什么光校验输入不够】以前各处是「先 checkPublicHttpUrl(用户地址) → 再 fetch(...redirect: follow)」：
// 校验只覆盖了**第一跳**。于是任何公网地址（包括一个临时起的短链服务）只要回一个
//   Location: http://169.254.169.254/latest/meta-data/
// 就能让 Worker 老老实实跟过去，把云元数据/内网服务的响应抓回来 ——
// 闸门形同虚设，而且日志里只看得到那一个「合法」的初始地址。
//
// 这里的做法：自己关掉自动跟随，一跳跃一次、每跳都重新校验地址；
// 万一某个运行时的 redirect:'manual' 给出不透明响应（status 0、读不到 Location），
// 就退回 follow，并事后核对**最终落地的地址**（response.url）——保护弱一点，但绝不静默放行。
//
// 返回 { ok: true, res } 或 { ok: false, error }（不抛异常，方便直接把 error 回给前端）。
export async function safePublicFetch(rawUrl, init = {}, { fetchImpl = fetch, maxRedirects = 5 } = {}) {
  let chk = checkPublicHttpUrl(rawUrl);
  if (!chk.ok) return { ok: false, error: chk.error };

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(chk.url.href, { ...init, redirect: 'manual' });

    // 不透明重定向（status 0）：这个运行时不给看 Location。
    if (res.status === 0) {
      const r2 = await fetchImpl(chk.url.href, { ...init, redirect: 'follow' });
      const landed = checkPublicHttpUrl(r2.url || chk.url.href);
      if (!landed.ok) {
        return { ok: false, error: '地址最终被重定向到了不该访问的地方：' + landed.error };
      }
      return { ok: true, res: r2 };
    }

    // 不是重定向：完成
    if (res.status < 300 || res.status >= 400) return { ok: true, res };

    const loc = res.headers && (res.headers.get('Location') || res.headers.get('location'));
    if (!loc) return { ok: false, error: `HTTP ${res.status} 重定向但没带 Location` };
    let next = null;
    try {
      next = new URL(String(loc), chk.url.href);
    } catch {
      return { ok: false, error: '重定向目标不是合法地址' };
    }
    chk = checkPublicHttpUrl(next.href);
    if (!chk.ok) return { ok: false, error: '重定向后指向了被禁止的地址：' + chk.error };
  }
  return { ok: false, error: `重定向次数过多（超过 ${maxRedirects} 次），已放弃` };
}
