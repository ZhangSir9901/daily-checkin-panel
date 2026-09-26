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
  if (!raw || !String(raw).trim()) return {};
  let h;
  try {
    h = JSON.parse(subst(raw, vars));
  } catch {
    throw new Error('请求头不是合法的 JSON');
  }
  if (!h || typeof h !== 'object') throw new Error('请求头不是合法的 JSON 对象');
  return h;
}

// 执行多步场景，返回 { ok, message, vars }；失败时抛错（含步骤名）。
export async function runHttpSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('至少需要一个步骤');
  const vars = {};
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    const name = st.name || `步骤${i + 1}`;
    const url = subst(st.url || '', vars).trim();
    if (!url) throw new Error(`${name}：请求地址未配置`);
    const method = String(st.method || 'GET').toUpperCase();
    const headers = parseHeaders(st.headers, vars);
    const init = { method, headers };
    const body = subst(st.body || '', vars);
    if (body && method !== 'GET' && method !== 'HEAD') init.body = body;

    let res, text;
    try {
      res = await fetch(url, init);
      text = await res.text();
    } catch (e) {
      throw new Error(`${name}：请求异常（${String((e && e.message) || e).slice(0, 120)}）`);
    }

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

    const expectStatus = parseInt(st.expect_status || '200', 10);
    if (res.status !== expectStatus) {
      throw new Error(`${name}：状态码 ${res.status}，期望 ${expectStatus}。响应前 200 字符：${text.slice(0, 200)}`);
    }
    if (st.expect_contains && !text.includes(st.expect_contains)) {
      throw new Error(`${name}：响应不包含期望内容「${st.expect_contains}」。响应前 200 字符：${text.slice(0, 200)}`);
    }
  }
  const varDesc = Object.keys(vars).length ? `（提取变量：${Object.keys(vars).join('、')}）` : '';
  return { ok: true, message: `${steps.length} 步全部成功${varDesc}`, vars };
}

export const httpTask = {
  id: 'http',
  name: '自定义 HTTP',
  desc: '通用模块：单次请求或多步录制（按顺序执行多个请求，后一步可引用前一步的结果）。',
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
  tips: '新网站接入：在电脑浏览器人工登录该网站并完成一次签到 → F12 网络面板找到签到请求 → 右键「复制为 cURL」→ 添加账号时粘贴并点「从 cURL 导入」（Cookie 会自动带入，无需手动复制）。多步流程（如先登录拿 token 再签到）用「多步录制」：每一步粘贴对应的 cURL，用「提取变量」把上一步响应的字段（如 data.token）存为变量，下一步用 {{token}} 引用。Cookie 失效时执行日志会提示，重新录制一次即可。',

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
    return { ok: true, message: r.message.replace(/^1 步全部成功/, '请求成功') };
  },
};
