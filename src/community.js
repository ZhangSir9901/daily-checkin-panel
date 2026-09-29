// 社区共享的「站点适配配置」
// ---------------------------------------------------------------------------
// 开源配套的核心：让**不会写代码的人也能贡献一个站点的适配**。
//
// 思路：大多数站点的签到其实就是「发一两个 HTTP 请求 + 看返回里有没有成功字样」，
// 而这套东西本项目的「自定义 HTTP 多步引擎」（src/sites/http.js）已经能做。
// 所以社区配置 = 一份**声明式 JSON**：
//   · 站点叫什么、要用户填哪些字段（Cookie / UA / 站点地址 …）
//   · 按顺序发哪些请求（可引用 {{cookie}}、{{user_agent}}、{{site_url}} 与上一步提取的变量）
//   · 怎么判定成功（expect_status / expect_contains，再叠加统一的信号识别器）
//
// 贡献流程：在自己面板里把某个站点配好 → 点「导出/分享」拿到这段 JSON →
// 发到 GitHub（Issue / PR / Gist 都行）→ 别人粘贴导入，就能给自己的账号签这个站。
//
// 安全：配置里**绝不能出现凭据**。导出时会把 cookie / password / token 之类的字段值清空，
// 导入时也会再扫一遍（validateSiteConfig 里拒绝任何看起来像凭据的明文）。
// ---------------------------------------------------------------------------

import { runHttpSteps } from './sites/http.js';

export const CONFIG_SCHEMA = 'daily-checkin-site/1';

// 字段 key 里出现这些词，就认为它是凭据/隐私，导出时必须清空、导入时必须拒绝带值。
// 注意：是**子串**匹配，所以「auth」会误伤「author」，这里写完整的 authorization / bearer。
const SECRET_KEY_RE = /cookie|password|passwd|token|secret|apikey|api_key|authorization|bearer|sign|vcode|kps|credential|sess(ion)?id/i;

function asText(v) {
  return v == null ? '' : String(v);
}

// 把请求头名变成合法的占位符名：X-Csrf-Token → {{x_csrf_token}}
// （占位符只会被 [\w$]+ 替换，名字里带短横线的会原样发出去，所以必须归一化）
function placeholderName(key) {
  return asText(key).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value';
}

