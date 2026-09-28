// 统一网站反馈识别器测试：node test/signals.test.mjs（纯函数，不依赖网络）
import assert from 'node:assert/strict';
import { classifySignal, toResult, failWith, extractReward, isDone, OUTCOME, siteMessageFrom } from '../src/lib/signals.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('成功类文案 → success', () => {
  for (const s of ['签到成功', '任务已完成', '打卡成功，获得 5 个鸡腿', '恭喜您获得 10 铜币']) {
    assert.equal(classifySignal(s).outcome, OUTCOME.SUCCESS, s);
  }
});

t('重复/已领 → already', () => {
  for (const s of ['今日已签到', '您今天已经签到过了', '已签到，请勿重复', '抱歉，您已完成过此任务', '该奖励已领取']) {
    assert.equal(classifySignal(s).outcome, OUTCOME.ALREADY, s);
  }
});

t('未登录/会话失效 → need_login', () => {
  for (const s of ['请先登录', '登录已失效，请重新登录', '{"status":404,"message":"USER NOT FOUND"}', 'Unauthorized']) {
    assert.equal(classifySignal(s).outcome, OUTCOME.NEED_LOGIN, s);
  }
});

t('验证码类 → captcha（含腾讯天御/ibex/CF）', () => {
  for (const s of [
    '请输入验证码',
    '请完成安全验证',
    '<div class="slidercaptcha"></div>',
    '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>',
    '{"CaptchaURL":"https://turing.captcha.qcloud.com/TCaptcha.js","CaptchaAId":"198420051"}',
    'ibex verification required',
  ]) {
    assert.equal(classifySignal(s).outcome, OUTCOME.CAPTCHA, s);
  }
});

t('WAF 类 → waf', () => {
  for (const s of ['<html>waf_zw_verify</html>', 'WZWS_CONFIRM_PREFIX_LABEL', 'Access Denied', '403 Forbidden']) {
    assert.equal(classifySignal(s).outcome, OUTCOME.WAF, s);
  }
});

t('限流/暂停', () => {
  assert.equal(classifySignal('操作过于频繁，请稍后再试').outcome, OUTCOME.RATE_LIMIT);
  assert.equal(classifySignal('论坛暂停签到，开放注册期间').outcome, OUTCOME.PAUSED);
});

t('优先级：被拦截页面里夹带成功字样也判为拦截', () => {
  // 验证码页里可能同时出现「签到成功」的营销文案，应以 captcha 为准
  assert.equal(classifySignal('请完成安全验证后签到成功').outcome, OUTCOME.CAPTCHA);
  assert.equal(classifySignal('waf_zw_verify 签到成功').outcome, OUTCOME.WAF);
});

t('无线索的文本 → unknown，HTTP 状态码兜底', () => {
  assert.equal(classifySignal('lorem ipsum').outcome, OUTCOME.UNKNOWN);
  assert.equal(classifySignal('', { status: 429 }).outcome, OUTCOME.RATE_LIMIT);
  assert.equal(classifySignal('', { status: 401 }).outcome, OUTCOME.NEED_LOGIN);
  assert.equal(classifySignal('', { status: 403 }).outcome, OUTCOME.WAF);
});

t('对象入参会被 JSON 序列化后识别', () => {
  assert.equal(classifySignal({ success: false, message: '今日已签到' }).outcome, OUTCOME.ALREADY);
});

t('奖励提取', () => {
  assert.match(extractReward('签到成功，获得 5 个鸡腿'), /5/);
  assert.match(extractReward('签到成功 +10 铜币'), /10/);
  assert.equal(extractReward('签到成功'), '');
});

t('toResult：成功与已签到都算完成并附奖励', () => {
  const r = toResult('签到成功，获得 3 个鸡腿');
  assert.equal(r.ok, true);
  assert.equal(r.outcome, OUTCOME.SUCCESS);
  assert.match(r.message, /获得 3/);
  const a = toResult('今日已签到');
  assert.equal(a.ok, true);
  assert.equal(a.outcome, OUTCOME.ALREADY);
});

t('toResult：拦截/未登录不算完成，needsHuman 为真', () => {
  const c = toResult('<div class="slidercaptcha"></div>');
  assert.equal(c.ok, false);
  assert.equal(c.needsHuman, true);
  assert.match(c.message, /人机验证/);
  const l = toResult('请先登录');
  assert.equal(l.ok, false);
  assert.equal(l.needsHuman, true);
});

t('isDone 判定', () => {
  assert.equal(isDone(OUTCOME.SUCCESS), true);
  assert.equal(isDone(OUTCOME.ALREADY), true);
  assert.equal(isDone(OUTCOME.NEED_LOGIN), false);
});

t('failWith：命中明确结果时抛带 outcome 的错误', () => {
  const err = (() => { try { failWith('请先登录'); } catch (e) { return e; } return null; })();
  assert.ok(err instanceof Error);
  assert.equal(err.outcome, OUTCOME.NEED_LOGIN);
  assert.match(err.message, /登录/);
});

t('failWith：未知文本用站点兜底文案', () => {
  const err = (() => { try { failWith('lorem', { fallback: '未找到签到按钮' }); } catch (e) { return e; } return null; })();
  assert.equal(err.outcome, OUTCOME.UNKNOWN);
  assert.match(err.message, /未找到签到按钮/);
});

// ---------- 网站原话提取（面板「网站反馈」用） ----------
t('siteMessageFrom：抠出网站自己的那句话（message/msg/status_msg）', () => {
  assert.equal(siteMessageFrom('{"success":false,"message":"今天已完成签到，请勿重复操作"}'), '今天已完成签到，请勿重复操作');
  assert.equal(siteMessageFrom('{"status":"0","msg":"今日已签到，请明日再来"}'), '今日已签到，请明日再来');
  assert.equal(siteMessageFrom('{"status_code":0,"status_msg":"签到成功"}'), '签到成功');
  assert.equal(siteMessageFrom('这是一页 HTML，没有 JSON'), '');
  assert.equal(siteMessageFrom('', '兜底'), '兜底');
});

t('siteMessageFrom：还转义、只取第一段（把促销公告挡在外面）', () => {
  // 糊涂鳄返回的是全转义 JSON
  assert.equal(siteMessageFrom('{"status":"0","msg":"\\u4eca\\u65e5\\u5df2\\u7b7e\\u5230"}'), '今日已签到');
  // 机场的 msg 经常把整段促销公告一起塞进来
  const v2 = '{"ret":1,"msg":"您获得了 1.5GB 流量.\\n\\n🎉中秋活动 7.8 折"}';
  assert.equal(siteMessageFrom(v2), '您获得了 1.5GB 流量.');
});

console.log(`\n${n} 组通过`);
