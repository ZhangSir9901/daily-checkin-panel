// 站点模块注册表。新增签到站点时：
// 1. 在 src/sites/ 下新建 <site>.js，导出 { id, name, desc, fields, tips, run }
// 2. 在此注册，Web 界面会自动出现新站点的添加表单。

import { quark } from './quark.js';
import { cloud189 } from './cloud189.js';
import { httpTask } from './http.js';
import { nodeseek } from './nodeseek.js';
import { akile } from './akile.js';
import { v2ex } from './v2ex.js';
import { misign } from './misign.js';
import { kanxue } from './kanxue.js';
import { wuaipojie } from './wuaipojie.js';
import { v2board } from './v2board.js';
import { hutue } from './hutue.js';

export const SITES = [quark, cloud189, nodeseek, akile, v2ex, misign, kanxue, wuaipojie, v2board, hutue, httpTask];

export function getSite(id) {
  return SITES.find((s) => s.id === id);
}

// 登录协助提示：面板据此打开登录页、并提前告诉用户会遇到什么验证。
// 站点模块自身若有 login 字段，会覆盖这里的默认值。
const LOGIN_HINTS = {
  cloud189: { kind: 'password', captcha: 'maybe', url: 'https://cloud.189.cn/web/login.html', note: '若提示需要验证码，请先在官方 App/网页登录一次（关闭设备锁）' },
  quark: { kind: 'none', captcha: 'none', url: 'https://pan.quark.cn/', note: '无需登录：直接在手机上抓包填 kps/sign/vcode' },
  nodeseek: { kind: 'cookie', captcha: 'turnstile', url: 'https://www.nodeseek.com/signIn.html', note: '登录带 Cloudflare 人机验证，需人工完成后用扩展抓 Cookie' },
  akile: { kind: 'token', captcha: 'none', url: 'https://akile.ai/', note: '登录后从 localStorage 复制 akile-token' },
  v2ex: { kind: 'cookie', captcha: 'none', url: 'https://www.v2ex.com/signin', note: '' },
  misign: { kind: 'cookie', captcha: 'maybe', url: '', note: '登录页通常是「论坛地址/member.php?mod=logging&action=login」' },
  kanxue: { kind: 'cookie', captcha: 'maybe', url: 'https://bbs.kanxue.com/', note: '' },
  wuaipojie: { kind: 'cookie', captcha: 'slider', url: 'https://www.52pojie.cn/member.php?mod=logging&action=login', note: '需先过一次网宿滑块安全验证，再登录' },
  v2board: { kind: 'password', captcha: 'maybe', url: '', note: '用机场域名打开登录页' },
  hutue: { kind: 'cookie', captcha: 'maybe', url: '', note: '登录后页面右侧会出现签到悬浮窗，用扩展抓 Cookie 即可' },
  http: { kind: 'cookie', captcha: 'maybe', url: '', note: '' },
};

export function siteMeta() {
  return SITES.map((s) => {
    const hint = LOGIN_HINTS[s.id] || {};
    const own = s.login || {};
    return {
      id: s.id,
      name: s.name,
      desc: s.desc,
      fields: s.fields,
      tips: s.tips || '',
      toggles: s.toggles || [],
      execution: s.execution || 'server', // 默认执行模式
      domain: s.domain || '', // 浏览器执行时的目标域名
      hasBrowserScript: !!s.browserScript, // 是否有浏览器端签到脚本
      // 登录协助：面板用它渲染「去登录/验证」入口，扩展用它决定打开哪个地址
      login: {
        kind: own.kind || hint.kind || 'cookie', // cookie / token / password / none
        captcha: own.captcha || hint.captcha || 'maybe', // none / slider / turnstile / maybe
        url: own.url || hint.url || (s.domain ? 'https://' + s.domain + '/' : ''),
        note: own.note || hint.note || '',
      },
    };
  });
}

// 供外部（浏览器扩展）获取浏览器签到脚本，不暴露服务端逻辑
export function getBrowserScript(id) {
  const s = getSite(id);
  if (!s || !s.browserScript) return null;
  return { domain: s.domain || '', script: s.browserScript, navigateUrl: s.navigateUrl || '' };
}
