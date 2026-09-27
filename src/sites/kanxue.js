// 看雪论坛每日签到（bbs.kanxue.com）
// 流程（来源：开源签到脚本 ZaiZaiCat-Checkin/script/kanxue）：
// ①（可选）GET https://bbs.kanxue.com/ 从页面提取 csrf_token
//    （未在面板填写 token 时自动尝试；常见位置：name="csrf_token" 的隐藏 input）
// ② POST https://bbs.kanxue.com/user-signin.htm
//    Body(form): csrf_token=<token>
//    → 响应 JSON（code / message）
// 凭据：浏览器登录看雪论坛后复制的 Cookie。

const UA_DEFAULT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchCsrfToken(cookie, ua) {
  const r = await fetch('https://bbs.kanxue.com/', {
    headers: { 'User-Agent': ua, Accept: 'text/html', Cookie: cookie },
  });
  const t = await r.text();
  const pats = [
    /name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']csrf_token["']/i,
    /["']csrf_token["']\s*[:=]\s*["']([^"']+)["']/i,
    /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i,
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (m) return m[1];
  }
  return '';
}

export const kanxue = {
  id: 'kanxue',
  name: '看雪论坛',
  desc: '看雪论坛每日签到。Cookie 方式，csrf_token 自动获取（失败可手动填）。',
  execution: 'browser', // 默认执行模式：server=云端执行，browser=浏览器扩展执行（用户网络）
  domain: 'bbs.kanxue.com',
  browserScript: `async (params) => {
    const base = 'https://bbs.kanxue.com';
    // ① 获取 csrf_token
    const homeResp = await fetch(base + '/', { credentials: 'include' });
    const homeText = await homeResp.text();
    const m = homeText.match(/csrf_token['"]?\\s*[:=]\\s*['"]([^'"]+)['"]/);
    const token = m ? m[1] : (params.csrf_token || '');
    if (!token) return { ok: false, message: '未能获取 csrf_token，请手动填入' };
    // ② 签到
    const resp = await fetch(base + '/user-signin.htm', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': base + '/',
      },
      body: 'csrf_token=' + encodeURIComponent(token),
    });
    const text = await resp.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    const msg = j ? String(j.message || j.msg || '') : text.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ');
    if (/已签|重复|已经/.test(msg)) return { ok: true, message: '今日已签到，无需重复' };
    if (/成功/.test(msg)) return { ok: true, message: '签到成功' };
    if (/登录|login/i.test(msg)) return { ok: false, message: '登录已失效，请重新获取 Cookie' };
    return { ok: false, message: '签到失败：' + msg.slice(0, 80) };
  }`,
  fields: [
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      required: true,
      placeholder: '浏览器登录 bbs.kanxue.com 后，F12 → 网络 → 任一请求 → 复制请求头 Cookie',
    },
    {
      key: 'csrf_token',
      label: 'csrf_token（可选）',
      type: 'text',
      required: false,
      placeholder: '留空自动从首页获取；自动获取失败时手动填写',
    },
    {
      key: 'user_agent',
      label: 'User-Agent（可选）',
      type: 'text',
      required: false,
      placeholder: '留空用默认；建议与抓 Cookie 时的浏览器一致',
    },
  ],
  tips: '电脑浏览器打开 bbs.kanxue.com 并登录 → F12 → 刷新页面 → 点任意请求 → 复制 Request Headers 里的 Cookie。csrf_token 一般能自动获取，失败时在论坛首页源码搜 csrf_token 手动复制。Cookie 失效时面板会提示，重新复制一次即可。',

  async run(creds) {
    const cookie = String(creds.cookie || '').trim();
    if (!cookie) throw new Error('Cookie 未配置');
    const ua = String(creds.user_agent || '').trim() || UA_DEFAULT;

    let token = String(creds.csrf_token || '').trim();
    if (!token) token = await fetchCsrfToken(cookie, ua);
    if (!token) {
      throw new Error('未能自动获取 csrf_token，请在论坛首页源码中搜索 csrf_token 后手动填入');
    }

    const res = await fetch('https://bbs.kanxue.com/user-signin.htm', {
      method: 'POST',
      headers: {
        'User-Agent': ua,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://bbs.kanxue.com',
        Referer: 'https://bbs.kanxue.com/',
        Cookie: cookie,
      },
      body: 'csrf_token=' + encodeURIComponent(token),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* 非 JSON 则按文本判定 */ }

    const msg = j ? String(j.message || j.msg || '') : text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const code = j ? String(j.code != null ? j.code : (j.status != null ? j.status : '')) : '';

    // 重复签到
    if (/已签|重复|已经/.test(msg)) {
      return { ok: true, message: '今日已签到，无需重复' };
    }
    // 成功：code 0 / 200，或文案含成功
    if (code === '0' || code === '200' || /成功/.test(msg)) {
      return { ok: true, message: '签到成功' + (msg && !/成功/.test(msg) ? '' : (msg ? `：${msg.slice(0, 80)}` : '')) };
    }
    // 登录失效
    if (/登录|login|csrf/i.test(msg) && !/成功/.test(msg)) {
      throw new Error('签到失败（可能 Cookie 或 csrf_token 失效）:' + msg.slice(0, 120));
    }
    throw new Error('签到失败：' + (msg || `HTTP ${res.status}`).slice(0, 160));
  },
};
