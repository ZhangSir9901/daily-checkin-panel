// 统一「网站反馈识别器」
// ---------------------------------------------------------------------------
// 各站点签到后拿到的响应五花八门：JSON {code:0}、HTML 页面、Discuz 跳转页、
// WordPress admin-ajax JSON、V2Board {ret:1}、以及登录页/验证码页/WAF 页。
// 以前每个站点模块各写一套正则，既容易漏判，也会出现同一个含义给出不同文案。
//
// 这里把「网站反馈」归一成 8 种结果，站点模块只需调用 classifySignal(text)
// 就能得到一致判定，并按需叠加自己的精确规则。纯函数、零依赖，Worker / Node 均可运行。
//
// 用法：
//   import { classifySignal, toResult, OUTCOME } from '../lib/signals.js';
//   const sig = classifySignal(text, { status: res.status });
//   if (sig.outcome === OUTCOME.ALREADY) return { ok: true, message: '今日已签到' };
//
// 注意：识别是有意「保守」的——只有命中明确的短语才算数，避免把正常页面的
// 「登录」「签到」菜单误判成登录失效或成功。

export const OUTCOME = {
  SUCCESS: 'success', // 签到/领取成功
  ALREADY: 'already', // 今天已经签过，属正常
  NEED_LOGIN: 'need_login', // 未登录 / 会话失效
  CAPTCHA: 'captcha', // 人机验证 / 验证码 / CF 挑战
  WAF: 'waf', // 网站安全防护拦截（网宿 / CF WAF / 403）
  RATE_LIMIT: 'rate_limit', // 请求过于频繁
  PAUSED: 'paused', // 网站暂停签到
  UNKNOWN: 'unknown', // 无法判断
};

// 各结果的友好中文文案（面板日志/账号状态展示）
export const OUTCOME_TEXT = {
  [OUTCOME.SUCCESS]: '签到成功',
  [OUTCOME.ALREADY]: '今日已签到，无需重复',
  [OUTCOME.NEED_LOGIN]: '登录已失效，请重新获取 Cookie',
  [OUTCOME.CAPTCHA]: '遇到人机验证（验证码/滑块），需人工验证后更新 Cookie',
  [OUTCOME.WAF]: '遇到网站安全验证（WAF），请用浏览器完成验证后更新 Cookie',
  [OUTCOME.RATE_LIMIT]: '请求过于频繁，稍后再试',
  [OUTCOME.PAUSED]: '网站暂停签到，等恢复后再试',
  [OUTCOME.UNKNOWN]: '',
};

// 需要「人工去浏览器处理」的结果：面板会提示用户去登录/过验证
export const NEEDS_HUMAN = [OUTCOME.NEED_LOGIN, OUTCOME.CAPTCHA, OUTCOME.WAF];

// ---------------------------------------------------------------------------
// 短语表：顺序即优先级（先匹配到的结果胜出）。
// 原则：先判「被拦截/需人工」（WAF/验证码/限流/暂停），再判登录失效，
// 最后才判成功/已签到——因为被拦截的页面里也常带「登录」「签到」字样。
// ---------------------------------------------------------------------------
const RULES = [
  {
    outcome: OUTCOME.WAF,
    marks: [
      // 注意：不放「请完成安全验证」这类通用短语，它们更常出现在人机验证页，归入 CAPTCHA
      'waf_zw_verify', 'WZWS_CONFIRM_PREFIX_LABEL', '安全检查中',
      'Request blocked', 'Access Denied', '403 Forbidden', '拒绝访问', '您的请求被拦截',
      'blocked by security', 'Attention Required',
    ],
  },
  {
    outcome: OUTCOME.CAPTCHA,
    marks: [
      '验证码', '人机验证', '智能验证', '滑动验证', '滑块', '安全验证', '请完成验证',
      '拖动滑块', '请按住滑块', 'slidercaptcha', 'geetest', '极验', 'recaptcha',
      'hcaptcha', 'turnstile', 'cf-chl', 'challenge-platform', 'Just a moment',
      'verify you are human', 'checking your browser', '点击验证', '点选验证',
      // 腾讯天御 / ibex 行为验证（起点等站点用；见 52pojie 起点签到帖的实测）
      'turing.captcha.qcloud.com', 'TCaptcha', 'CaptchaAId', 'CaptchaType', 'ibex', '天御', '行为验证',
    ],
  },
  {
    outcome: OUTCOME.PAUSED,
    marks: ['暂停签到', '签到暂停', '暂停每日签到', '签到功能维护', '暂未开放签到', '每日签到维护'],
  },
  {
    outcome: OUTCOME.RATE_LIMIT,
    marks: ['请求过于频繁', '操作过于频繁', '操作太频繁', '访问过于频繁', '请求太频繁', '频率限制', 'too many requests', 'rate limit'],
  },
  {
    outcome: OUTCOME.NEED_LOGIN,
    marks: [
      '请先登录', '需要先登录', '请登录后', '请您先登录', '还未登录', '您还没有登录', '你还没有登录',
      '尚未登录', '登录已失效', '登录失效', '登录已过期', '登录状态已失效', '请重新登录',
      '未登录', '无权访问', '无权限访问', '请先登陆',
      'USER NOT FOUND', 'not logged in', 'please log in', 'please login', 'session expired', 'unauthorized',
    ],
  },
  {
    outcome: OUTCOME.ALREADY,
    marks: [
      '今日已签到', '今天已签到', '今日已经签到', '已经签到', '已签到', '重复签到', '请勿重复',
      '无需重复', '不能重复签到',      '明日再来', '下期再来', '已经领取', '已领取', '今日已领取',
      // Discuz 任务插件：重复申请时返回「抱歉，您已完成过此任务」
      '您已完成过此任务', '已完成过此任务',
      'already signed', 'already checked in', 'already claimed',
    ],
  },
  {
    outcome: OUTCOME.SUCCESS,
    marks: [
      '签到成功', '打卡成功', '签到完毕', '签到完成', '已完成签到', '已连续签到', '领取成功',
      '成功领取', '领取奖励成功', '任务已完成', '签到获得', '恭喜', '获得',
    ],
  },
];

