// 自定义 HTTP 任务：万能签到模块（支持多步录制）
// 单步模式：配置一次 HTTP 请求，按状态码与响应内容判定成功/失败。
// 多步模式：按顺序执行多个请求（录制签到操作），后一步可用 {{变量名}}
// 引用前一步从响应中提取的值。适用于"先登录拿 token 再签到"等多接口流程。
//
// 步骤格式（JSON 数组，存在 creds.steps）：
// [{ name, method, url, headers(JSON字符串), body,
//    extract: {"token": "data.token"},   // 从 JSON 响应按点路径提取变量
//    expect_status: 200, expect_contains: "success" }]
//
// extract 的点路径：如 data.token；也支持 data.list.0.id。

import { classifySignal, needsHuman, OUTCOME, siteMessageFrom } from '../lib/signals.js';
import { cookiesFrom, mergeCookies } from '../lib/web.js';

function subst(str, vars) {
  return String(str == null ? '' : str).replace(/\{\{\s*([\w$]+)\s*\}\}/g, (_, k) =>
    vars[k] == null ? '' : String(vars[k])
  );
}

function jsonPath(text, path) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error(`提取变量失败：响应不是 JSON（路径 ${path}）`); }
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) {
      throw new Error(`提取变量失败：路径 ${path} 不存在`);
    }
    cur = cur[p];
  }
  if (cur != null && typeof cur === 'object') return JSON.stringify(cur);
  return String(cur == null ? '' : cur);
}

function parseHeaders(raw, vars) {
  if (!raw) return {};
  // 两种写法都支持：
  //   · 对象（社区配置里作者手写，更自然）
  //   · JSON 字符串（账号录制器里存的就是这种）
  if (typeof raw === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = subst(v == null ? '' : String(v), vars);
    return out;
  }
  if (!String(raw).trim()) return {};
  let h;
  try {
    h = JSON.parse(subst(raw, vars));
  } catch {
    throw new Error('请求头不是合法的 JSON');
  }
  if (!h || typeof h !== 'object') throw new Error('请求头不是合法的 JSON 对象');
  return h;
}

// 执行多步场景，返回 { ok, message, vars, detail }；失败时抛错（含步骤名）。
// vars：变量表。initialVars 会先铺进去（账号字段直接当变量用，如 {{cookie}}、{{site_url}}），
// 后续步骤 extract 出的变量可以覆盖它们；社区配置就是靠这个机制做到「零代码适配」。
export async function runHttpSteps(steps, initialVars = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('至少需要一个步骤');
  const vars = { ...(initialVars || {}) };
  let lastText = ''; // 最后一步的原始响应：作为「网站反馈」原话展示
  // 各步骤响应里网站轮换下来的 Cookie（Set-Cookie）：收集起来随结果带回，
  // runner 会在签到成功时静默合并进账号凭据（OpenList 式凭据续期）。
  let refreshed = '';
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    const name = st.name || `步骤${i + 1}`;
    const url = subst(st.url || '', vars).trim();
    if (!url) throw new Error(`${name}：请求地址未配置`);
    const method = String(st.method || 'GET').toUpperCase();
    const headers = parseHeaders(st.headers, vars);
    const init = { method, headers };
    // 请求体同样两种写法都收：对象（社区配置）或字符串（录制器）
    const rawBody = st.body && typeof st.body === 'object' ? JSON.stringify(st.body) : st.body;
    const body = subst(rawBody || '', vars);
    if (body && method !== 'GET' && method !== 'HEAD') init.body = body;

    let res, text;
    try {
      res = await fetch(url, init);
      text = await res.text();
    } catch (e) {
      throw new Error(`${name}：请求异常（${String((e && e.message) || e).slice(0, 120)}）`);
    }
    // 收集网站轮换的 Cookie（直连模式下 getSetCookie 能拿到完整数组；读不到返回 ''）
    const sc = cookiesFrom(res);
    if (sc) refreshed = refreshed ? mergeCookies(refreshed, sc) : sc;

    // 提取变量供后续步骤使用
    if (st.extract && typeof st.extract === 'object') {
      for (const [k, p] of Object.entries(st.extract)) {
        if (!k || !p) continue;
        try {
          vars[k] = jsonPath(text, p);
        } catch (e) {
          throw new Error(`${name}：${e.message}`);
        }
      }
    }

    lastText = text;
    const expectStatus = parseInt(st.expect_status || '200', 10);
    // 统一识别网站反馈：登录失效 / 验证码 / WAF / 已签到 都能给出可操作结论，
    // 而不是只报一个生硬的状态码。很多站点重复签到会返回非预期内容，这里不该算失败。
    const sig = classifySignal(text, { status: res.status });
    const already = sig.outcome === OUTCOME.ALREADY; // 「今日已签到」不是错误
    const snippet = `响应前 200 字符：${text.slice(0, 200)}`;
    const blocked = needsHuman(sig.outcome) ? `${name}：${sig.label}。${snippet}` : '';

    // 「被拦 / 要人工验证 / 要登录 / 被限流 / 网站暂停」是**明确结论**，不能用状态码盖过去。
    //
    // 实测（2026-09-28）：吾爱破解的 /home.php 从机房 IP 拿到的就是网宿 WZWS 的 JS 挑战页，
    // 它的状态码是 **200**、页面里也没有任何中文提示（只有一句英文的
    // "Please enable JavaScript and refresh the page."），而 expect_status 默认也是 200。
    // 于是老代码走完状态码校验就一路 ok，最后报出一句「签到成功」——
    // 这是最危险的一类假成功：面板说签好了，网站根本没动，用户还得自己发现。
    if (needsHuman(sig.outcome) || sig.outcome === OUTCOME.RATE_LIMIT || sig.outcome === OUTCOME.PAUSED) {
      const err = new Error(blocked || `${name}：${sig.label || '网站拒绝了这次请求'}`);
      err.outcome = sig.outcome;
      err.detail = `网站返回：${text.replace(/\s+/g, ' ').slice(0, 300)}`;
      throw err;
    }

    if (res.status !== expectStatus && !already) {
      if (blocked) throw new Error(blocked);
      throw new Error(`${name}：状态码 ${res.status}，期望 ${expectStatus}。${snippet}`);
    }
    if (st.expect_contains && !text.includes(st.expect_contains) && !already) {
      if (blocked) throw new Error(blocked);
      throw new Error(`${name}：响应不包含期望内容「${st.expect_contains}」。${snippet}`);
    }
  }
  const varDesc = Object.keys(vars).length ? `（提取变量：${Object.keys(vars).join('、')}）` : '';
  // 主文案尽量用**网站自己的话**（响应 JSON 里的 message/msg）：
  // 社区配置的判定是通用的，但反馈应该让用户看到网站怎么说。
  const siteMsg = siteMessageFrom(lastText);
  return {
    ok: true,
    message: steps.length === 1
      ? (siteMsg || '签到成功')
      : `${steps.length} 步全部成功${siteMsg ? `：${siteMsg}` : varDesc}`,
    vars,
    detail: lastText ? '网站返回：' + lastText.replace(/\s+/g, ' ').slice(0, 300) : '',
    // 网站轮换下来的新 Cookie（"a=1; b=2"）：runner 在签到成功时静默合并存回 D1
    ...(refreshed ? { cookieRefresh: refreshed } : {}),
  };
}

