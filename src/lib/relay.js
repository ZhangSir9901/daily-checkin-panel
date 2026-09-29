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
  // atob 只认标准 base64；扩展端偶尔会带上换行（长串被折行），先把空白清掉
  const s = atob(String(b64).replace(/\s+/g, ''));
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
  // foreground：允许扩展「在超时时把标签页拿到前台重试」。
  // 默认关 —— 抢焦点会打断用户正在看的页面（用户看到的就是“浏览器乱跳”）。
  // 只有确实过不去的反爬站点才在自己的 fetch 里写 { foreground: true } 显式开启。
  if (options.foreground) safeOptions.foreground = true;
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
  let lastJob = null; // 超时告警里要写清卡在哪个请求
  while (Date.now() < deadline) {
    const job = await db.prepare('SELECT * FROM relay_jobs WHERE id = ?').bind(jobId).first();
    if (!job) throw new Error('中继任务不存在');
    lastJob = job;
    // 报错时把「卡住的到底是哪个请求」一并带上（存放 detail）。
    // 吾爱破解这类超时以前只显示一句「已放弃该请求」，用户在面板上完全看不出卡在哪一步。
    const where = `中继请求：${String(job.method || 'GET').toUpperCase()} ${String(job.url || '').slice(0, 160)}`;
    if (job.status === 'failed') {
      const err = new Error('本地网络失败：' + (job.error || '未知错误'));
      err.outcome = 'relay';
      err.detail = where;
      throw err;
    }
    if (job.status === 'done') {
      let respUrl = '';
      let respHeaders = {};
      try {
        respHeaders = JSON.parse(job.resp_headers || '{}') || {};
        // 扩展回传的最终 URL 存在 headers 的 x-relay-url（如果有）
        respUrl = respHeaders['x-relay-url'] || '';
      } catch { /* 回传的头不是合法 JSON：当作没有头，别在这里抛错把结论带偏 */ }
      const respStatus = Number(job.resp_status || 0) || 0;
      const respBody = job.resp_body || '';
      // 「完成了，但什么都没带回来」——这是**链路**没把响应交回来，不是站点返回空。
      //
      // 【踩坑 2026-09-28 线上】以前这里如数把空响应交给站点模块，模块看到「（无响应）」
      // 就把它当成「站点不认这个接口」，把 user_qiandao 等候选接口一个个重打一遍，
      // 最后在面板上写「签到失败：… 站点不认这个接口」—— 结论完全是错的，
      // 用户看到的就是「本地网络签到失败」，而站点其实一直回答得好好的。
      // 现在在这里就停下：明确告诉用户是这条路的响应丢了，并给出可执行的下一步。
      if (!respStatus && !respBody) {
        // 建议部分**不写死路线**：这里不知道用户在「执行方式」里固定了什么、
        // 另一条路线到底能不能用（扩展在不在线）。写死「切回自动就会改走 CF 直连」
        // 在「本来就固定着 CF 直连」的账号上是一句会误导人的废话 ——
        // 具体该切哪条、为什么切不过去，由 runner 拿到全局信息后补上。
        const err = new Error(
          '本地网络失败：扩展执行了请求，但没把网站的响应带回来（空响应）。这多半是中继链路的问题，不是站点的问题；'
          + '可确认扩展已升级到最新版并重新加载，或在「执行方式」里换另一条路线重试。'
        );
        err.outcome = 'relay';
        err.detail = where + '｜中继回传里没有状态码、也没有正文';
        throw err;
      }
      // 解码回传的正文：以前这里直接 b64decode（内部是 atob），一串不合法的 base64
      // 会让 atob 抛「Invalid character」—— 这句会一路冒到面板的「网站反馈」里，
      // 用户看到的是一个和自己无关的字符串错误，完全不知道是扩展回传坏了。
      // 接口侧现在会先挡一道，但旧版本扩展 / 库里已有的坏行仍可能落到这里，所以这里也容错。
      let respBytes = new Uint8Array(0);
      if (respBody) {
        try { respBytes = b64decode(respBody); } catch {
          const err = new Error('本地网络失败：扩展回传的响应体不是合法的 base64（扩展版本与面板可能不匹配，请更新扩展后重试）');
          err.outcome = 'relay';
          err.detail = where;
          throw err;
        }
      }
      return {
        status: respStatus,
        headers: respHeaders,
        body: respBytes,
        url: respUrl,
      };
    }
    // running（扩展已领走、正在执行）与 pending 一样：继续等，不是失败也不是完成。
    await sleep(pollMs);
  }
  const err = new Error('等待本地网络响应超时：扩展没有在 ' + Math.round(timeoutMs / 1000) + ' 秒内回传（扩展可能休眠、被关闭，或未配置 API Key）');
  err.outcome = 'relay';
  err.detail = `中继请求：${lastJob ? String(lastJob.method || 'GET').toUpperCase() + ' ' + String(lastJob.url || '').slice(0, 160) : '（未取到任务信息）'}`;
  throw err;
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
    // foreground 必须一起透传：README / 站点模块里写的 `fetch(url, { foreground: true })`
    // 是「超时可以把标签页提到前台重试」的唯一开关（queueRelayJob 支持它，但这里曾经漏传，
    // 于是那个开关怎么开都没用）。默认不带 = 永远不抢焦点。
    options: { redirect: init.redirect, foreground: init.foreground },
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

// 中继队列里还有多少没做完的请求（pending + running）。
// 用途：扩展是**单飞**执行（一个请求最长 ~58 秒），队列里已经堆着请求时再塞进去，
// 只会让每个请求都在 90 秒后超时 —— 线上 2026-09-28 的「扩展没有在 90 秒内回传」刷屏就是这么来的。
// 所以调用方先看一眼队列，忙就先不添乱（记「稍后重试」而不是失败）。
export async function relayBacklog(db) {
  try {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM relay_jobs WHERE status IN ('pending','running') AND created_at > ?")
      .bind(Date.now() - 300000)
      .first();
    return Number((row && row.n) || 0);
  } catch {
    return 0;
  }
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
