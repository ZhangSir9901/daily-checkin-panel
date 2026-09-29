// 面板「出口」连通性检查：从 Cloudflare 的机器上打几个常见站点，看能不能通。
//
// 【它到底在测什么、不在测什么】（这点必须在面板上说清楚，不然会误导人）
//   ✅ 测的是**面板（Worker）这一侧**能不能连上这些站点 —— 也就是「CF 直连」这条路线通不通。
//      这正是签到会不会因为「机房 IP 被拦 / 网络不通」而失败的关键信息。
//   ❌ 不是测你自己电脑/手机的网速或墙。你的浏览器打不开 Google 不代表面板连不上，
//      反过来也一样（面板连得上 Telegram，不代表你本机连得上）。
//
// 判定口径：**只要有 HTTP 响应（哪怕是 403/404）就算「通」** —— 403 说明网络到得了、
// 只是人家不让你看这个路径；真正「不通」是超时 / DNS 失败 / 连接被拒。

// 常见站点，顺序按「国内 → 国外」排，一眼能看出是不是整体不通。
// 用 robots.txt 这类稳定的小文件：不参与业务、体积小、不会被当成爬虫页面跳来跳去。
export const NET_TARGETS = [
  { id: 'aliyun', name: '阿里云', url: 'https://www.aliyun.com/robots.txt' },
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/robots.txt' },
  { id: 'google', name: '谷歌', url: 'https://www.google.com/robots.txt' },
  { id: 'facebook', name: 'Facebook', url: 'https://www.facebook.com/robots.txt' },
  { id: 'github', name: 'GitHub', url: 'https://github.com/robots.txt' },
  { id: 'telegram', name: 'Telegram', url: 'https://api.telegram.org/' },
];

const DEFAULT_TIMEOUT_MS = 6000;

// 把异常压成一句人话（面板上只有一行小字的空间）
export function shortNetError(e) {
  const m = String((e && e.message) || e || '');
  if (/abort|timeout|timed out|超时/i.test(m)) return '超时';
  if (/ENOTFOUND|EAI_AGAIN|dns|getaddrinfo/i.test(m)) return '域名解析失败';
  if (/ECONNREFUSED|connection refused/i.test(m)) return '连接被拒绝';
  // 「fetch failed」是 Worker/undici 最常见的失败文案（底层原因被吞掉了），单独认一下
  if (/ECONNRESET|socket hang up|network|fetch failed|failed to fetch/i.test(m)) return '连不上';
  if (/certificate|SSL|TLS/i.test(m)) return '证书问题';
  return m.replace(/\s+/g, ' ').slice(0, 40) || '未知错误';
}

// 探测一个地址：{ ok, status, ms, error? }
export async function probeTarget(target, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(target.url, {
      method: 'GET',
      // 不跟重定向：这些地址本来就该直接给响应，跟着跳反而慢（且我们只关心「通不通」）
      redirect: 'manual',
      headers: { 'User-Agent': 'daily-checkin-panel/net-check' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const ms = Date.now() - t0;
    // 读完就丢：不把正文带回来（面板只需要「通不通」），也顺手把连接放掉
    try { await res.body?.cancel(); } catch { /* 忽略 */ }
    return { ok: true, status: Number(res.status) || 0, ms };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: shortNetError(e) };
  }
}

// 并发探测全部目标。返回 { checked_at, targets: [{ id, name, ok, status, ms, error? }] }
export async function checkNet({ fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, targets = NET_TARGETS } = {}) {
  const results = await Promise.all(
    targets.map(async (t) => ({ id: t.id, name: t.name, ...(await probeTarget(t, { fetchImpl, timeoutMs })) }))
  );
  return { checked_at: Date.now(), targets: results };
}
