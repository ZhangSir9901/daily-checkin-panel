// 推送通知：Telegram Bot / Bark / 通用 Webhook。
//
// 设计要点（都是为了「填进去就能用」）：
//   1. 密钥类字段（Bot Token / Bark Key / Webhook 地址）**加密后再存 D1**，
//      读取时接口只回「是否已设置」，不把原文发给浏览器。
//   2. 每次发送都会**看网站的真实回执**：Telegram 返回 ok:false 时会把它的 description
//      翻译成一句能照着做的话（例如「找不到 Chat ID → 先给 Bot 发一条消息」），
//      不再像以前那样 .catch(() => {}) 把失败吞掉。
//   3. 所有请求都带超时：某个渠道卡住时，不能把整轮签到拖到超时。

import { getSetting, setSetting } from './db.js';
import { encryptJSON, decryptJSON } from './crypto.js';

const FIELDS = ['enabled', 'telegram_bot_token', 'telegram_chat_id', 'bark_key', 'bark_server', 'webhook_url'];
const SECRETS = new Set(['telegram_bot_token', 'bark_key', 'webhook_url']);

export const TELEGRAM_API = 'https://api.telegram.org';

// ---------- 表单校验（面板保存前先挡住明显填错的） ----------

// Bot Token 形如 123456789:AAE...（前半是数字，后半一段不定的字符）
export function validTelegramToken(t) {
  return /^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(String(t == null ? '' : t).trim());
}

// Chat ID 可以是数字（含负数，群/频道是负的），也可以是 @频道名
export function validTelegramChatId(c) {
  const s = String(c == null ? '' : c).trim();
  if (!s) return false;
  if (/^-?\d{1,20}$/.test(s)) return true;
  return /^@[A-Za-z0-9_]{4,32}$/.test(s);
}

// 把 Telegram 的英文错误翻成「下一步该做什么」
export function describeTelegramError(desc) {
  const d = String(desc == null ? '' : desc);
  const low = d.toLowerCase();
  if (!d) return 'Telegram 没有返回具体原因（请检查服务器出口是否可达 api.telegram.org）';
  if (low.includes('chat not found')) {
    return '找不到这个 Chat ID。请先在 Telegram 里给这个 Bot 发一条消息（群的话先把 Bot 拉进群并设为管理员），再点「自动获取 Chat ID」';
  }
  if (low.includes('unauthorized') || low.includes('invalid token')) return 'Bot Token 不正确（去 @BotFather 复制完整的一串，形如 123456:AA...）';
  if (low.includes('bot was blocked') || low.includes('user is deactivated')) return '你把这个 Bot 拉黑/停用了，先在 Telegram 里解除';
  if (low.includes('not enough rights') || low.includes('not enough privileges')) return 'Bot 在这个群里没有发言权限，请把它设为管理员或允许发消息';
  if (low.includes('chat_id is empty')) return 'Chat ID 是空的，请填写或点「自动获取 Chat ID」';
  if (low.includes('too many requests')) return '发送太频繁被 Telegram 限流了，等一会儿再试';
  if (low.includes('but the bot') && low.includes('administrator')) return '这个 Bot 必须是频道管理员才能发言，请切换为管理员后再试';
  return 'Telegram 拒绝了这次发送：' + d;
}

const TIMEOUT_MS = 12000;

