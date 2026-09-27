// NodeSeek 论坛每日签到
// 签到接口：POST https://www.nodeseek.com/api/attendance?random=true|false
// 凭据：浏览器手动登录后的 Cookie。
// 注意：登录页带 Cloudflare Turnstile 人机验证，账号密码无法自动登录，
// 只能手动在浏览器登录一次，把 Cookie 复制到面板里。
// 请求使用 src/lib/web.js 的浏览器模拟（UA/Referer/Origin 等）。

import { MOBILE_UA, browserHeaders } from '../lib/web.js';

const UA = MOBILE_UA;

export const nodeseek = {
  id: 'nodeseek',
  name: 'NodeSeek',
  desc: '论坛每日签到领鸡腿。登录有人机验证，只能用 Cookie 方式（手动登录后复制）。',
  execution: 'browser', // 默认执行模式：server=云端执行，browser=浏览器扩展执行（用户网络）
  domain: 'www.nodeseek.com',
  // 浏览器端签到脚本：params.random 为 true=试试手气，false=固定5个
  browserScript: `async (params) => {
    const random = params.random !== false;
    const resp = await fetch('https://www.nodeseek.com/api/attendance?random=' + random, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: '{}',
    });
    const text = await resp.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (!j) {
      if (/challenge-platform|just a moment/i.test(text)) return { ok: false, message: '网站人机验证拦截，稍后重试' };
      return { ok: false, message: '网站没认出登录信息，请重新获取 Cookie' };
    }
    const msg = String(j.message || '');
    const okFlag = j.success === true || (j.data && j.data.success === true);
    if (okFlag || msg.includes('鸡腿')) return { ok: true, message: '签到成功：' + (msg.slice(0, 60) || '领取成功') };
    if (/已签到|已经签到|已完成签到/.test(msg)) return { ok: true, message: '今日已签到，不能重复签到' };
    if (j.status === 404 || msg.includes('USER NOT FOUND')) return { ok: false, message: '登录已失效，请重新获取 Cookie' };
    return { ok: false, message: msg ? '签到失败：' + msg.slice(0, 60) : '签到失败，稍后重试' };
  }`,
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
      ...browserHeaders('https://www.nodeseek.com/board', {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      }),
      'User-Agent': UA,
      Cookie: String(creds.cookie || '').trim(),
    };

    const apiUrl = `https://www.nodeseek.com/api/attendance?random=${random}`;
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: '{}',
    });

    const text = await res.text();
    const finalUrl = res.url || apiUrl;
    // 接口被 302 跳到首页/登录页：网站没认出登录信息（Cookie 无效或缺会话）
    const bounced = !finalUrl.includes('/api/attendance');

    let j = null;
    try {
      j = JSON.parse(text);
    } catch { /* 非 JSON，下面按页面类型判断 */ }

    const fail = (shortMsg, detail) => {
      const err = new Error(shortMsg);
      err.detail = detail;
      throw err;
    };

    if (!j) {
      const snippet = text.replace(/\s+/g, ' ').slice(0, 120);
      const detail = `网站返回：最终地址 ${finalUrl}，非 JSON。页面片段：${snippet}`;
      if (/challenge-platform|cf-chl|just a moment|__cf_chl/i.test(text)) {
        fail('网站人机验证拦截，稍后重试', detail);
      }
      // 被跳到「IPv6 未启用」提示页（warning.nodeseek.com）：云端出口没有 IPv6，本机网络才有
      if (/warning\.nodeseek\.com|ipv6-is-disabled/i.test(finalUrl + ' ' + text)) {
        fail('NodeSeek 要求 IPv6：本机网络才有 IPv6，请把此账号切到「本地网络」执行（需浏览器扩展在线）', detail);
      }
      if (bounced || /signIn\.html|立即登录/.test(text)) {
        fail('网站没认出登录信息，请重新获取 Cookie', detail);
      }
      fail('网站返回异常，稍后重试', detail);
    }

    const msg = String(j.message || '');
    const okFlag = j.success === true || (j.data && j.data.success === true);
    // 网站原始回馈：存入日志 detail，面板日志页"网站回馈"展示
    const detail = `网站返回：${text.slice(0, 300)}`;

    // 成功
    if (okFlag || msg.includes('鸡腿')) {
      return { ok: true, message: `签到成功：${msg.slice(0, 60) || '领取成功'}`, detail };
    }
    // 已签到：一天只能签一次，属正常情况
    if (msg.includes('已签到') || msg.includes('已经签到') || msg.includes('已完成签到')) {
      return { ok: true, message: '今日已签到，不能重复签到', detail };
    }
    // 会话无效：HTTP 500 + {"message":"USER NOT FOUND","status":404}
    if (j.status === 404 || msg.includes('USER NOT FOUND')) {
      fail('登录已失效，请重新获取 Cookie', detail);
    }
    fail(msg ? `签到失败：${msg.slice(0, 60)}` : '签到失败，稍后重试', detail);
  },
};
