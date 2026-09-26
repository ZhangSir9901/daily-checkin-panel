// 自定义 HTTP 任务：万能签到模块
// 适用于任何纯 HTTP(S) 的签到/打卡：配置请求方法、URL、请求头、请求体，
// 再配置期望的状态码与响应中应包含的文本，面板每天自动请求并判定成功/失败。
// 例如：V2EX（Cookie）、Bilibili、各类网站每日签到接口等。

export const httpTask = {
  id: 'http',
  name: '自定义 HTTP',
  desc: '通用模块：定时发起一次 HTTP 请求，按状态码与响应内容判定签到是否成功。',
  fields: [
    { key: 'url', label: '请求地址', type: 'text', required: true, placeholder: 'https://example.com/api/sign' },
    {
      key: 'method', label: '请求方法', type: 'select', required: true,
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    },
    { key: 'headers', label: '请求头（JSON）', type: 'textarea', required: false, placeholder: '{"Cookie": "xxx=yyy", "User-Agent": "..."}' },
    { key: 'body', label: '请求体', type: 'textarea', required: false, placeholder: 'POST 时填写，如 {"a":1} 或 a=1&b=2' },
    { key: 'expect_status', label: '期望状态码', type: 'text', required: false, placeholder: '200（默认）' },
    { key: 'expect_contains', label: '响应应包含', type: 'text', required: false, placeholder: '如 "success"，留空则只校验状态码' },
  ],
  tips: '把浏览器/抓包工具中签到请求的 URL、Cookie、参数照搬过来即可。响应判定失败时，运行日志会记录原因，方便调试。',

  async run(creds) {
    const url = (creds.url || '').trim();
    if (!url) throw new Error('请求地址未配置');
    const method = String(creds.method || 'GET').toUpperCase();

    let headers = {};
    if (creds.headers && String(creds.headers).trim()) {
      try {
        headers = JSON.parse(creds.headers);
      } catch {
        throw new Error('请求头不是合法的 JSON');
      }
    }

    const init = { method, headers };
    if (creds.body && method !== 'GET' && method !== 'HEAD') init.body = creds.body;

    const res = await fetch(url, init);
    const text = await res.text();
    const expectStatus = parseInt(creds.expect_status || '200', 10);

    if (res.status !== expectStatus) {
      throw new Error(`状态码 ${res.status}，期望 ${expectStatus}。响应前 200 字符：${text.slice(0, 200)}`);
    }
    if (creds.expect_contains && !text.includes(creds.expect_contains)) {
      throw new Error(`响应不包含期望内容「${creds.expect_contains}」。响应前 200 字符：${text.slice(0, 200)}`);
    }
    return { ok: true, message: `请求成功（HTTP ${res.status}）` };
  },
};
