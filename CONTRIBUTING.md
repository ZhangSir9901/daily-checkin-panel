# 贡献指南（CONTRIBUTING）

感谢愿意一起把这个面板做厚一点。三条最常走的路，选一条就行：

| 我想… | 怎么做 | 需要会写代码吗 |
|---|---|---|
| **加一个网站的签到** | 在自己的面板里用「自定义 HTTP」多步录制调通 → 导出为社区配置 → 提 PR 到 `community/sites/` | ❌ 不用，填表格即可 |
| **修站点改版** | 站点改版后配置失效 → 重录一遍 → 覆盖 `community/sites/` 里那份旧配置 | ❌ 不用 |
| **改面板本身** | 改 `src/` 或 `public/index.html` → 跑 `node tools/verify.mjs` → 提 PR | ✅ 会 JS |

---

## 一、零代码贡献：交一份站点适配

这是本项目最需要的贡献。**别人不会再为了同一个网站重复踩坑。**

1. 面板 → 账号页 → 「添加账号」→ 站点选 **自定义 HTTP** → **多步录制**
   - 在电脑浏览器人工登录该网站、完成一次真实签到
   - F12 → 网络面板 → 对流程里每个请求「复制为 cURL」→ 每步点「从 cURL 填入」
   - 需要跨步骤传值的（先登录拿 token 再签到）用「提取变量」，如 `token=data.token`，下一步用 `{{token}}` 引用
   - 点「测试运行」确认整条链路能跑通
2. 回到 **🌍 社区站点（开源共享）** 卡片 → 「导出我的配置」→ 选这个账号 → 导出
   - 面板会自动做三件事：凭据换成 `{{cookie}}` 占位符、域名换成 `{{site_url}}`、按用到的占位符倒推 `fields`
3. 把 JSON 存成 `community/sites/<域名用下划线>.json`，在 `community/index.json` 里加一条，开 PR

**PR 检查清单**

- [ ] 文件里**没有任何真实凭据**（Cookie / token / 密码 / 密钥）；`grep` 一下自己都看不懂的长字符串
- [ ] `id` 用站点域名（如 `bbs_example_com`），不与 `src/sites/` 里的内置 id 冲突
- [ ] `name` / `desc` / `tips` 写清楚，`author` 填你的 GitHub ID，`version` 从 `1.0.0` 起
- [ ] 站点屏蔽机房 IP（403 WAF、要 IPv6、要人机验证）→ `execution` 写 `"browser"`（= 本地网络，需浏览器扩展在线）
- [ ] 在面板里「校验预览」能看到「校验通过」

安全底线：**配置是公开分享物，任何情况下都不允许带别人的 Cookie。** 面板的 `validateSiteConfig`
会直接拒绝带明文凭据的配置，`test/community.test.mjs` 里有对应的断言。

## 二、改代码

```bash
node tools/verify.mjs        # 必须全绿：语法 / HTML 配对 / DOM 引用 / 内联 JS / 15 个测试文件
node tools/gen-ui-preview.mjs # 生成 ../../_preview/ui.html，用浏览器看排版（不部署也能看）
```

约定：

- 站点模块放 `src/sites/<id>.js`，导出 `{ id, name, fields, execution, run }`，并在 `src/sites/index.js` 注册
- **不要让面板报假的「签到成功」**：只有站点自己说成功才算成功；站点说「今日已签到」按已签到处理（`src/lib/signals.js`）
- 站点有独立日界时区的（例如按 UTC 计日），在模块里声明 `dayTz`，否则面板状态列会显示假状态
- 改 `public/index.html` 后**一定**要跑 `node tools/check-dom-refs.mjs`：顶格 `$('x').onclick = ...` 引用的 id 必须存在于静态 HTML，否则整段脚本会静默中断

## 三、报 Bug / 提需求

开 Issue 时带上这几样，能省掉一轮来回：

- 面板版本 / 站点名 / 执行模式（CF 网络 还是 本地网络）
- 「网站反馈」列里的**原文**（站点到底回了什么），以及网站上的真实状态
- 浏览器扩展是否在线

## 许可

提交即同意以本仓库的 MIT 许可发布你的贡献。
