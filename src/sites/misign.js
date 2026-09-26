// Discuz k_misign 签到插件 · 通用模块
// 适用于安装了 k_misign 每日签到插件的 Discuz 论坛（如阅次元 abooky.com）：
// ① GET {base}/plugin.php?id=k_misign:sign
//    → 含「您的签到排名」= 今日已签到
//    → 否则从页面提取 <a id="JD_sign" href="..."> 的签到链接
// ② GET 签到链接（若指向登录页 = Cookie 失效）
// ③ 再 GET 签到页确认含「您的签到排名」= 成功；奖励从 <input id="lxreward" value="..."> 提取
// 凭据：浏览器登录目标论坛后复制的 Cookie。

const UA_DEFAULT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function normBase(s) {
  let b = String(s || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('论坛地址未配置');
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  return b;
}

function unesc(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export const misign = {
  id: 'misign',
  name: 'Discuz 每日签到',
  desc: '通用模块：适用于安装了 k_misign 签到插件的 Discuz 论坛（如阅次元）。填论坛首页地址 + Cookie。',
  fields: [
    {
      key: 'base_url',
      label: '论坛地址',
      type: 'text',
      required: true,
      placeholder: '如 https://www.abooky.com',
    },
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      required: true,
      placeholder: '浏览器登录该论坛后，F12 → 网络 → 任一请求 → 复制请求头 Cookie',
    },
    {
      key: 'user_agent',
      label: 'User-Agent（可选）',
      type: 'text',
      required: false,
      placeholder: '留空用默认；建议与抓 Cookie 时的浏览器一致',
    },
  ],
  tips: '先确认目标论坛用的是 k_misign 签到插件（签到页 URL 形如 plugin.php?id=k_misign:sign）。浏览器登录论坛 → F12 复制 Cookie。Cookie 失效时面板会提示，重新复制一次即可。',

  async run(creds) {
    const base = normBase(creds.base_url);
    const cookie = String(creds.cookie || '').trim();
    if (!cookie) throw new Error('Cookie 未配置');
    const ua = String(creds.user_agent || '').trim() || UA_DEFAULT;
    const headers = { 'User-Agent': ua, Accept: 'text/html', Cookie: cookie, Referer: base + '/' };
    const signUrl = base + '/plugin.php?id=k_misign:sign';

    const get = async (url) => {
      const r = await fetch(url, { headers });
      return { status: r.status, text: await r.text() };
    };

    // ① 打开签到页
    let p = await get(signUrl);
    if (p.text.includes('您的签到排名')) {
      return { ok: true, message: '今日已签到，无需重复' };
    }
    if (p.text.includes('mod=logging') && p.text.includes('action=login')) {
      throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    }

    // 提取签到链接
    const m = p.text.match(/<a[^>]*id=["']JD_sign["'][^>]*href=["']([^"']+)["']/i)
      || p.text.match(/href=["']([^"']*k_misign[^"']*)["']/i);
    if (!m) throw new Error('未找到签到按钮，该论坛可能不是 k_misign 插件或页面已改版');
    const href = unesc(m[1]);
    if (/mod=logging/i.test(href)) throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    const signLink = /^https?:\/\//i.test(href) ? href : base + '/' + href.replace(/^\/+/, '');

    // ② 执行签到
    await get(signLink);

    // ③ 确认结果
    p = await get(signUrl);
    if (p.text.includes('您的签到排名')) {
      const rw = p.text.match(/id=["']lxreward["'][^>]*value=["']([^"']*)["']/i);
      const reward = rw ? unesc(rw[1]).trim() : '';
      return { ok: true, message: '签到成功' + (reward ? `：${reward}` : '') };
    }
    throw new Error('签到失败：确认页未显示签到排名，' + p.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160));
  },
};
