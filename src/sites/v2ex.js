// V2EX 每日登录奖励
// 流程（来源：开源签到脚本 BeRich/V2EX）：
// ① GET https://www.v2ex.com/mission/daily（带 Cookie）
//    → 含「每日登录奖励已领取」= 今日已签到
// ② 从页面正则提取 /mission/daily/redeem?once=(\d+)（once 每次动态变化）
// ③ GET redeem 链接完成领取
// 凭据：浏览器登录 v2ex.com 后复制的 Cookie（A2 / PB3_SESSION 等）。

const UA_DEFAULT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export const v2ex = {
  id: 'v2ex',
  name: 'V2EX',
  desc: 'V2EX 每日登录奖励领取。无验证码，Cookie 方式。',
  fields: [
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      required: true,
      placeholder: '浏览器登录 www.v2ex.com 后，F12 → 网络 → 任一请求 → 复制请求头 Cookie',
    },
    {
      key: 'user_agent',
      label: 'User-Agent（可选）',
      type: 'text',
      required: false,
      placeholder: '留空用默认；建议与抓 Cookie 时的浏览器一致',
    },
  ],
  tips: '电脑浏览器打开 www.v2ex.com 并登录 → F12 → 刷新页面 → 点任意请求 → 复制 Request Headers 里的 Cookie。Cookie 失效时面板会提示「请重新登录」，重新复制一次即可。',

  async run(creds) {
    const cookie = String(creds.cookie || '').trim();
    if (!cookie) throw new Error('Cookie 未配置');
    const ua = String(creds.user_agent || '').trim() || UA_DEFAULT;
    const headers = {
      'User-Agent': ua,
      Accept: 'text/html',
      Referer: 'https://www.v2ex.com/mission/daily',
      Cookie: cookie,
    };

    const r1 = await fetch('https://www.v2ex.com/mission/daily', { headers });
    const t1 = await r1.text();

    // 已领取
    if (t1.includes('每日登录奖励已领取')) {
      return { ok: true, message: '今日已签到，无需重复' };
    }
    // 登录失效：被踢到登录页或提示重新登录
    if (r1.status === 403 || t1.includes('/signin') && t1.includes('请重新登录') || t1.includes('登录</a>') && !t1.includes('mission/daily/redeem')) {
      throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    }

    // 提取动态 once 参数
    const m = t1.match(/\/mission\/daily\/redeem\?once=(\d+)/);
    if (!m) {
      throw new Error('未找到领取链接（once 参数），页面可能改版或 Cookie 失效');
    }

    const r2 = await fetch(`https://www.v2ex.com/mission/daily/redeem?once=${m[1]}`, { headers });
    const t2 = await r2.text();
    if (t2.includes('每日登录奖励已领取') || t2.includes('已成功领取每日登录奖励')) {
      return { ok: true, message: '签到成功：每日登录奖励已领取' };
    }
    if (t2.includes('请重新登录') || r2.status === 403) {
      throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    }
    throw new Error('签到失败：' + t2.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160));
  },
};