async function fetchWithTimeout(url, init = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  const race = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { if (ctrl) ctrl.abort(); } catch { /* 忽略 */ }
      reject(new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒没有响应）'));
    }, timeoutMs);
  });
  try {
    const init2 = ctrl ? { ...init, signal: ctrl.signal } : init;
    return await Promise.race([fetch(url, init2), race]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 三个通道 ----------

// 发一条 Telegram 消息。返回 { ok, error? }
export async function sendTelegram(token, chatId, title, body) {
  const t = String(token || '').trim();
  const c = String(chatId || '').trim();
  if (!t) return { ok: false, error: '没有填写 Bot Token' };
  if (!c) return { ok: false, error: '没有填写 Chat ID' };
  const text = String(body || '').trim() ? `${title}\n\n${body}` : String(title || '');
  try {
    const res = await fetchWithTimeout(`${TELEGRAM_API}/bot${t}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: c, text, disable_web_page_preview: true }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok === true) return { ok: true };
    if (!data) return { ok: false, error: `Telegram 返回 HTTP ${res.status}，且响应不是 JSON（地址或网络被拦）` };
    return { ok: false, error: describeTelegramError(data.description) };
  } catch (e) {
    return { ok: false, error: '连不上 Telegram：' + String((e && e.message) || e) };
  }
}

// 读取这个 Bot 最近收到的会话，用来「自动获取 Chat ID」。
// 返回 { ok, chats: [{id, title, type}], error? }
export async function telegramChats(token) {
  const t = String(token || '').trim();
  if (!t) return { ok: false, chats: [], error: '请先填写 Bot Token' };
  try {
    const res = await fetchWithTimeout(`${TELEGRAM_API}/bot${t}/getUpdates?limit=100`, { method: 'GET' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      return { ok: false, chats: [], error: describeTelegramError(data && data.description) };
    }
    const seen = new Map();
    for (const u of data.result || []) {
      const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member || null;
      const chat = msg && msg.chat;
      if (!chat || chat.id == null) continue;
      const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id);
      seen.set(String(chat.id), { id: chat.id, title, type: chat.type || '' });
    }
    const chats = Array.from(seen.values());
    if (!chats.length) {
      return { ok: true, chats: [], error: '这个 Bot 还没有收到过任何消息。请在 Telegram 里给它发一句「hi」（群/频道请先把 Bot 拉进去发一条），再点一次' };
    }
    return { ok: true, chats };
  } catch (e) {
    return { ok: false, chats: [], error: '连不上 Telegram：' + String((e && e.message) || e) };
  }
}

export async function sendBark(server, key, title, body) {
  if (!key) return { ok: false, error: '没有填写 Bark Key' };
  const base = String(server || 'https://api.day.app').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'Bark 服务器要以 http(s):// 开头' };
  try {
    const res = await fetchWithTimeout(`${base}/${encodeURIComponent(key)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`, { method: 'GET' });
    if (!res.ok) return { ok: false, error: `Bark 返回 HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (data && data.code != null && Number(data.code) !== 200) return { ok: false, error: 'Bark 返回：' + (data.message || data.code) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '连不上 Bark：' + String((e && e.message) || e) };
  }
}

export async function sendWebhook(url, title, body) {
  if (!url) return { ok: false, error: '没有填写 Webhook 地址' };
  if (!/^https?:\/\//i.test(String(url))) return { ok: false, error: 'Webhook 地址要以 http(s):// 开头' };
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) return { ok: false, error: `Webhook 返回 HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Webhook 请求失败：' + String((e && e.message) || e) };
  }
}

// ---------- 配置读写（密钥加密落库） ----------

function asPlainKey(field) {
  return 'notify.' + field;
}

async function readSecret(env, db, field) {
  const raw = (await getSetting(db, asPlainKey(field))) || '';
  if (!raw) return '';
  // 老版本把密钥直接明文写在 settings 里：读到明文就照常用（不回写、不报错）
  if (!String(raw).startsWith('gcm1.')) return String(raw);
  try {
    const obj = await decryptJSON(env, db, raw);
    return String((obj && obj.v) || '');
  } catch {
    return '';
  }
}

async function writeSecret(env, db, field, value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return;
  await setSetting(db, asPlainKey(field), await encryptJSON(env, db, { v }));
}

export async function clearNotifyField(env, db, field) {
  if (!SECRETS.has(field)) return;
  await setSetting(db, asPlainKey(field), '');
}

// 读取原始配置（内部用：拿得到明文）
export async function readNotifyRaw(env, db) {
  const out = {};
  out.enabled = (await getSetting(db, 'notify.enabled')) || '';
  out.telegram_chat_id = (await getSetting(db, 'notify.telegram_chat_id')) || '';
  out.bark_server = (await getSetting(db, 'notify.bark_server')) || '';
  out.telegram_bot_token = await readSecret(env, db, 'telegram_bot_token');
  out.bark_key = await readSecret(env, db, 'bark_key');
  out.webhook_url = await readSecret(env, db, 'webhook_url');
  return out;
}

// 给面板看的配置：密钥只回「是否已设置」
export async function getNotifyConfig(env, db) {
  const cfg = await readNotifyRaw(env, db);
  const out = {};
  for (const f of FIELDS) {
    if (SECRETS.has(f)) {
      out[f] = '';
      out[f + '_set'] = cfg[f] ? true : false;
    } else {
      out[f] = cfg[f];
    }
  }
  // 给面板用来显示「现在能不能收到消息」
  out.telegram_ready = !!(cfg.telegram_bot_token && cfg.telegram_chat_id);
  out.channels = [];
  if (cfg.telegram_bot_token && cfg.telegram_chat_id) out.channels.push('Telegram');
  if (cfg.bark_key) out.channels.push('Bark');
  if (cfg.webhook_url) out.channels.push('Webhook');
  return out;
}

export async function setNotifyConfig(env, db, b = {}) {
  if (b.enabled !== undefined) await setSetting(db, 'notify.enabled', b.enabled ? '1' : '0');
  for (const f of ['telegram_chat_id', 'bark_server']) {
    if (b[f] !== undefined) await setSetting(db, asPlainKey(f), String(b[f]).trim());
  }
  // 密钥类字段：不传就保留旧值；传了新的就覆盖
  for (const f of SECRETS) {
    if (b[f] !== undefined && String(b[f]).trim()) await writeSecret(env, db, f, b[f]);
  }
  // 显式清除（面板上的「清除」按钮）：clear: ['telegram_bot_token']
  if (Array.isArray(b.clear)) {
    for (const f of b.clear) await clearNotifyField(env, db, f);
  }
}

// ---------- 发送 ----------

// 发一条通知到所有已配置的渠道。
// 绝不抛异常（定时任务里不能因为一个 webhook 挂住就整轮失败）；
// 返回 { sent, results } 供面板展示每条通道的真实结果。
export async function sendNotifyDetailed(env, db, title, body, opts = {}) {
  const raw = await readNotifyRaw(env, db);
  const results = [];
  const onlyTelegram = !!opts.telegramOnly;
  if (!onlyTelegram && raw.enabled !== '1') return { sent: 0, skipped: 'disabled', results };

  if (raw.telegram_bot_token && raw.telegram_chat_id) {
    results.push({ channel: 'Telegram', ...(await sendTelegram(raw.telegram_bot_token, raw.telegram_chat_id, title, body)) });
  }
  if (!onlyTelegram && raw.bark_key) {
    results.push({ channel: 'Bark', ...(await sendBark(raw.bark_server, raw.bark_key, title, body)) });
  }
  if (!onlyTelegram && raw.webhook_url) {
    results.push({ channel: 'Webhook', ...(await sendWebhook(raw.webhook_url, title, body)) });
  }

  const sent = results.filter((r) => r.ok).length;
  for (const r of results) {
    if (!r.ok) console.error('[notify] ' + r.channel + ' 发送失败：' + r.error);
  }
  if (!results.length) return { sent: 0, skipped: 'no-channel', results };
  return { sent, results };
}

// 兼容旧调用（定时任务/日报）：只关心「发没发出去」，不关心细节
export async function sendNotify(env, db, title, body) {
  const r = await sendNotifyDetailed(env, db, title, body);
  return r;
}
