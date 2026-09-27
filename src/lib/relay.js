// 本地网络中继代理 - Worker 端 helper
// 用法：站点模块中用 relayFetch(env, url, init) 代替 fetch(url, init)，
// 请求会经由浏览器扩展，用用户的本地网络执行后返回。
// 适用于：站点逻辑保留在 Worker，但需要用户本地 IP（绕过 CF/Worker IP 限制）的场景。

function b64encode(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function b64decode(b64) {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 提交中继任务到 D1 队列，返回 job_id
export async function queueRelayJob(db, { url, method = 'GET', headers = {}, body = null, options = {} }) {
  const id = 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  const now = Date.now();
  let bodyB64 = null;
  if (body != null) {
    if (typeof body === 'string') bodyB64 = b64encode(new TextEncoder().encode(body));
    else if (body instanceof Uint8Array) bodyB64 = b64encode(body);
    else if (body instanceof ArrayBuffer) bodyB64 = b64encode(new Uint8Array(body));
  }
  // 只透传安全的 fetch 选项（redirect 等），过滤掉 body/headers（已单独处理）
  const safeOptions = {};
  if (options.redirect) safeOptions.redirect = String(options.redirect);
  await db.prepare(
    'INSERT INTO relay_jobs(id, url, method, headers, body, options, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).bind(id, String(url), String(method).toUpperCase(), JSON.stringify(headers || {}), bodyB64, JSON.stringify(safeOptions), 'pending', now, now).run();
  // 顺手清理旧任务
  await db.prepare('DELETE FROM relay_jobs WHERE created_at < ?').bind(now - 600000).run().catch(() => {});
  return id;
}

// 等待中继结果（轮询 D1），返回 { status, headers, body: Uint8Array, url }，超时抛错
// 轮询间隔调小（300ms），配合扩展端的长轮询：任务被领走后通常 1 秒内就能拿到结果
// timeoutMs 也要覆盖「扩展多等一轮长轮询」的最坏情况。
// 52pojie 这类慢站：扩展端 fetch 超时 30s + 任务超时 60s，Worker 端给 90s 兜底
export async function waitRelayResult(db, jobId, timeoutMs = 90000, pollMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await db.prepare('SELECT * FROM relay_jobs WHERE id = ?').bind(jobId).first();
    if (!job) throw new Error('中继任务不存在');
    if (job.status === 'failed') {
      const err = new Error('本地网络失败：' + (job.error || '未知错误'));
      err.outcome = 'relay';
      throw err;
    }
    if (job.status === 'done') {
      let respUrl = '';
      try {
        const h = JSON.parse(job.resp_headers || '{}');
        // 扩展回传的最终 URL 存在 headers 的 x-relay-url（如果有）
        respUrl = h['x-relay-url'] || '';
      } catch { /* 忽略 */ }
      return {
        status: job.resp_status || 0,
        headers: JSON.parse(job.resp_headers || '{}'),
        body: job.resp_body ? b64decode(job.resp_body) : new Uint8Array(0),
        url: respUrl,
      };
    }
    await sleep(pollMs);
  }
  throw new Error('等待本地网络响应超时：扩展没有在 ' + Math.round(timeoutMs / 1000) + ' 秒内回传（扩展可能休眠、被关闭，或未配置 API Key）');
}

// 模拟 fetch 的中继版本：在用户本地网络中执行 HTTP 请求
// init: { method, headers, body, redirect }，body 支持 string / Uint8Array / ArrayBuffer
// 返回：{ status, headers, url, arrayBuffer(), text(), json() }
export async function relayFetch(db, url, init = {}) {
  const jobId = await queueRelayJob(db, {
    url,
    method: init.method || 'GET',
    headers: init.headers || {},
    body: init.body || null,
    options: { redirect: init.redirect },
  });
  const { status, headers, body, url: finalUrl } = await waitRelayResult(db, jobId);
  const headerBag = {};
  for (const k of Object.keys(headers || {})) headerBag[k.toLowerCase()] = headers[k];
  return {
    status,
    // 大小写不敏感的头访问（站点模块里 res.headers.get('Location')/'location' 都能拿到）
    headers: {
      get: (name) => {
        const k = String(name).toLowerCase();
        return k in headerBag ? headerBag[k] : null;
      },
    },
    url: finalUrl || url,
    async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); },
    async text() { return new TextDecoder().decode(body); },
  };
}

// 检查扩展是否在线（90 秒内有轮询 relay-pending）
export async function isRelayAvailable(db) {
  try {
    const { getSetting } = await import('../db.js');
    const last = parseInt((await getSetting(db, 'relay_last_poll')) || '0', 10) || 0;
    return Date.now() - last < 90000;
  } catch {
    return false;
  }
}
