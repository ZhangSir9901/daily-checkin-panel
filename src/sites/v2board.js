// V2Board 机场面板每日签到（通用模块）
// 逻辑来源：用户自有 Worker「69qiandao」（单机场签到脚本），已验证可用。
// 流程：POST {domain}/auth/login（email+password）→ 取登录 Cookie →
//       POST {domain}/user/checkin → ret===1 为成功。
// 凭据经 AES-GCM 加密存 D1（与面板其他站点一致），不再放环境变量。

const UA = 'Mozilla/5.0 (Linux; Android 13; KB2000 Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

function normDomain(d) {
  let s = String(d || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

// 从登录响应收集 Cookie（Workers 下用 getSetCookie；兜底单头）
function cookiesFrom(res) {
  const out = [];
  try {
    if (typeof res.headers.getSetCookie === 'function') {
      for (const c of res.headers.getSetCookie()) {
        const i = c.indexOf(';');
        out.push(i > 0 ? c.slice(0, i) : c);
      }
      return out.join('; ');
    }
  } catch { /* 忽略，走兜底 */ }
  const c = res.headers.get('set-cookie');
  if (c) out.push(c.split(';')[0]);
  return out.join('; ');
}

async function postJSON(url, body, cookie) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  let j = null;
  try {
    j = await res.json();
  } catch {
    throw new Error(`接口异常（HTTP ${res.status}），稍后重试`);
  }
  return { res, j };
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
      placeholder: '如：example.com（不用加 https://）',
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
  tips: '适用于 V2Board 面板的机场：填入机场域名、注册邮箱和密码，面板会自动登录并签到领流量。域名填主域名即可，如 example.com。',

  async run(creds, ctx = {}) {
    const domain = normDomain(creds.domain);
    const email = String(creds.email || '').trim();
    const password = String(creds.password || ''); // 密码原样，不 trim
    if (!domain) throw new Error('请填写机场域名');
    if (!email || !password) throw new Error('请填写账号邮箱和密码');

    // 1. 登录
    const { res: loginRes, j: login } = await postJSON(`${domain}/auth/login`, { email, password });
    if (!login || login.ret !== 1) {
      const msg = String((login && login.msg) || '未知错误');
      throw new Error('登录失败：' + msg + '，请检查域名、邮箱和密码');
    }
    const cookie = cookiesFrom(loginRes);

    // 2. 签到
    const { j: chk } = await postJSON(`${domain}/user/checkin`, {}, cookie);
    const msg = String((chk && chk.msg) || '');
    if (chk && chk.ret === 1) {
      return { ok: true, message: `签到成功：${msg || '领取成功'}` };
    }
    if (/已签到|已经签到|签到过/.test(msg)) return { ok: true, message: '今日已签到，无需重复' };
    throw new Error('签到失败：' + (msg || `ret=${chk && chk.ret}`));
  },
};
