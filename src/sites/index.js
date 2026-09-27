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

export function siteMeta() {
  return SITES.map((s) => ({
    id: s.id,
    name: s.name,
    desc: s.desc,
    fields: s.fields,
    tips: s.tips || '',
    toggles: s.toggles || [],
    execution: s.execution || 'server', // 默认执行模式
    domain: s.domain || '', // 浏览器执行时的目标域名
    hasBrowserScript: !!s.browserScript, // 是否有浏览器端签到脚本
  }));
}

// 供外部（浏览器扩展）获取浏览器签到脚本，不暴露服务端逻辑
export function getBrowserScript(id) {
  const s = getSite(id);
  if (!s || !s.browserScript) return null;
  return { domain: s.domain || '', script: s.browserScript };
}
