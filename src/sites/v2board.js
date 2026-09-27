// V2Board 机场面板每日签到（通用模块）
// 逻辑来源：用户自有 Worker「69qiandao」（单机场签到脚本），已验证可用。
// 流程：POST {domain}/auth/login（表单提交）→ 取登录 Cookie →
//       POST {domain}/user/checkin → ret===1 为成功。
// 凭据经 AES-GCM 加密存 D1（与面板其他站点一致），不再放环境变量。
//
// 2026-09-27 实测修正（69机场）：
// - 登录必须用 application/x-www-form-urlencoded，不能用 JSON。
// - 部分魔改站（如 69）的密码字段叫 passwd 而不是 password；为兼容标准站与魔改站，
//   同时发送 password 和 passwd 两个字段（值相同），服务端各取所需，多余字段会被忽略。
// - 另带 remember_me、code 字段以兼容魔改站的表单结构。
// - 登录请求使用 src/lib/web.js 的浏览器模拟（Referer/Origin/UA 等）。

import { MOBILE_UA, cookiesFrom, postForm, postJSON } from '../lib/web.js';

const UA = MOBILE_UA;

function normDomain(d) {
  let s = String(d || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

export const v2board = {
  id: 'v2board',
  name: 'V2Board 机场',
  desc: 'V2Board 面板机场每日签到领流量。填机场域名 + 注册邮箱 + 密码，面板自动登录签到。',
  fields: [
    {
      key: 'domain',
      label: '机场域名',
      type: 'text',
      required: true,
      placeholder: '如：example.com，或带路径 example.com/uuid（不用加 https://）',
    },
    {
      key: 'email',
      label: '账号邮箱',
      type: 'text',
      required: true,
      placeholder: '机场注册邮箱',
    },
    {
      key: 'password',
      label: '密码',
      type: 'password',
      required: true,
      placeholder: '机场账号密码',
    },
  ],
  tips: '适用于 V2Board 面板的机场：填入机场域名、注册邮箱和密码，面板会自动登录并签到领流量。域名填主域名即可，如 example.com；如果机场登录页带路径（如 …/uuid/auth/login），域名就填带路径的形式，如 example.com/uuid。',

  async run(creds, ctx = {}) {
    const domain = normDomain(creds.domain);
    const email = String(creds.email || '').trim();
    const password = String(creds.password || ''); // 密码原样，不 trim
    if (!domain) throw new Error('请填写机场域名');
    if (!email || !password) throw new Error('请填写账号邮箱和密码');

    // 1. 登录（表单提交；同时带 password 与 passwd 以兼容标准站和魔改站）
    //    pageUrl 传入登录页地址，自动带上 Referer/Origin，模拟浏览器行为
    const loginUrl = `${domain}/auth/login`;
    const { res: loginRes, j: login } = await postForm(
      loginUrl,
      {
        email,
        password, // 标准 V2Board
        passwd: password, // 魔改站（如 69）
        remember_me: '1',
        code: '',
      },
      { pageUrl: loginUrl, ua: UA }
    );
    if (!login || login.ret !== 1) {
      const msg = String((login && login.msg) || '未知错误');
      throw new Error('登录失败：' + msg + '，请检查域名、邮箱和密码');
    }
    const cookie = cookiesFrom(loginRes);

    // 2. 签到
    const checkinUrl = `${domain}/user/checkin`;
    const { j: chk } = await postJSON(checkinUrl, {}, { cookie, pageUrl: checkinUrl, ua: UA });
    const msg = String((chk && chk.msg) || '');
    if (chk && chk.ret === 1) {
      return { ok: true, message: `签到成功：${msg || '领取成功'}` };
    }
    if (/已签到|已经签到|签到过/.test(msg)) return { ok: true, message: '今日已签到，无需重复' };
    throw new Error('签到失败：' + (msg || `ret=${chk && chk.ret}`));
  },
};
