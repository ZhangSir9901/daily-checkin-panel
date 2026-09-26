// AkileCloud（akile.ai）每日签到 —— token 方式
// 2026-09-27 实测结论：Akile 登录接口会识别非浏览器客户端，即使账号密码完全正确
// 也返回"密码错误"（用户已用面板内复制出的密码在网页无痕登录成功，面板代码链路审计无问题）。
// 因此账号密码登录改由用户在浏览器手动完成，面板只保存 akile-token（localStorage），
// 每日用 token 调签到接口；token 临近过期（12h，与网页逻辑一致）自动调用 refreshToken
// 续期并回写 D1，续期失败则提示重新获取。
//
// token 获取：浏览器登录 akile.ai 后，F12 → Application → Local Storage → akile-token；
// 或用面板账号弹窗里的「复制取 token 小书签」，在 akile.ai 页面点书签一键复制。

import { encryptJSON } from '../crypto.js';

const UA = 'Mozilla/5.0 (Linux; Android 13; KB2000 Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const API = 'https://api.akile.ai/api';
const REFRESH_AHEAD_SEC = 12 * 3600; // 与网页一致：过期前 12 小时刷新

function okCode(code) {
  return code === 0 || code === 200 || code === '0' || code === '200';
}

// 从 JWT 读 exp（只解析不校验）；非 JWT 返回 0（= 不主动刷新，照常试签到）
export function jwtExp(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return 0;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    const exp = Number(payload.exp);
    return exp > 0 ? exp : 0;
  } catch {
    return 0;
  }
}

async function apiGet(path, token) {
  const res = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: 'application/json', Authorization: token },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    throw new Error(`接口异常（HTTP ${res.status}），稍后重试`);
  }
  return { httpStatus: res.status, body };
}

// 用旧 token 换新 token；失败返回 null
async function refreshToken(token) {
  try {
    const { httpStatus, body } = await apiGet('/v1/user/refreshToken', token);
    if (httpStatus === 401 || !okCode(body.status_code)) return null;
    const nt = body && body.data && body.data.token;
    return nt ? String(nt) : null;
  } catch {
    return null;
  }
}

// 续期成功后回写 D1，下次直接用新 token（失败不影响本次签到）
async function saveToken(ctx, token) {
  try {
    const { env, db, account } = ctx || {};
    if (!env || !db || !account) return;
    const enc = await encryptJSON(env, db, { token });
    await db.prepare('UPDATE accounts SET creds=?, updated_at=? WHERE id=?')
      .bind(enc, Date.now(), account.id).run();
  } catch {
    /* 忽略回写失败 */
  }
}

function authFailed(httpStatus, body) {
  if (httpStatus === 401) return true;
  const msg = String((body && body.status_msg) || '');
  return /过期|无效|未登录|unauthorized|token/i.test(msg);
}

export const akile = {
  id: 'akile',
  name: 'AkileCloud',
  desc: 'Akile 云服务器每日签到，奖励 1~10 AK币。token 方式签到：浏览器登录 akile.ai 后复制 akile-token，面板自动续期。',
  fields: [
    {
      key: 'token',
      label: 'akile-token',
      type: 'textarea',
      required: true,
      placeholder: '浏览器登录 akile.ai 后，从 localStorage 复制 akile-token 粘贴到这里',
    },
  ],
  tips: 'Akile 登录接口会拦截程序化登录，面板改用 token 签到：在浏览器登录 akile.ai → 点下方「复制取 token 小书签」→ 在 akile.ai 页面点该书签复制 token → 粘贴保存。token 临近过期面板会自动续期。',

  async run(creds, ctx = {}) {
    let token = String(creds.token || '').trim();
    if (!token) throw new Error('请先填写 akile-token（在浏览器登录 akile.ai 后复制）');

    // 临近过期先续期（与网页逻辑一致）
    const exp = jwtExp(token);
    if (exp && exp - REFRESH_AHEAD_SEC < Date.now() / 1000) {
      const nt = await refreshToken(token);
      if (nt) {
        token = nt;
        await saveToken(ctx, token);
      }
    }

    let chk = await apiGet('/v1/user/Checkin', token);
    // token 失效：续期一次再试
    if (authFailed(chk.httpStatus, chk.body)) {
      const nt = await refreshToken(token);
      if (!nt) throw new Error('登录已过期，请重新从浏览器复制 akile-token');
      token = nt;
      await saveToken(ctx, token);
      chk = await apiGet('/v1/user/Checkin', token);
    }

    const msg = String((chk.body && chk.body.status_msg) || '');
    if (okCode(chk.body.status_code)) {
      const d = chk.body.data || {};
      const amount = d.amount ?? d.akCoin ?? d.coin ?? '';
      return { ok: true, message: amount ? `签到成功，获得 ${amount} AK币` : `签到成功：${msg || '领取成功'}` };
    }
    if (msg.includes('已签到')) return { ok: true, message: '今日已签到，无需重复' };
    throw new Error('签到失败：' + (msg || `status_code=${chk.body.status_code}`));
  },
};