export const httpTask = {
  id: 'http',
  name: '自定义 HTTP',
  desc: '通用模块：单次请求或多步录制（按顺序执行多个请求，后一步可引用前一步的结果）。',
  execution: 'server', // 默认执行模式：server=云端执行，browser=浏览器扩展执行（用户网络）
  fields: [
    { key: 'url', label: '请求地址', type: 'text', required: false, placeholder: 'https://example.com/api/sign（多步模式可留空）' },
    {
      key: 'method', label: '请求方法', type: 'select', required: false,
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    },
    { key: 'headers', label: '请求头（JSON）', type: 'textarea', required: false, placeholder: '{"Cookie": "xxx=yyy", "User-Agent": "..."}' },
    { key: 'body', label: '请求体', type: 'textarea', required: false, placeholder: 'POST 时填写，如 {"a":1} 或 a=1&b=2' },
    { key: 'expect_status', label: '期望状态码', type: 'text', required: false, placeholder: '200（默认）' },
    { key: 'expect_contains', label: '响应应包含', type: 'text', required: false, placeholder: '如 "success"，留空则只校验状态码' },
  ],
  tips: '新网站接入：在电脑浏览器人工登录该网站并完成一次签到 → F12 网络面板找到签到请求 → 右键「复制为 cURL」→ 添加账号时粘贴并点「从 cURL 导入」（Cookie 会自动带入，无需手动复制）。更快的方式：扩展 2.19+ 的「🎬 录制签到请求」——在网站上亲手点一次签到，扩展自动把请求抓下来发到面板预填。多步流程（如先登录拿 token 再签到）用「多步录制」：每一步粘贴对应的 cURL，用「提取变量」把上一步响应的字段（如 data.token）存为变量，下一步用 {{token}} 引用。Cookie 失效时执行日志会提示，重新录制一次即可。',

  async run(creds) {
    // 多步模式
    if (creds && Array.isArray(creds.steps) && creds.steps.length) {
      return runHttpSteps(creds.steps);
    }
    // 单步模式（兼容老数据）
    const url = (creds.url || '').trim();
    if (!url) throw new Error('请求地址未配置');
    const r = await runHttpSteps([{
      name: '签到请求', method: creds.method, url: creds.url,
      headers: creds.headers, body: creds.body,
      expect_status: creds.expect_status, expect_contains: creds.expect_contains,
    }]);
    return { ok: true, message: r.message.replace(/^1 步全部成功/, '请求成功'), ...(r.cookieRefresh ? { cookieRefresh: r.cookieRefresh } : {}) };
  },
};
