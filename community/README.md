# 社区站点适配（community）

面板**内置**的站点写在 `src/sites/*.js` 里；这份目录放的是**社区贡献**的站点适配 ——
一份 JSON 描述「怎么给这个网站签到」，任何人导入后就能用，**不用改代码、不用重新部署**。

> 一句话：**你调通一个网站，导出一段 JSON 发出来，别人就多一个能签的站。**

---

## 目录结构

```
community/
├── README.md          ← 你在看的这份
├── index.json         ← 已收录配置的索引（面板「导入」框可以吃这里的 raw 链接）
└── sites/
    ├── _template.json              ← 模板：照着填就能做一个新站点
    ├── simple-api-signin.json      ← 示例：单次 GET/POST 签到
    └── discuz-signin-template.json ← 示例：两步（先取 formhash，再提交）
```

## 怎么用（使用者）

1. 打开面板 → 账号页 → **🌍 社区站点（开源共享）** 卡片
2. 把 `community/sites/xxx.json` 的 **raw 链接**粘到「或：配置的原始链接」输入框 →
   **🔎 校验预览**（先看清它是什么、要填什么）→ **⬇️ 导入**
3. 回到「添加账号」，站点下拉里会多出这个站（带 🌍 社区 标记）→ 填 Cookie 保存即可

也可以直接把 JSON 全文粘进那个文本框导入。

## 怎么贡献（作者）

1. 在自己的面板里 **添加账号 → 站点选「自定义 HTTP」→ 多步录制**：把你人工签到的过程
   （F12 网络面板里「复制为 cURL」）一步步录进去，点「测试运行」确认能跑通
2. 回到 **🌍 社区站点** 卡片 → 右侧「导出我的配置」→ 选这个账号 → **📤 导出为社区配置**
   - 面板会自动把真实 Cookie / token 换成 `{{cookie}}` 这样的**占位符**
   - 同时把 `https://你的站点域名/xxx` 换成 `{{site_url}}/xxx`，别人换成自己的域名也能用
3. 把导出的 JSON 放进这个目录（或直接开 Issue 贴出来），并更新 `index.json`
4. 开 PR。CI（`node tools/verify.mjs`）会跑校验，`test/community.test.mjs` 里有针对配置的安全断言

## 硬性要求（PR 会被打回的情形）

| 要求 | 说明 |
|---|---|
| **不能带任何凭据** | Cookie / token / 密码 / 密钥一律用 `{{占位符}}`。校验器会拦下明文凭据 |
| `id` 用站点域名 | 例如 `bbs_example_com`（2–40 位字母数字下划线短横线），避免和内置站点撞名 |
| 至少一个 `steps` | 配置就得能真的发出请求 |
| 建议写 `expect_status` / `expect_contains` | 不写就只能靠通用信号识别判成败 |
| `execution` 注明 | 站点屏蔽机房 IP（WAF 403、要 IPv6）→ 写 `"browser"`（= 本地网络，需扩展在线） |

## 配置字段速查

```jsonc
{
  "schema": "daily-checkin-site/1",   // 固定值
  "id": "bbs_example_com",            // 内码，唯一
  "name": "示例论坛",                  // 面板里显示的名字
  "desc": "每天签到领积分",
  "author": "你的 GitHub ID",
  "version": "1.0.0",
  "domain": "bbs.example.com",        // 扩展按它匹配域名（可留空）
  "execution": "server",              // server = CF 网络；browser = 本地网络（需扩展在线）
  "fields": [                         // 用户添加账号时要填的东西
    { "key": "site_url", "label": "站点地址", "type": "text",     "required": true,  "placeholder": "https://bbs.example.com" },
    { "key": "cookie",   "label": "Cookie",   "type": "textarea", "required": true },
    { "key": "user_agent","label": "User-Agent","type": "text",   "required": false }
  ],
  "steps": [                          // 按顺序执行；后一步能用前一步提取的变量
    {
      "name": "签到",
      "method": "POST",
      "url": "{{site_url}}/api/sign",
      "headers": { "Cookie": "{{cookie}}", "User-Agent": "{{user_agent}}" },
      "body": "a=1&b=2",
      "extract": { "token": "data.token" },   // 从 JSON 响应按点路径取值
      "expect_status": 200,
      "expect_contains": "成功"
    }
  ],
  "tips": "登录后用浏览器扩展「一键复制全部信息」，回面板 Ctrl+V 粘贴即自动保存。"
}
```

- 变量：`{{site_url}}` `{{cookie}}` `{{user_agent}}` 来自用户填的 `fields`；`{{token}}` 这类来自前面步骤的 `extract`。
- 请求头 / 请求体**写对象或字符串都行**（对象更适合手写，导出的是字符串形式）。
- `execution: "browser"` 的站点，请求会经用户的浏览器扩展发出（躲开机房 IP 封禁与人机验证）。

## 免责

这些配置是社区贡献的，站点改版后可能失效。失效时：在面板里直接用「自定义 HTTP」重新录一遍，
再把新配置导出、提 PR 覆盖旧版 —— 这就是这个目录存在的意义。
