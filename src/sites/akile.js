// AkileCloud（akile.ai）每日签到
// 登录接口：POST https://api.akile.ai/api/v1/user/login
//   请求：{"email":"xxx","password":"xxx"}
//   响应：{"status_code":0,"status_msg":"登录成功","data":{"userId":8318,"token":"..."}}
// 鉴权：请求头 Authorization: <token>（纯 token，无 Bearer 前缀）
// 签到接口：GET https://api.akile.ai/api/v1/user/Checkin
//   成功：{"status_code":0,...}；今日已签到：{"status_code":1,"status_msg":"今日已签到","data":null}
// 奖励：1~10 AK币随机，可在 AK币商店兑换余额/优惠券。
// 2026-09-27 真机实测：登录/签到/重复签到响应均验证通过。

const UA = 'Mozilla/5.0 (Linux; Android 13; KB2000 Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const API = 'https://api.akile.ai/api';

function okCode(code) {
  return code === 0 || code === 200 || code === '0' || code === '200';
}

// 诊断用：对实际发送的凭据做 SHA-256（不可逆），用于核对面板发出的内容与用户手头是否一致
async function credHash(email, password) {
  const data = new TextEncoder().encode(email + '\n' + password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const akile = {
  id: 'akile',
  name: 'AkileCloud',
  desc: 'Akile 云服务器每日签到，奖励 1~10 AK币（可在 AK币商店兑换余额/优惠券）。',
  fields: [
    { key: 'email', label: '登录邮箱', type: 'text', required: true, placeholder: 'akile.ai / akile.io 注册邮箱' },
    { key: 'password', label: '密码', type: 'password', required: true, placeholder: '账号密码' },
  ],
  tips: '账号密码方式自动登录签到，无需手动操作。AK币余额可在控制台「AK币商店」查看。',

  async run(creds) {
    const email = String(creds.email || '').trim();
    const password = String(creds.password || '');
    if (!email || !password) throw new Error('请填写登录邮箱和密码');

    const headers = {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://akile.ai',
      Referer: 'https://akile.ai/',
    };

    // 1. 登录取 token
    const loginRes = await fetch(`${API}/v1/user/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    });
    let login;
    try {
      login = await loginRes.json();
    } catch {
      throw new Error(`登录失败：接口异常（HTTP ${loginRes.status}），稍后重试`);
    }
    if (!okCode(login.status_code)) {
      const h = await credHash(email, password);
      throw new Error('登录失败：' + (login.status_msg || `status_code=${login.status_code}`) + `（诊断码 ${h.slice(0, 16)}，密码长度 ${password.length}）`);
    }
    const token = login.data && login.data.token;
    if (!token) throw new Error('登录失败：未返回 token');

    // 2. 签到
    const chkRes = await fetch(`${API}/v1/user/Checkin`, {
      method: 'GET',
      headers: { ...headers, Authorization: token },
    });
    let chk;
    try {
      chk = await chkRes.json();
    } catch {
      throw new Error(`签到失败：接口异常（HTTP ${chkRes.status}），稍后重试`);
    }

    const msg = String(chk.status_msg || '');
    if (okCode(chk.status_code)) {
      const d = chk.data || {};
      const amount = d.amount ?? d.akCoin ?? d.coin ?? '';
      return { ok: true, message: amount ? `签到成功，获得 ${amount} AK币` : `签到成功：${msg || '领取成功'}` };
    }
    if (msg.includes('已签到')) {
      return { ok: true, message: '今日已签到，无需重复' };
    }
    throw new Error('签到失败：' + (msg || `status_code=${chk.status_code}`));
  },
};
