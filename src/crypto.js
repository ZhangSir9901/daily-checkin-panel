// 密码哈希（PBKDF2）与账号凭据加密（AES-GCM），均使用 WebCrypto，零依赖。

const te = new TextEncoder();
const td = new TextDecoder();

export function b64encode(bytes) {
  const b = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function b64decode(s) {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

// 常量时间比较：密码哈希、密钥这类东西不能用 === 比（=== 会在第一个不同的字节就返回，
// 理论上可以被逐个字节地「猜」出来）。这里长度不同也照样跑完整个循环。
export function timingSafeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// 单次 PBKDF2 的最大输入长度。密码框可以随便长，但不能让人拿一个几百 MB 的字符串
// 把 Worker 的 CPU 时间打满（每次登录都要跑 10 万次迭代）。
const MAX_PASSWORD_LEN = 256;

export function cleanPassword(p) {
  return String(p == null ? '' : p).slice(0, MAX_PASSWORD_LEN);
}

export function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------- 管理员密码 ----------

export async function hashPassword(password) {
  const pw = cleanPassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  // 注意：Cloudflare Workers 的 WebCrypto 最高只支持 100000 次迭代
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2$100000$${b64encode(salt)}$${b64encode(bits)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10);
    const salt = b64decode(parts[2]);
    // 迭代次数来自库里的字符串，夹一个上限：万一这条记录被改写成天文数字，
    // 也不能让每一次登录请求都把 Worker 的 CPU 预算烧光。
    if (!Number.isFinite(iterations) || iterations < 1 || iterations > 1000000) return false;
    const key = await crypto.subtle.importKey('raw', te.encode(cleanPassword(password)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      256
    );
    return timingSafeEqual(b64encode(bits), parts[3]);
  } catch {
    return false;
  }
}

// ---------- 账号凭据加密 ----------
// 密钥来源（按优先级）：
// 1. Worker Secret ENCRYPT_KEY（32 字节 base64，推荐：openssl rand -base64 32）
// 2. 首次使用时自动生成并存入 D1 settings 表

async function getEncKey(env, db) {
  if (env.ENCRYPT_KEY) {
    // Secret 填错（长度不对 / 不是合法 base64）时要给一句能看懂的话。
    // 以前直接 b64decode：atob 会抛「The string to be decoded is not correctly encoded」——
    // 用户设置里看到这个只会一头雾水，而它会在每一次解密账号凭据时都出现。
    let raw = null;
    try { raw = b64decode(String(env.ENCRYPT_KEY)); } catch { raw = null; }
    if (!raw || raw.length !== 32) {
      throw new Error('ENCRYPT_KEY 必须是 32 字节的 base64 字符串（用 openssl rand -base64 32 生成后填进 Worker Secret）');
    }
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  const row = await db.prepare("SELECT value FROM settings WHERE key='enc_key'").first();
  if (row) return crypto.subtle.importKey('raw', b64decode(row.value), 'AES-GCM', false, ['encrypt', 'decrypt']);
  // 【并发】新建库的第一次使用：几个请求可能同时走到这里（面板轮询 + 定时任务 + 你正点「保存账号」）。
  // 直接用 INSERT 的话，后到的那个必然撞上主键冲突、整个请求 500 ——
  // 而且**两把不同的 key 会被先后写进去**的先例，取决于谁先成功。
  // 所以：INSERT OR IGNORE 之后**回头再读一次**，让双方最终都用库里那把 key。
  const raw = crypto.getRandomValues(new Uint8Array(32));
  await db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('enc_key', ?)").bind(b64encode(raw)).run();
  const again = await db.prepare("SELECT value FROM settings WHERE key='enc_key'").first();
  const stored = (again && again.value) || b64encode(raw);
  return crypto.subtle.importKey('raw', b64decode(stored), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJSON(env, db, obj) {
  const key = await getEncKey(env, db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
  return `gcm1.${b64encode(iv)}.${b64encode(ct)}`;
}

// 把密钥单独取出来一次，供**多次**解密复用。
// 为什么需要：账号列表要顺带算「凭据到期时间」（鼠标悬浮站点名可见），
// 那就得把每个账号的凭据都解开；而 getEncKey 在没配 ENCRYPT_KEY 时会回库读一次 enc_key，
// 十个账号就是十次多余的查询。取一次、传给 decryptJSONWith 即可。
export async function accountKey(env, db) {
  return getEncKey(env, db);
}

export async function decryptJSONWith(key, str) {
  const parts = String(str || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'gcm1') throw new Error('凭据数据格式异常');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(parts[1]) },
    key,
    b64decode(parts[2])
  );
  return JSON.parse(td.decode(pt));
}

export async function decryptJSON(env, db, str) {
  return decryptJSONWith(await getEncKey(env, db), str);
}
