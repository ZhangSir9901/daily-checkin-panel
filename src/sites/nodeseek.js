// NodeSeek 论坛每日签到
// 签到接口：POST https://www.nodeseek.com/api/attendance?random=true|false
// 凭据：浏览器手动登录后的 Cookie。
// 注意：登录页带 Cloudflare Turnstile 人机验证，账号密码无法自动登录，
// 只能手动在浏览器登录一次，把 Cookie 复制到面板里。

const UA = 'Mozilla/5.0 (Linux; Android 13; KB2000 Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

export const nodeseek = {
  id: 'nodeseek',
  name: 'NodeSeek',
  desc: '论坛每日签到领鸡腿。登录有人机验证，只能用 Cookie 方式（手动登录后复制）。',
  fields: [
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      required: true,
      placeholder: '浏览器登录 www.nodeseek.com 后，F12 → 网络 → 任一请求 → 复制请求头 Cookie',
    },
    {
      key: 'random',
      label: '签到模式',
      type: 'select',
      options: ['试试手气（随机）', '固定 5 鸡腿'],
    },
  ],
  tips: '电脑浏览器打开 www.nodeseek.com 并登录 → F12 打开开发者工具 → 刷新页面 → 点任意请求 → 复制 Request Headers 里的 Cookie 粘贴到这里。手机可用抓包工具（如 ProxyPin）抓取。Cookie 失效时面板会报错，重新复制一次即可。',

  // 站点独立开关：账号列表页直接切换，无需进编辑
  toggles: [
    { key: 'random', label: '签到模式', onLabel: '试试手气', offLabel: '固定5鸡腿', default: true },
  ],

  async run(creds, ctx) {
    // 开关存于 accounts.meta.toggles；兼容老数据的 creds.random 字段
    const t = ctx && ctx.meta && ctx.meta.toggles ? ctx.meta.toggles.random : undefined;
    const random = t == null ? creds.random !== '固定 5 鸡腿' : !!t;
    const headers = {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://www.nodeseek.com',
      Referer: 'https://www.nodeseek.com/board',
      Cookie: String(creds.cookie || '').trim(),
    };

    const res = await fetch(`https://www.nodeseek.com/api/attendance?random=${random}`, {
      method: 'POST',
      headers,
      body: '{}',
    });

    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      // 非 JSON：大概率是 Cloudflare 验证页/拦截页。带上页面片段便于从日志里直接判断。
      const snippet = text.replace(/\s+/g, ' ').slice(0, 150);
      if (/challenge-platform|cf-chl|just a moment|__cf_chl/i.test(text)) {
        throw new Error(`签到失败：被 NodeSeek 的 Cloudflare 人机验证拦截（HTTP ${res.status}），机房 IP 被要求验证，稍后重试`);
      }
      throw new Error(`签到失败：站点返回非 JSON 数据（HTTP ${res.status}），稍后重试。页面片段：${snippet}`);
    }

    const msg = String(j.message || '');
    const okFlag = j.success === true || (j.data && j.data.success === true);

    // 成功：返回 message 带"鸡腿"或 success 为 true
    if (okFlag || msg.includes('鸡腿')) {
      return { ok: true, message: `签到成功：${msg || '领取成功'}` };
    }
    // 已签到
    if (msg.includes('已完成签到') || msg.includes('已经签到')) {
      return { ok: true, message: '今日已签到，无需重复' };
    }
    // 会话无效：HTTP 500 + {"message":"USER NOT FOUND","status":404}
    if (j.status === 404 || msg.includes('USER NOT FOUND')) {
      throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    }
    throw new Error('签到失败：' + (msg || `HTTP ${res.status}`));
  },
};
