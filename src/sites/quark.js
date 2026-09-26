// 夸克网盘每日签到
// 接口来源：drive-m.quark.cn /1/clouddrive/capacity/growth/{info,sign}
// 凭据获取：手机抓包夸克网盘签到页，找到 growth/info 请求，复制 kps / sign / vcode 参数。

const UA = 'Mozilla/5.0 (Linux; Android 13; KB2000 Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

function fmtBytes(b) {
  if (b == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(b);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

export const quark = {
  id: 'quark',
  name: '夸克网盘',
  desc: '每日签到领取空间奖励，需抓包获取 kps / sign / vcode（约 2 个月有效期）。',
  fields: [
    { key: 'kps', label: 'kps', type: 'text', required: true, placeholder: '抓包 growth/info 请求中的 kps 参数' },
    { key: 'sign', label: 'sign', type: 'text', required: true, placeholder: '抓包 growth/info 请求中的 sign 参数' },
    { key: 'vcode', label: 'vcode', type: 'text', required: true, placeholder: '抓包 growth/info 请求中的 vcode 参数' },
  ],
  tips: '打开抓包工具（如 ProxyPin）→ 访问夸克网盘「签到领空间」页面 → 找到 https://drive-m.quark.cn/1/clouddrive/capacity/growth/info 的请求 → 复制 kps、sign、vcode 三个参数填入。',

  async run(creds) {
    const qs = new URLSearchParams({
      pr: 'ucpro',
      fr: 'android',
      kps: creds.kps,
      sign: creds.sign,
      vcode: creds.vcode,
    });
    const headers = { 'User-Agent': UA, 'Content-Type': 'application/json' };

    // 1. 查询今日签到状态
    const infoRes = await fetch(`https://drive-m.quark.cn/1/clouddrive/capacity/growth/info?${qs}`, { headers });
    const info = await infoRes.json().catch(() => ({}));
    if (!info.data) {
      throw new Error('获取签到信息失败：' + (info.message || info.msg || `HTTP ${infoRes.status}`));
    }
    const capSign = info.data.cap_sign || {};

    // 2. 已签到则直接返回
    if (capSign.sign_daily) {
      return {
        ok: true,
        message: `今日已签到（+${fmtBytes(capSign.sign_daily_reward)}，连签 ${capSign.sign_progress}/${capSign.sign_target}）`,
      };
    }

    // 3. 执行签到
    const signRes = await fetch(`https://drive-m.quark.cn/1/clouddrive/capacity/growth/sign?${qs}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sign_cyclic: true }),
    });
    const sj = await signRes.json().catch(() => ({}));
    if (sj.data) {
      return { ok: true, message: `签到成功 +${fmtBytes(sj.data.sign_daily_reward)}` };
    }
    throw new Error('签到失败：' + (sj.message || sj.msg || `HTTP ${signRes.status}`) + '（凭据可能已过期，请重新抓包）');
  },
};
