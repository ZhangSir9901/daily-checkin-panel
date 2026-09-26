// 推送通知：Telegram Bot / Bark / 通用 Webhook。
// 配置保存在 D1 settings 表，密钥字段读取时脱敏。

import { getSetting, setSetting } from './db.js';

const FIELDS = ['enabled', 'telegram_bot_token', 'telegram_chat_id', 'bark_key', 'bark_server', 'webhook_url'];
const SECRETS = new Set(['telegram_bot_token', 'bark_key', 'webhook_url']);

export async function getNotifyConfig(db) {
  const cfg = {};
  for (const f of FIELDS) cfg[f] = (await getSetting(db, 'notify.' + f)) || '';
  const out = {};
  for (const f of FIELDS) {
    if (SECRETS.has(f)) {
      out[f] = '';
      out[f + '_set'] = cfg[f] ? true : false;
    } else {
      out[f] = cfg[f];
    }
  }
  return out;
}

export async function setNotifyConfig(db, b = {}) {
  await setSetting(db, 'notify.enabled', b.enabled ? '1' : '0');
  for (const f of ['telegram_chat_id', 'bark_server']) {
    if (b[f] !== undefined) await setSetting(db, 'notify.' + f, String(b[f]));
  }
  // 密钥类字段：传空表示保留旧值
  for (const f of SECRETS) {
    if (b[f]) await setSetting(db, 'notify.' + f, String(b[f]));
  }
}

export async function sendNotify(env, db, title, body) {
  const raw = {};
  for (const f of FIELDS) raw[f] = (await getSetting(db, 'notify.' + f)) || '';
  if (raw.enabled !== '1') return;

  const tasks = [];

  if (raw.telegram_bot_token && raw.telegram_chat_id) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${raw.telegram_bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: raw.telegram_chat_id, text: `${title}\n\n${body}` }),
      }).catch(() => {})
    );
  }

  if (raw.bark_key) {
    const server = (raw.bark_server || 'https://api.day.app').replace(/\/+$/, '');
    tasks.push(
      fetch(`${server}/${raw.bark_key}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`).catch(() => {})
    );
  }

  if (raw.webhook_url) {
    tasks.push(
      fetch(raw.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      }).catch(() => {})
    );
  }

  await Promise.all(tasks);
}
