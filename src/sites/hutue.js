// 糊涂鳄资源站每日签到（hutue.cn / dj.hutue.cn，WordPress + RiPro 主题）
// 流程（来源：2026-09-27 抓包 dj.hutue.cn）：
// ① POST https://dj.hutue.cn/wp-admin/admin-ajax.php（带登录 Cookie）
//    参数：action=user_qiandao（首页按钮）或 action=xb_user_qiandao（用户中心）
//    → 返回 JSON：{status: 1, msg: "签到成功..."} = 成功；status 非 1 = 失败/已签到（看 msg）
// ② 若返回登录相关提示 = Cookie 失效
//
// 注意：
// 1. WordPress 登录 Cookie 为 wordpress_logged_in_xxx 等 HttpOnly，需用扩展抓取。
// 2. 有 hutue.cn 和 dj.hutue.cn 两个站，账号里填 site_url 区分。
// 3. 默认浏览器扩展执行（用户本地网络）。

function normBase(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

export const hutue = {
  id: 'hutue',
  name: '糊涂鳄',
  desc: '糊涂鳄资源站每日签到（WordPress）。支持 hutue.cn 与 dj.hutue.cn，Cookie 方式。',
  execution: 'server', // 默认云端执行（用面板保存的 Cookie）；扩展在线时自动走中继用用户网络
  domain: 'dj.hutue.cn', // 默认域名；实际按账号的 site_url 动态决定
  // 浏览器端签到脚本：在用户浏览器中运行，自动携带登录 Cookie
  // 入参 params：{ base_url }；返回 { ok, message }
  browserScript: `async (params) => {
    const base = (params.base_url || '').replace(/\\/+$/, '');
    if (!base) return { ok: false, message: '未配置站点地址' };
    const ajaxUrl = base + '/wp-admin/admin-ajax.php';
    // 先试首页的 user_qiandao，不行再试用户中心的 xb_user_qiandao
    const actions = ['user_qiandao', 'xb_user_qiandao'];
    let lastMsg = '';
    for (const action of actions) {
      let resp;
      try {
        const body = new URLSearchParams({ action });
        resp = await fetch(ajaxUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: body.toString(),
        });
      } catch (e) {
        lastMsg = '网络请求失败：' + (e.message || 'fetch 异常');
        continue;
      }
      let data;
      // 先读 text 再 JSON.parse：resp.json() 失败后 body 已被消费，不能再调 resp.text()
      let rawText = '';
      try {
        rawText = await resp.text();
      } catch {
        lastMsg = '读取网站响应失败（HTTP ' + resp.status + '）';
        continue;
      }
      try {
        data = JSON.parse(rawText);
      } catch {
        // 非 JSON 可能是登录页或 WAF
        if (/wp-login|请先登录|登录/.test(rawText) && rawText.length < 5000) {
          return { ok: false, message: '登录已失效，请重新获取 Cookie' };
        }
        lastMsg = '网站返回非 JSON（HTTP ' + resp.status + '）：' + rawText.slice(0, 120);
        continue;
      }
      const msg = String(data.msg || '');
      if (data.status == 1) return { ok: true, message: '签到成功：' + msg };
      // status 非 1：看 msg 判断是已签到还是失败
      if (/已签到|已经签|重复|明天/.test(msg)) return { ok: true, message: '今日已签到，无需重复' };
      if (/登录|login/i.test(msg)) return { ok: false, message: '登录已失效，请重新获取 Cookie' };
      lastMsg = msg || '签到失败（status=' + data.status + '）';
    }
    return { ok: false, message: lastMsg || '签到失败' };
  }`,
  fields: [
    {
      key: 'site_url',
      label: '站点地址',
      type: 'text',
      required: true,
      placeholder: 'https://dj.hutue.cn 或 https://hutue.cn',
    },
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      required: true,
      placeholder: '浏览器登录站点后，用扩展「一键复制全部信息」获取',
    },
    {
      key: 'user_agent',
      label: 'User-Agent（可选）',
      type: 'text',
      required: false,
      placeholder: '留空用默认；扩展会自动抓取',
    },
  ],
  tips: '先在浏览器中登录 hutue 站点 → 用扩展「一键发送到签到面板」→ 面板会自动识别并弹出填写框 → 确认保存。hutue.cn 和 dj.hutue.cn 是两个独立站点，需要分别添加账号。',

  // 服务端执行（备用）：直接 POST 到 admin-ajax.php
  async run(creds) {
    const base = normBase(creds.site_url);
    if (!base) throw new Error('站点地址未配置');
    const cookie = String(creds.cookie || '').trim();
    if (!cookie) throw new Error('Cookie 未配置');
    const ua = String(creds.user_agent || '').trim() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

    const actions = ['user_qiandao', 'xb_user_qiandao'];
    let lastErr = null;
    for (const action of actions) {
      try {
        const res = await fetch(base + '/wp-admin/admin-ajax.php', {
          method: 'POST',
          headers: {
            'User-Agent': ua,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: base + '/',
            Cookie: cookie,
          },
          body: new URLSearchParams({ action }).toString(),
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          if (/wp-login/i.test(text)) throw new Error('登录已失效，请重新获取 Cookie');
          throw new Error('网站返回非 JSON（HTTP ' + res.status + '）');
        }
        const msg = String(data.msg || '');
        if (data.status == 1) return { ok: true, message: '签到成功：' + msg };
        if (/已签到|已经签|重复|明天/.test(msg)) return { ok: true, message: '今日已签到，无需重复' };
        if (/登录|login/i.test(msg)) throw new Error('登录已失效，请重新获取 Cookie');
        lastErr = new Error(msg || '签到失败（status=' + data.status + '）');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('签到失败');
  },
};
