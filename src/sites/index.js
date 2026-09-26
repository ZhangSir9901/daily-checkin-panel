// 站点模块注册表。新增签到站点时：
// 1. 在 src/sites/ 下新建 <site>.js，导出 { id, name, desc, fields, tips, run }
// 2. 在此注册，Web 界面会自动出现新站点的添加表单。

import { quark } from './quark.js';
import { cloud189 } from './cloud189.js';
import { httpTask } from './http.js';
import { nodeseek } from './nodeseek.js';

export const SITES = [quark, cloud189, nodeseek, httpTask];

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
  }));
}