// ---------- 校验 ----------
// 返回 { ok, errors: [], warnings: [], def }。不抛错，方便面板把问题一次列给用户。
export function validateSiteConfig(raw) {
  const errors = [];
  const warnings = [];
  let def = raw;

  if (typeof raw === 'string') {
    try { def = JSON.parse(raw); }
    catch (e) { return { ok: false, errors: ['不是合法的 JSON：' + String((e && e.message) || e)], warnings: [], def: null }; }
  }
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    return { ok: false, errors: ['配置必须是一个 JSON 对象'], warnings: [], def: null };
  }
  if (def.schema && def.schema !== CONFIG_SCHEMA) {
    errors.push(`配置版本不认识：${def.schema}（本面板支持 ${CONFIG_SCHEMA}）`);
  }

  const id = asText(def.id).trim();
  if (!/^[a-z0-9][a-z0-9_\-]{1,39}$/i.test(id)) {
    errors.push('id 必须是 2–40 位的字母/数字/下划线/短横线（建议用站点域名，如 bbs_example_com）');
  }
  const name = asText(def.name).trim();
  if (!name) errors.push('缺少站点名称 name');
  if (!Array.isArray(def.fields) || !def.fields.length) {
    warnings.push('没有 fields：用户添加账号时没有任何可填项（如果签到确实不需要任何输入，可以忽略）');
  }

  // ---- fields：账号表单就靠它渲染，逐项校验 ----
  //
  // 【为什么 key 必须限字符集】面板把 f.key 拼进 `data-k="…"`（还有一堆 querySelector），
  // 而配置是**从网上导入的**（别人写的 JSON）。key 里塞一句
  //   `" onfocus="alert(1)" autofocus x="`
  // 就是一个在管理员会话里执行的 XSS —— 面板里能拿到会话能拿到的一切。
  // （前端那一条路也统一走 esc()，两道一起上：这里挡住入库，前端挡住历史遗留的坏数据。）
  const fields = Array.isArray(def.fields) ? def.fields : [];
  const seenKeys = new Set();
  fields.forEach((f, i) => {
    const label = `fields[${i}]` + (f && asText(f.label) ? `（${asText(f.label).slice(0, 20)}）` : '');
    if (!f || typeof f !== 'object' || Array.isArray(f)) { errors.push(`${label}：不是对象`); return; }
    const key = asText(f.key).trim();
    if (!/^[A-Za-z0-9_]{1,40}$/.test(key)) {
      errors.push(`${label}：key 只能用字母/数字/下划线（1–40 位），现在是 ${JSON.stringify(asText(f.key))}`);
    } else if (seenKeys.has(key)) {
      errors.push(`${label}：key 与前面的字段重复了（${key}）——两个输入框共用一个值`);
    } else {
      seenKeys.add(key);
    }
    const type = asText(f.type || 'text');
    if (!['text', 'password', 'textarea', 'select'].includes(type)) {
      errors.push(`${label}：type 不认识（只支持 text / password / textarea / select）`);
    }
    if (type === 'select' && (!Array.isArray(f.options) || !f.options.length)) {
      errors.push(`${label}：select 必须给 options`);
    }
    if (Array.isArray(f.options) && f.options.length > 50) errors.push(`${label}：options 太多（最多 50 项）`);
    for (const k of ['label', 'placeholder']) {
      if (asText(f[k]).length > 120) errors.push(`${label}：${k} 太长（最多 120 字）`);
    }
  });
  if (Array.isArray(def.fields) && def.fields.length > 40) errors.push('fields 太多（最多 40 个）');
  if (!Array.isArray(def.steps) || !def.steps.length) {
    errors.push('缺少 steps：至少要有一个请求步骤');
  }

  const steps = Array.isArray(def.steps) ? def.steps : [];
  steps.forEach((st, i) => {
    const label = `第 ${i + 1} 步` + (st && st.name ? `（${st.name}）` : '');
    if (!st || typeof st !== 'object') { errors.push(`${label}：不是对象`); return; }
    if (!asText(st.url).trim()) errors.push(`${label}：缺少 url`);
    const m = asText(st.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) errors.push(`${label}：不支持的方法 ${m}`);
    if (st.headers != null && typeof st.headers !== 'string' && typeof st.headers !== 'object') {
      errors.push(`${label}：headers 必须是 JSON 字符串或对象`);
    }
    // 凭据检查：导出过的配置里不该带着任何真凭据
    const raw = JSON.stringify(st);
    if (st.headers && typeof st.headers === 'object') {
      for (const [k, v] of Object.entries(st.headers)) {
        if (SECRET_KEY_RE.test(k) && asText(v) && !/\{\{/.test(asText(v))) {
          errors.push(`${label}：请求头 ${k} 里带着明文凭据 —— 请改成占位符，例如 {{cookie}}（分享配置时不能带任何真实凭据）`);
        }
      }
    }
    if (SECRET_KEY_RE.test(asText(st.body)) && /=[A-Za-z0-9%_\-.]{12,}/.test(asText(st.body)) && !/\{\{/.test(asText(st.body))) {
      warnings.push(`${label}：请求体里可能带着明文凭据，确认一下里面用的都是 {{占位符}}`);
    }
    if (!st.expect_status && !st.expect_contains) {
      warnings.push(`${label}：没写 expect_status / expect_contains，只能靠通用信号识别判定成败，建议补上站点的成功特征`);
    }
    void raw;
  });

  return { ok: errors.length === 0, errors, warnings, def };
}

// ---------- 导出：把一份站点定义变成可分享的 JSON（清空一切凭据）----------
export function sanitizeSiteConfig(def) {
  const out = JSON.parse(JSON.stringify(def || {}));
  out.schema = CONFIG_SCHEMA;
  // 清掉只对本机有意义的内部字段
  delete out.community;
  delete out.localId;
  // source 在面板上会被渲染成「来源」链接。esc() 拦不住协议：
  // `javascript:fetch('/api/ext-key/rotate',{method:'POST'})` 转义后依旧是个能点的链接，
  // 点一下就在面板的源里执行脚本。所以除了前端只认 http/https，入库前也直接丢掉非法协议。
  if (out.source && !/^https?:\/\//i.test(String(out.source))) delete out.source;
  // 字段默认值里若有凭据痕迹，一并清掉
  if (Array.isArray(out.fields)) {
    out.fields = out.fields.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const key = asText(f.key);
      const copy = { ...f };
      if (SECRET_KEY_RE.test(key)) copy.value = '';
      delete copy.value;
      return copy;
    });
  }
  if (Array.isArray(out.steps)) {
    out.steps = out.steps.map((st) => {
      const copy = { ...(st || {}) };
      // headers 若是 JSON 字符串，把里面看起来像凭据的值换成占位符
      if (typeof copy.headers === 'string') {
        try {
          const h = JSON.parse(copy.headers);
          for (const k of Object.keys(h)) {
            if (SECRET_KEY_RE.test(k) && !/\{\{/.test(asText(h[k]))) h[k] = `{{${placeholderName(k)}}}`;
          }
          copy.headers = JSON.stringify(h, null, 0);
        } catch { /* 不是 JSON 就原样保留 */ }
      } else if (copy.headers && typeof copy.headers === 'object') {
        const h = { ...copy.headers };
        for (const k of Object.keys(h)) {
          if (SECRET_KEY_RE.test(k) && !/\{\{/.test(asText(h[k]))) h[k] = `{{${placeholderName(k)}}}`;
        }
        copy.headers = h;
      }
      if (typeof copy.body === 'string' && SECRET_KEY_RE.test(copy.body) && !/\{\{/.test(copy.body)) {
        // 拿不准的请求体：不猜，直接删掉，避免把凭据分享出去
        delete copy.body;
      }
      return copy;
    });
  }
  return out;
}

// ---------- 导入（存 D1）----------
export async function importSiteConfig(db, raw, opts = {}) {
  const v = validateSiteConfig(raw);
  if (!v.ok) {
    const err = new Error(v.errors.join('；'));
    err.errors = v.errors;
    throw err;
  }
  const def = sanitizeSiteConfig(v.def);
  const now = Date.now();
  const existing = await db.prepare('SELECT id FROM community_sites WHERE id = ?').bind(def.id).first();
  if (existing && !opts.overwrite) {
    const err = new Error(`已经导入过 id 为 ${def.id} 的站点配置；再次导入会覆盖它（确认后重试）`);
    err.needOverwrite = true;
    throw err;
  }
  await db
    .prepare(
      'INSERT INTO community_sites(id, name, author, version, source, def, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET name=excluded.name, author=excluded.author, version=excluded.version, source=excluded.source, def=excluded.def, updated_at=excluded.updated_at'
    )
    .bind(def.id, asText(def.name), asText(def.author), asText(def.version), asText(opts.source || def.source), JSON.stringify(def), now, now)
    .run();
  return { ok: true, id: def.id, def, warnings: v.warnings };
}

export async function listCommunitySites(db) {
  try {
    const { results } = await db.prepare('SELECT * FROM community_sites ORDER BY name').all();
    return (results || []).map((r) => {
      let def = {};
      try { def = JSON.parse(r.def || '{}'); } catch { /* 坏数据跳过解析 */ }
      return { id: r.id, name: r.name || def.name || r.id, author: r.author || '', version: r.version || '', source: r.source || '', def };
    });
  } catch {
    return []; // 表还没建（老库首次请求）时不要炸
  }
}

export async function deleteCommunitySite(db, id) {
  await db.prepare('DELETE FROM community_sites WHERE id = ?').bind(String(id)).run();
  return { ok: true };
}

// ---------- 把一份声明式配置变成可执行的站点模块 ----------
// 与内置站点模块同构（id/name/fields/run…），所以注册表、表单、调度器都不用改。
export function makeCommunitySite(def) {
  const steps = Array.isArray(def.steps) ? def.steps : [];
  const fields = Array.isArray(def.fields) && def.fields.length
    ? def.fields
    : [{ key: 'cookie', label: 'Cookie', type: 'textarea', required: true }];
  return {
    id: def.id,
    name: def.name || def.id,
    desc: def.desc || `社区配置（${def.author || '匿名'}${def.version ? ' v' + def.version : ''}）`,
    execution: def.execution === 'browser' || def.execution === 'relay' ? 'browser' : 'server',
    domain: def.domain || '',
    fields,
    tips: def.tips || '',
    community: {
      author: asText(def.author),
      version: asText(def.version),
      source: asText(def.source),
      notes: asText(def.notes),
    },
    // 账号里的字段直接作为变量喂给步骤：{{cookie}} / {{user_agent}} / {{site_url}} …
    async run(creds) {
      const vars = {};
      for (const [k, v] of Object.entries(creds || {})) vars[k] = asText(v);
      // 常见别名，降低配置作者的书写负担
      if (vars.cookie && !vars.cookies) vars.cookies = vars.cookie;
      if (vars.user_agent && !vars.ua) vars.ua = vars.user_agent;
      const r = await runHttpSteps(steps, vars);
      return { ok: true, message: r.message, detail: r.detail || '', ...(r.cookieRefresh ? { cookieRefresh: r.cookieRefresh } : {}) };
    },
  };
}

// ---------- 反向：把一个账号里录好的配置导出成可分享的 JSON ----------
// 场景：你花力气录好了一个「先登录拿 token 再签到」的多步流程 ——
// 导出这段 JSON 发到 GitHub，别人粘贴导入就能直接签这个站，不用再录一遍。
//
// 自动做三件事：
//   1. 把请求头/请求体里的真实 Cookie、token 换成 {{占位符}}（绝不能分享凭据）
//   2. 扫出步骤里用到的每个 {{变量}}，倒推出「用户需要填哪些字段」
//   3. 把绝对地址拆成「{{site_url}} + 路径」，换个人用也能改域名

// 字段提示：让分享出去的配置在别人面板里也有一句像样的人话说明
const FIELD_PRESETS = {
  cookie: { label: 'Cookie', type: 'textarea', required: true, placeholder: '在该网站登录后，用浏览器扩展「一键复制全部信息」；面板会自动填好' },
  cookies: { label: 'Cookie', type: 'textarea', required: true, placeholder: '在该网站登录后，用浏览器扩展「一键复制全部信息」' },
  user_agent: { label: 'User-Agent', type: 'text', required: true, placeholder: '用浏览器扩展复制时自动带上，通常不用手填' },
  site_url: { label: '站点地址', type: 'text', required: true, placeholder: 'https://example.com（末尾不要带 /）' },
  username: { label: '用户名', type: 'text', required: true },
  password: { label: '密码', type: 'password', required: true },
};

function safeJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// 把绝对地址拆成 {{site_url}} + 路径（换个人用也能改域名）
function splitUrlForShare(url) {
  const m = String(url || '').match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
  if (!m) return { url: asText(url), origin: '' };
  return { url: '{{site_url}}' + (m[2] || '/'), origin: m[1] };
}

/**
 * 账号 → 可分享的社区配置。
 * account：{ id, name, site, creds }（creds 可为 JSON 字符串或对象）
 * site：siteMeta 里的那一项（可空）
 * extra：{ id, name, author, version, desc, source, domain } 允许调用方覆盖
 *
 * 返回 { ok, config, warnings }；不能分享的账号（比如内置站点，没有可复制的请求序列）
 * 返回 { ok:false, reason }，由面板给出人话解释。
 */
export function exportAccountConfig(account, site = {}, extra = {}) {
  const creds = typeof account.creds === 'string' ? safeJSON(account.creds, {}) : (account.creds || {});
  const warnings = [];

  // 1) 取出步骤：多步录制优先；单次请求的账号也转成一步，同样能分享
  let steps = Array.isArray(creds.steps) ? creds.steps.filter(Boolean).map((st) => ({ ...st })) : [];
  let domain = site.domain || '';
  if (!steps.length && creds.url) {
    const split = splitUrlForShare(creds.url);
    if (split.origin) domain = domain || split.origin.replace(/^https?:\/\//i, '');
    steps = [{
      name: '签到请求',
      method: creds.method || 'GET',
      url: split.url,
      headers: creds.headers || '',
      body: creds.body || '',
      expect_status: creds.expect_status || '',
      expect_contains: creds.expect_contains || '',
    }];
  }
  if (!steps.length) {
    // 用的是社区站点：配置本来就是别人分享的那份，直接复制原配置即可
    if (site && site.community) {
      return { ok: false, reason: `这个账号用的是社区站点「${asText(site.name)}」——它的配置就是导入进来的那一份，直接在上面「已导入的社区站点」列表里点「复制 JSON」就能再分享出去。` };
    }
    return { ok: false, reason: '这个账号用的是面板内置的站点模块（代码写死的签到逻辑），没有可以分享的请求序列。想分享的话，请用「自定义 HTTP」录一遍该网站的签到流程，再导出。' };
  }

  // 站点没登记域名时，从步骤里第一个绝对地址推一个出来
  if (!domain) {
    for (const st of steps) {
      const m = asText(st.url).match(/^https?:\/\/([^/]+)/i);
      if (m) { domain = m[1]; break; }
    }
  }

  // 多步录制的绝对地址也换成 {{site_url}}（只在拿得到域名时做）
  if (domain) {
    steps = steps.map((st) => {
      const u = asText(st.url);
      if (!/^https?:\/\//i.test(u)) return st;
      try {
        const abs = new URL(u);
        if (abs.hostname && abs.hostname === domain) {
          return { ...st, url: '{{site_url}}' + abs.pathname + abs.search };
        }
      } catch { /* 地址不合法就原样保留 */ }
      return st;
    });
  }

  // 2) 先清掉一切凭据（真实 Cookie / token → {{占位符}}），再据此倒推字段。
  //    顺序很关键：字段就是「清完之后还剩哪些占位符」。
  const id = asText(extra.id) || (domain ? domain.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') : '') || 'site_' + account.id;
  const config = sanitizeSiteConfig({
    id,
    name: asText(extra.name) || (site.name && site.id !== 'http' ? site.name : '') || domain || '社区站点',
    desc: asText(extra.desc) || `每日签到（${steps.length} 步）`,
    author: asText(extra.author),
    version: asText(extra.version) || '1.0.0',
    source: asText(extra.source),
    execution: site.execution === 'browser' || site.execution === 'relay' ? 'browser' : 'server',
    domain,
    steps,
    tips: '导入后添加账号：登录该网站 → 用浏览器扩展「一键复制全部信息」→ 回面板 Ctrl+V 粘贴即自动保存。',
  });

  // 3) 扫出用到的占位符，排除「自己从响应里提取」的那些（那是内部变量，不是用户要填的）
  const produced = new Set();
  for (const st of config.steps || []) for (const k of Object.keys(st.extract || {})) produced.add(k);
  const used = new Set();
  for (const m of JSON.stringify(config.steps || []).matchAll(/\{\{\s*([\w$]+)\s*\}\}/g)) used.add(m[1]);
  const need = [...used].filter((k) => !produced.has(k)).sort();
  config.fields = need.map((k) => {
    const p = FIELD_PRESETS[k];
    return p ? { key: k, ...p } : { key: k, label: k, type: 'text', required: true };
  });
  if (!need.length) {
    warnings.push('这份配置不需要用户填任何东西，导入的人直接点执行就能跑 —— 请确认它确实不需要 Cookie');
  } else if (!need.includes('cookie') && need.some((k) => /cookies?/.test(k))) {
    warnings.push(`配置里用的是 {{${need.find((k) => /cookies?/.test(k))}}}，建议统一改成 {{cookie}}（面板的「粘贴即保存」会填这个变量）`);
  }

  // 分享出去的东西里绝不允许残留凭据：再自查一遍，命中就只给警告（sanitize 已处理）
  const cfgText = JSON.stringify(config);
  if (/(sk-[A-Za-z0-9]{16,}|[A-Za-z0-9_\-]{40,})/.test(cfgText.replace(/\{\{[^}]*\}\}/g, ''))) {
    warnings.push('配置里疑似还残留长字符串凭证，请人工确认后再分享');
  }

  const v = validateSiteConfig(config);
  return { ok: v.ok, config, warnings: [...warnings, ...v.warnings], errors: v.errors };
}
