// 吾爱破解论坛每日签到（www.52pojie.cn，Discuz 架构）
// 流程（来源：开源签到脚本 xixingchao/qx-scripts 2026-06 版）：
// ① GET https://www.52pojie.cn/portal.php（带完整 Cookie + 与抓包一致的 UA）
//    → 含「今日已签到」等文案 = 今日已签，直接结束
//    → 含 WAF 特征 = 需用户用浏览器重新过安全验证后更新 Cookie
// ② GET https://www.52pojie.cn/home.php?mod=task&do=apply&id=2&referer=%2Fportal.php
//    （Discuz 每日任务领取，无需 formhash；手动跟随最多 3 次 30x 跳转，
//     过程中出现 do=draw 表示进入奖励领取链）
//    → 最终页面含成功文案 = 签到成功
//
// 注意：
// 1. 页面为 GBK 编码，模块同时按 UTF-8 和 GBK 解码后匹配（Worker 与 Node 均支持 TextDecoder('gbk')）。
// 2. 站点有网宿 WAF / 滑块验证，Worker 无法自动绕过：Cookie 必须包含用户
//    用浏览器完成安全验证后的 wzws_cid（及 wzws_sid），且 UA 必须与抓 Cookie 时一致。
// 3. 遇到 WAF 页时模块会明确报错提示重新验证，不会静默失败。

const WAF_MARKS = ['waf_zw_verify', 'WZWS_CONFIRM_PREFIX_LABEL', 'slidercaptcha', '请完成安全验证', '安全检查中', 'Please enable JavaScript'];
// 网宿 WAF 的硬拦截页（实测云端出口 IP 会被这里挡下）：
//   403 Forbidden ... Client IP: 172.70.x.x eventID: ...403-waf02whc reason:UrlACL
const BLOCK_RE = /reason:UrlACL|Client IP:\s*[\d.:a-f]+|eventID:\s*\d+-[\d.]+-\d+-waf|Request blocked|Access Denied|403 Forbidden/i;
// 已签到特征。重点补充「签到完毕」：52pojie 的每日签到任务页在当天领过之后，
// 按钮文字会变成「签到完毕」，再点没有任何反应（不会报错也不会给提示）。
// 旧版没有这个词，于是把「已经签到过」误报成「未识别到成功标识」。
// 注意：只保留任务场景特有的词，去掉「已完成」「恭喜」这类在论坛帖子里也会出现的泛词。
const SIGNED_MARKS = [
  '今日已签到', '今日已签', '已经签到', '已签到', '签到完毕', '签到完成', '已完成签到',
  '您已完成过此任务', '您已经完成此任务', '今日任务已完成',
  '无需重复签到', '无需重复', '请等待下次刷新',
  '下期再来', '明天再来',
  'ÄúÒÑ', 'ÏÂÆÚÔÙÀ´', // GBK 被误作 Latin1 解码时的特征
];
// 成功特征：必须是任务完成场景的强信号。去掉「恭喜」「获得」「吾爱币」这类泛词，
// 它们在论坛帖子/公告里随处可见，会造成误判。
const SUCCESS_MARKS = ['任务已完成', '签到成功', '打卡成功', '签到完毕'];
const PAUSED_MARKS = ['暂停签到', '签到暂停', '暂停每日签到', '签到功能维护'];
const LOGIN_MARKS = ['请先登录', '需要先登录', '请登录后'];

async function fetchDualText(url, init) {
  const res = await fetch(url, init);
  const ab = await res.arrayBuffer();
  const bytes = ab instanceof Uint8Array ? ab : new Uint8Array(ab);
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  let gbk = '';
  try { gbk = new TextDecoder('gbk').decode(bytes); } catch { /* 环境不支持则忽略 */ }
  return { res, utf8, gbk };
}

function has(texts, marks) {
  const all = texts.utf8 + '\n' + texts.gbk;
  return marks.some((m) => all.includes(m));
}

