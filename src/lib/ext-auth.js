// 扩展 / 外部客户端请求鉴权
// ---------------------------------------------------------------------------
// 背景：面板的 /api/external/* 由浏览器扩展（或 VM 脚本）用 API Key 调用。
// 只用「把 Key 放在请求头里」有两个弱点：
//   1. Key 会随请求明文出现在任何能看到请求头的中间环节；一旦泄露即刻可被冒用；
//   2. 抓到的请求可以被无限重放。
//
// 这里加一层「共享密钥签名」：
//   X-Api-Key : 共享密钥（仍需校验，防止签名计算在错误 Key 上）
//   X-Ts      : 毫秒时间戳（±5 分钟）
//   X-Nonce   : 一次性随机串（64 字符内，用过即写入 api_nonces）
//   X-Sign    : hex(HMAC-SHA256(key, "METHOD\nPATH\nTS\nNONCE\nsha256hex(body)"))
//
// 兼容性：未带 X-Sign 的旧客户端仍按「仅 Key」放行；当面板开启 ext_require_sign 后
// 强制要求签名（此时旧版扩展需升级）。两种模式都会把结果写进返回值，便于面板展示。

const MAX_SKEW_MS = 5 * 60 * 1000; // 允许的时钟偏差
const NONCE_TTL_MS = 10 * 60 * 1000; // nonce 保留时长（覆盖最大偏差窗口）

const te = new TextEncoder();

// 常量时间字符串比较：避免通过响应时间差逐字节猜测 Key
export function safeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function toHex(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function randomNonce() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', te.encode(String(text == null ? '' : text)));
  return toHex(buf);
}

export async function hmacSha256Hex(key, message) {
  const k = await crypto.subtle.importKey('raw', te.encode(String(key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, te.encode(String(message)));
  return toHex(sig);
}

// 签名规范串（面板与扩展必须完全一致）
export function canonicalString(method, path, ts, nonce, bodyHashHex) {
  return [String(method).toUpperCase(), path, String(ts), String(nonce), String(bodyHashHex)].join('\n');
}

// 客户端用：生成一组签名头（扩展里另有等价实现，勿单独改一处）
export async function signRequest(key, { method, path, body = '', ts, nonce }) {
  const t = String(ts || Date.now());
  const n = nonce || randomNonce();
  const bodyHash = await sha256Hex(body);
  const sign = await hmacSha256Hex(key, canonicalString(method, path, t, n, bodyHash));
  return { 'X-Api-Key': key, 'X-Ts': t, 'X-Nonce': n, 'X-Sign': sign };
}

// 面板用：取共享密钥（Cloudflare Secret 优先，其次 D1 设置）
export async function getExternalKey(env, db) {
  if (env && env.EXTERNAL_API_KEY) return String(env.EXTERNAL_API_KEY);
  try {
    const { getSetting } = await import('../db.js');
    return (await getSetting(db, 'external_api_key')) || '';
  } catch {
    return '';
  }
}

// 校验一个外部请求。
// opts.getRawBody: () => Promise<string>  取原始请求体文本（签名要覆盖 body）
// opts.requireSign: 强制签名（不传则读 D1 设置 ext_require_sign）
// 返回 { ok, signed?, status?, error? }
export async function verifyExternalRequest(req, env, db, opts = {}) {
  const key = await getExternalKey(env, db);
  if (!key) return { ok: false, status: 500, error: '面板尚未配置外部 API Key（请在面板设置页生成）' };

  const given = req.headers.get('X-Api-Key') || '';
  if (!safeEqual(given, key)) return { ok: false, status: 401, error: '无效的 API Key' };

  let requireSign = opts.requireSign;
  if (requireSign == null) {
    try {
      const { getSetting } = await import('../db.js');
      requireSign = (await getSetting(db, 'ext_require_sign')) === '1';
    } catch {
      requireSign = false;
    }
  }

  const sign = (req.headers.get('X-Sign') || '').trim();
  if (!sign) {
    if (requireSign) {
      return { ok: false, status: 401, error: '该面板已开启签名校验，请把扩展升级到最新版并重新连接' };
    }
    return { ok: true, signed: false };
  }

  const ts = req.headers.get('X-Ts') || '';
  const nonce = req.headers.get('X-Nonce') || '';
  const tsNum = Number(ts);
  if (!tsNum || Math.abs(Date.now() - tsNum) > MAX_SKEW_MS) {
    return { ok: false, status: 401, error: '请求时间戳超出允许范围，请检查设备时间是否准确' };
  }
  if (!nonce || nonce.length > 64) return { ok: false, status: 401, error: '请求缺少有效 nonce' };

  let raw = '';
  try {
    raw = opts.getRawBody ? await opts.getRawBody() : '';
  } catch {
    raw = '';
  }
  const bodyHash = await sha256Hex(raw);
  const expect = await hmacSha256Hex(key, canonicalString(req.method, new URL(req.url).pathname, ts, nonce, bodyHash));
  if (!safeEqual(sign.toLowerCase(), expect)) {
    return { ok: false, status: 401, error: '签名校验失败（Key 不一致或请求被篡改）' };
  }

  // 防重放：同一个 nonce 只能用一次。表不可用时降级为「不校验重放」，
  // 不影响正常使用（时间戳窗口仍能挡住大部分重放）。
  try {
    const now = Date.now();
    const r = await db.prepare('INSERT OR IGNORE INTO api_nonces(nonce, created_at) VALUES(?,?)').bind(nonce, now).run();
    const changes = r && r.meta && typeof r.meta.changes === 'number' ? r.meta.changes : 1;
    if (changes === 0) return { ok: false, status: 401, error: '请求已被使用过（nonce 重复），请勿重放旧请求' };
    await db.prepare('DELETE FROM api_nonces WHERE created_at < ?').bind(now - NONCE_TTL_MS).run().catch(() => {});
  } catch { /* 忽略 nonce 表不可用 */ }

  return { ok: true, signed: true };
}