// 奖励提取：从成功文案里挑出「获得 X」这类内容，用于日志「获得了什么」
const REWARD_RES = [
  /获得\s*([+＋]?\d+(?:\.\d+)?\s*(?:个)?\s*(?:鸡腿|积分|金币|铜币|银币|AK币|吾爱币|热心值|空间|MB|GB|M|G|天|点)?)/,
  /[+＋]\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(鸡腿|积分|金币|铜币|银币|AK币|吾爱币|热心值|空间|MB|GB|M|G)/,
  /(?:领取|抽取)了?\s*([^\s，。;；、]{1,16})/,
];

function asText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

// 从任意响应内容里提取奖励文案（提取不到返回 ''）
export function extractReward(input) {
  const text = asText(input);
  for (const re of REWARD_RES) {
    const m = text.match(re);
    if (m && m[1]) {
      const v = String(m[1]).trim();
      if (v && v.length <= 24) return v;
    }
  }
  return '';
}

// 核心：把网站反馈文本归类为 OUTCOME 之一。
// text 可为字符串或对象（对象会被 JSON 序列化后再匹配）。
// opts.status：可选 HTTP 状态码，仅在文本无法判断时作为弱线索。
export function classifySignal(input, opts = {}) {
  const text = asText(input);
  const status = Number(opts.status) || 0;

  for (const rule of RULES) {
    for (const mark of rule.marks) {
      const hit = mark.length > 2 && /[\u4e00-\u9fa5]/.test(mark)
        ? text.includes(mark) // 中文短语直接包含匹配
        : new RegExp(escapeRe(mark), 'i').test(text); // 英文/混合短语忽略大小写
      if (hit) {
        return {
          outcome: rule.outcome,
          label: OUTCOME_TEXT[rule.outcome],
          reward: rule.outcome === OUTCOME.SUCCESS ? extractReward(text) : '',
        };
      }
    }
  }

  // 文本没线索时，用 HTTP 状态码兜底
  if (status === 429) return { outcome: OUTCOME.RATE_LIMIT, label: OUTCOME_TEXT[OUTCOME.RATE_LIMIT], reward: '' };
  if (status === 401) return { outcome: OUTCOME.NEED_LOGIN, label: OUTCOME_TEXT[OUTCOME.NEED_LOGIN], reward: '' };
  if (status === 403) return { outcome: OUTCOME.WAF, label: OUTCOME_TEXT[OUTCOME.WAF], reward: '' };

  return { outcome: OUTCOME.UNKNOWN, label: '', reward: '' };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 该结果是否算「签到完成」（成功或今日已签都算完成，不需要再重试）
export function isDone(outcome) {
  return outcome === OUTCOME.SUCCESS || outcome === OUTCOME.ALREADY;
}

export function needsHuman(outcome) {
  return NEEDS_HUMAN.includes(outcome);
}

// 把识别结果转成可直接使用的返回值：
//   { ok, message, outcome, reward, needsHuman }
// extraMessage：站点自己更精确的文案，优先级高于通用文案（但仍保留 outcome 便于面板判断）。
export function toResult(input, opts = {}) {
  const sig = classifySignal(input, opts);
  const reward = sig.reward;
  let message = opts.message || sig.label;
  if (opts.prefix) message = opts.prefix + message;
  if (reward && opts.appendReward !== false && !message.includes(reward)) {
    message = message ? `${message}（获得 ${reward}）` : `获得 ${reward}`;
  }
  return {
    ok: isDone(sig.outcome),
    message,
    outcome: sig.outcome,
    reward,
    needsHuman: needsHuman(sig.outcome),
  };
}

// 供站点模块在「失败/未知」分支统一收尾：命中明确结果时抛出友好错误，
// 否则用站点自己的兜底文案抛出。异常上带 outcome 字段，便于上层区分处理。
export function failWith(input, opts = {}) {
  const sig = classifySignal(input, opts);
  if (isDone(sig.outcome)) return toResult(input, opts); // 交给调用方当成功处理
  const message = opts.fallback || sig.label || '签到失败，未识别到成功标识';
  const err = new Error(opts.prefix ? opts.prefix + message : message);
  err.outcome = sig.outcome;
  if (opts.detail) err.detail = opts.detail;
  throw err;
}