// 去掉脚本/标签，得到可读的页面纯文本（用于「网站反馈」展示网站真实回馈）
// 52pojie 页面是 GBK：同一段字节用 utf8 解码会得到带替换字符(U+FFFD)的乱码。
// 判据：utf8 解码出现替换字符、而 gbk 解码没有 → 按 GBK 取文本，
// 否则保留 utf8（UTF-8 页面不会被误判）。不能用「谁的中文更多」——GBK 错解 UTF-8
// 也会得到一批汉字乱码，反而会选错。
function pickText(texts) {
  const u = (texts && texts.utf8) || '';
  const g = (texts && texts.gbk) || '';
  if (!u) return g;
  if (u.includes('\uFFFD') && !g.includes('\uFFFD')) return g;
  return u;
}

function clean(texts) {
  const t = pickText(texts) || '';
  return t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// 签到后顺带读一次积分页，把「吾爱币 / 威望 / 热心值」带进日志（参考 Discuz 任务签到脚本做法）
// 纯 best-effort：读不到就返回空串，不影响签到结果
async function creditSuffix(headers) {
  try {
    const page = await fetchDualText('https://www.52pojie.cn/home.php?mod=spacecp&ac=credit', { headers });
    assertNoWaf(page, page.res.status);
    const t = clean(page);
    const pick = (label) => {
      const m = t.match(new RegExp(label + '\\s*[:：]?\\s*(\\d+)'));
      return m ? m[1] : '';
    };
    const parts = [];
    const coin = pick('吾爱币');
    const credit = pick('威望');
    const hot = pick('热心值');
    if (coin) parts.push(`吾爱币 ${coin}`);
    if (credit) parts.push(`威望 ${credit}`);
    if (hot) parts.push(`热心值 ${hot}`);
    return parts.length ? '（当前 ' + parts.join('，') + '）' : '';
  } catch {
    return '';
  }
}

// 从页面里挑出与签到相关的一句话，作为真实网站回馈
function pickLine(texts) {
  const text = clean(texts);
  const m = text.match(/[^\s]{0,20}(任务已完成|签到成功|打卡成功|签到完毕|签到完成|今日已签到|已经签到|下期再来|明天再来)[^\s]{0,30}/);
  return (m ? m[0] : text.slice(0, 120)).trim();
}

// status 可选：HTTP 403 直接判定为被拦截，不用靠猜页面文本
function assertNoWaf(texts, status) {
  if (has(texts, WAF_MARKS)) {
    throw new Error('遇到安全验证（WAF）：请用浏览器打开 www.52pojie.cn 完成滑块/安全验证，然后重新复制完整 Cookie（含 wzws_cid）到面板');
  }
  const all = ((texts && texts.utf8) || '') + '\n' + ((texts && texts.gbk) || '');
  if (Number(status) === 403 || BLOCK_RE.test(all)) {
    throw new Error(
      '网站安全防护拦截（HTTP 403 / 网宿 UrlACL）：\n' +
        '· 若为「云端」执行：Cloudflare 出口 IP 已被该站封禁（52pojie 只放行家庭宽带 IP），请把此账号切到「本地网络」。\n' +
        '· 若为「本地网络」执行：请先在浏览器打开 www.52pojie.cn 完成滑块/安全验证，再重新获取 Cookie。'
    );
  }
}

export const wuaipojie = {
  id: 'wuaipojie',
  name: '吾爱破解',
  desc: '吾爱破解论坛每日签到（Discuz 任务）。Cookie 方式，需先用浏览器过安全验证，UA 须与抓包时一致。',
  execution: 'browser', // 默认执行模式：server=云端执行，browser=浏览器扩展执行（用户网络）
  domain: 'www.52pojie.cn', // 浏览器执行时的目标域名
  // 浏览器端签到脚本：在用户浏览器中运行，自动携带登录 Cookie，使用用户网络（无 WAF）
  // 入参 params：{}；返回 { ok, message }
  // 注意：扩展会先导航标签页到 navigate_url（模拟手动点击），脚本只需检查当前页面内容
  navigateUrl: 'https://www.52pojie.cn/home.php?mod=task&do=apply&id=2&referer=%2Fportal.php',
  browserScript: `async (params) => {
    const html = document.documentElement.innerHTML || '';
    const text = document.body ? document.body.innerText || '' : '';
    const all = html + '\\n' + text;
    const WAF = ['waf_zw_verify', 'WZWS_CONFIRM_PREFIX_LABEL', 'slidercaptcha', '请完成安全验证', '安全检查中'];
    if (WAF.some((m) => all.includes(m))) return { ok: false, message: '遇到安全验证（WAF）：请在浏览器中打开 www.52pojie.cn 完成验证后重试' };
    if (/需要先登录|请先登录/.test(all)) return { ok: false, message: '登录已失效，请重新获取 Cookie' };
    if (/任务已完成|签到成功|打卡成功/.test(all)) return { ok: true, message: '签到成功' };
    if (/今日已签到|已经签到|已签到|签到完毕|签到完成|下期再来|明天再来|无需重复/.test(all)) return { ok: true, message: '今日已签到，无需重复' };
    return { ok: false, message: '未识别到成功标识，页面标题：' + (document.title || '未知') };
  }`,
  fields: [
    {
      key: 'cookie',
      label: 'Cookie',
      type: 'textarea',
      required: true,
      placeholder: '浏览器完成安全验证并登录 www.52pojie.cn 后，F12 → 网络 → 任一请求 → 复制请求头 Cookie（含 wzws_cid）',
    },
    {
      key: 'user_agent',
      label: 'User-Agent',
      type: 'text',
      required: true,
      placeholder: '必须与抓 Cookie 时的浏览器完全一致，否则会被 WAF 拦截',
    },
  ],
  tips: '关键：① 先用浏览器打开 www.52pojie.cn，完成滑块/安全验证并登录；② F12 复制完整 Cookie（必须含 wzws_cid，有时还有 wzws_sid）；③ User-Agent 填抓包浏览器的完整 UA，必须一致。Cookie 遇到 WAF 失效时面板会明确提示，重新用浏览器验证一次并更新 Cookie 即可。',

  async run(creds, ctx = {}) {
    const cookie = String(creds.cookie || '').trim();
    const ua = String(creds.user_agent || '').trim();
    if (!cookie) throw new Error('Cookie 未配置');
    if (!ua) throw new Error('User-Agent 未配置（必须与抓 Cookie 时的浏览器一致）');

    const baseHeaders = {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://www.52pojie.cn/portal.php',
      Cookie: cookie,
    };

    // 超时后的验证：如果签到请求超时/中继失败，可能是请求实际成功但响应没回来，
    // 去任务页看一眼有没有「签到完毕」，有就按已签到处理，避免误报失败。
    const verifySigned = async () => {
      try {
        const v = await fetchDualText('https://www.52pojie.cn/home.php?mod=task&do=apply&id=2', { headers: baseHeaders });
        if (has(v, SIGNED_MARKS)) return true;
        // 按钮文字「签到完毕」是已签到的铁证（见用户截图）
        const t = clean(v);
        if (/签到完毕/.test(t)) return true;
      } catch { /* 验证失败则忽略 */ }
      return false;
    };

    // ① 预检首页：**只看 WAF**。
    // 注意：portal.php 是门户页，上面除了博客卡片，还有论坛的最新帖标题 + 「最新公告」块。
    // 实测该页的公告里就写着「开放注册期间论坛暂停签到」，而帖子标题里什么都可能有。
    // 早期版本拿「暂停签到 / 今日已签到」这类词扫整个首页，结果把一个正常可签的账号
    // 报成「论坛官方暂停签到，等恢复后再试」——所以这里绝不能再凭首页文本下签到结论。
    // 注：中继模式下 runner.js 会透明替换 global fetch，站点代码无需改动
    // 优化：中继模式下跳过 portal.php 预检（省一次中继往返，52pojie 本来就慢）；
    // WAF 检测移到签到页做，签到页有 WAF 同样能识别。
    const isRelay = !!(ctx && ctx.relayDb);
    let home = null, pauseHint = '';
    if (!isRelay) {
      try {
        home = await fetchDualText('https://www.52pojie.cn/portal.php', { headers: baseHeaders });
        assertNoWaf(home, home.res.status);
        // 首页公告里提到暂停时，只当作「线索」留到最后当提示，不能当结论
        pauseHint = has(home, PAUSED_MARKS)
          ? '（注：门户页公告提到暂停签到，若确实暂停请等恢复）'
          : '';
      } catch (e) {
        // 预检超时/中继失败：直接验证是否已签到，避免误报
        if (/超时|timeout|中继|abort|network/i.test(e.message || '')) {
          if (await verifySigned()) {
            return { ok: true, message: '今日已签到（预检超时后验证确认：签到完毕）' };
          }
        }
        throw e;
      }
    }

    // ② 签到（手动跟随重定向，最多 3 跳）
    let url = 'https://www.52pojie.cn/home.php?mod=task&do=apply&id=2&referer=%2Fportal.php';
    let final = null;
    // 中继模式下无法使用 redirect:'manual'（opaqueredirect 响应头不可读），改用 follow 让浏览器自动跟随
    const redirectMode = ctx && ctx.relayDb ? 'follow' : 'manual';
    try {
      for (let i = 0; i < 4; i++) {
        const { res, utf8, gbk } = await fetchDualText(url, { headers: baseHeaders, redirect: redirectMode });
        assertNoWaf({ utf8, gbk }, res.status);
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location') || res.headers.get('Location');
          if (!loc) throw new Error('签到失败：重定向无 Location');
          url = /^https?:\/\//i.test(loc) ? loc : 'https://www.52pojie.cn/' + String(loc).replace(/^\/+/, '');
          continue;
        }
        final = { utf8, gbk, status: res.status };
        break;
      }
    } catch (e) {
      // 中继超时/网络错误：请求可能实际成功但响应没回来，验证一次再下结论
      if (/超时|timeout|中继|abort|network/i.test(e.message || '')) {
        if (await verifySigned()) {
          return { ok: true, message: '今日已签到，无需重复（超时后验证确认：签到完毕）' };
        }
      }
      throw e;
    }
    if (!final) throw new Error('签到失败：重定向次数过多');

    // 判定只看签到页（home.php?mod=task）——这页的文字都是任务本身的，不会被帖子标题污染
    const finalText = pickText(final);
    const hasLoginForm = /name=["']loginform["']/i.test(finalText) || /action=["'][^"']*logging\.php/i.test(finalText);
    if (hasLoginForm && !has(final, SIGNED_MARKS) && !has(final, SUCCESS_MARKS)) {
      throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    }
    if (has(final, SUCCESS_MARKS)) {
      // 中继模式下跳过积分页（省一次中继往返，52pojie 本来就慢；积分只是展示用）
      const suffix = isRelay ? '' : await creditSuffix(baseHeaders);
      return { ok: true, message: '签到成功：' + pickLine(final) + suffix, detail: '网站返回：' + clean(final).slice(0, 300) };
    }
    if (has(final, SIGNED_MARKS)) {
      const suffix = isRelay ? '' : await creditSuffix(baseHeaders);
      return { ok: true, message: '今日已签到，无需重复：' + pickLine(final) + suffix, detail: '网站返回：' + clean(final).slice(0, 300) };
    }
    if (has(final, LOGIN_MARKS)) {
      throw new Error('Cookie 已失效，请重新登录后复制新的 Cookie');
    }
    if (has(final, PAUSED_MARKS)) {
      throw new Error('论坛官方暂停签到：' + pickLine(final) + '。等恢复后再试。');
    }
    // apply 没出明确结论时，试一次 do=draw 领奖励（Discuz 每日任务：apply 是接任务，draw 是领奖励完成签到）
    try {
      const draw = await fetchDualText('https://www.52pojie.cn/home.php?mod=task&do=draw&id=2', { headers: baseHeaders, redirect: redirectMode });
      assertNoWaf(draw, draw.res.status);
      if (has(draw, SUCCESS_MARKS)) {
        const suffix = isRelay ? '' : await creditSuffix(baseHeaders);
        return { ok: true, message: '签到成功：' + pickLine(draw) + suffix, detail: '网站返回：' + clean(draw).slice(0, 300) };
      }
      if (has(draw, SIGNED_MARKS)) {
        const suffix = isRelay ? '' : await creditSuffix(baseHeaders);
        return { ok: true, message: '今日已签到，无需重复：' + pickLine(draw) + suffix, detail: '网站返回：' + clean(draw).slice(0, 300) };
      }
      // draw 页也没结论就用它的内容报，未识别时信息更准
      final = { utf8: draw.utf8, gbk: draw.gbk, status: draw.res.status };
    } catch (e) {
      // draw 失败不致命，继续用 apply 的结果报错
      if (/WAF|安全验证|403|UrlACL/.test(e.message || '')) throw e;
    }
    throw new Error(
      `签到失败：未识别到成功标识（HTTP ${final.status}）${pauseHint}，` +
        finalText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)
    );
  },
};
