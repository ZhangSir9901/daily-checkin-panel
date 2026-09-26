# 每日签到面板

一个跑在 Cloudflare 上的每日自动签到面板（Cloudflare Workers 原生）：**网页登录管理后台 + D1 存账号 + Cron 每天自动签到 + 推送通知**。零依赖，单 Worker 部署。

## 功能

- 🔐 **Web 管理后台**：首次打开设置管理密码（PBKDF2 存 D1），之后密码登录
- 👥 **多账号管理**：增删改、启用/停用、手动执行单个或全部
- ⏰ **签到时间设置**：网页「设置」里改每天几点执行（默认北京时间 08:00），即时生效，无需重新部署
- 🔀 **站点独立开关**：如 NodeSeek「试试手气 / 固定 5 鸡腿」，账号列表页直接点小按钮切换
- 🎬 **多步录制**：自定义 HTTP 支持按顺序执行多个请求（先登录拿 token 再签到），后一步用 `{{变量}}` 引用上一步响应的字段
- 📋 **一键取 Cookie**：生成小书签，拖到书签栏后在目标网站点一下，Cookie 自动传回面板填入
- 🗄️ **D1 存储**：账号凭据 AES-GCM 加密后存储，不落明文
- 📝 **运行日志**：每次执行结果、耗时、详情，保留最近 500 条
- 📣 **推送通知**：Telegram Bot / Bark / 通用 Webhook 推送签到日报
- 🧩 **可扩展站点**：内置模块，新增站点只需加一个 JS 文件

## 内置签到站点

| 站点 | 方式 | 凭据 |
|---|---|---|
| 夸克网盘 | 每日签到领空间 | 抓包获取 `kps` / `sign` / `vcode` |
| 天翼云盘 | 账号密码登录后签到 | 手机号 + 密码（登录态自动缓存 5 天） |
| NodeSeek | 论坛每日签到领鸡腿（支持试试手气） | 浏览器登录后复制 Cookie（登录有人机验证，无法用账号密码自动登录） |
| 自定义 HTTP | 万能模块 | 请求 URL/方法/头/体 + 成功判定规则 |

> 夸克接口：`drive-m.quark.cn/1/clouddrive/capacity/growth/{info,sign}`（`kps`/`sign`/`vcode` 约 2 个月有效，过期后重新抓包更新即可）。
> 天翼登录流程参考 [wes-lin/cloud189-sdk](https://github.com/wes-lin/cloud189-sdk)（MIT），用 WebCrypto 实现 RSA 加密。

### 夸克 kps/sign/vcode 获取方法

1. 手机安装抓包工具（推荐 [ProxyPin](https://github.com/wanghongenpin/proxypin)，按其文档配置证书）
2. 打开夸克 App → 网盘 →「签到领空间」页面并完成一次签到
3. 在抓包记录中找到 `https://drive-m.quark.cn/1/clouddrive/capacity/growth/info` 的请求
4. 复制请求参数中的 `kps`、`sign`、`vcode`，填入面板
5. 备注名随意填写（如"我的夸克"），保存后点「执行」测试一次

### 天翼云盘注意事项

- 直接填写 189 手机号 + 密码即可
- 若登录失败提示设备校验/二次验证：先在天翼云盘官方 App 或网页端手动登录一次（可关闭账号「设备锁」），之后面板即可自动签到
- 登录态缓存 5 天，失效自动重新登录

### NodeSeek Cookie 获取方法

- NodeSeek 登录页带 Cloudflare Turnstile 人机验证，**无法用账号密码自动登录**，必须手动复制 Cookie
- 电脑浏览器打开 www.nodeseek.com 并登录 → F12 → 刷新页面 → 点任意请求 → 复制 Request Headers 里的 `Cookie` 粘贴到面板
- 签到模式默认「试试手气（随机）」，也可选「固定 5 鸡腿」
- Cookie 失效时执行日志会提示，重新复制一次即可

### 自定义 HTTP 示例（V2EX 每日签到思路）

1. 浏览器登录目标网站，抓包找到签到请求的 URL、Cookie、参数
2. 在面板添加「自定义 HTTP」账号，填入方法/URL/请求头（含 Cookie）/请求体
3. 「期望状态码」填 200，「响应应包含」填签到成功时响应里的关键词（如 `success`）
4. 保存后点「执行」测试，日志会显示判定结果

### 多步录制（先登录再签到等多接口流程）

1. 添加「自定义 HTTP」账号 → 切换到「多步录制」模式
2. 在浏览器 F12 网络面板，对流程中的每个请求依次「复制为 cURL」
3. 每一步点「从cURL填入」粘贴解析；需要传递数据的步骤，在「提取变量」里按 `变量名=点路径` 填写（如 `token=data.token`），后续步骤用 `{{token}}` 引用（请求头/地址/请求体都可用）
4. 点「测试运行」验证整条链路，保存后每天自动执行

### 一键取 Cookie（小书签）

1. 账号页「一键取 Cookie」选择账号（如 NodeSeek）→ 点「生成小书签」
2. 把链接拖到浏览器书签栏
3. 在目标网站（已登录页面）点击该书签，Cookie 自动传回面板并弹出确认框填入

> 注意：浏览器安全限制下，普通网页不能直接读取任意站点的 Cookie（同源策略），HttpOnly 类型的 Cookie JS 也读不到。小书签是在你当前打开的网站页面上运行的，所以能拿到该站点的 Cookie；这类仍需手动复制粘贴。

## 部署步骤

### 1. 准备

- 一个 Cloudflare 账号
- 本机安装 Node.js 18+

### 2. 登录并创建 D1 数据库

```bash
npx wrangler login
npx wrangler d1 create daily-checkin-panel
```

把返回的 `database_id` 填入 `wrangler.toml`（替换 `REPLACE_WITH_YOUR_D1_DATABASE_ID`）。

### 3. （可选）设置凭据加密密钥

默认首次运行时自动生成加密密钥并存 D1。如需固定密钥（重建 D1 也不丢）：

```bash
openssl rand -base64 32   # 生成 32 字节密钥
npx wrangler secret put ENCRYPT_KEY
```

### 4. 部署

```bash
npx wrangler deploy
```

本地预览：`npx wrangler dev`

### 5. 初始化

打开 `https://<你的worker>.workers.dev`，设置管理密码 → 添加账号 → 点「执行」测试 → 完成。

## 定时任务

`wrangler.toml` 中：

```toml
[[triggers.crons]]
crons = ["0 0 * * *"]
```

Cloudflare Cron 使用 **UTC**，`0 0 * * *` = 北京时间每天 08:00。修改后重新 `npx wrangler deploy` 生效。

> 注意：`workers.dev` 域名在国内访问不稳定，建议在 Cloudflare  dashboard 为 Worker 绑定自定义域名。

## 新网站接入：录制一次，永久自动

以后新增任何网站，不用写代码，两种方式接入：

### 方式一：cURL 录制（推荐，最可靠）

1. 在电脑浏览器**人工登录**该网站（有滑块/人机验证也不怕，人工一次过掉），并手动完成一次签到
2. 按 F12 打开开发者工具 → 网络（Network）面板 → 找到刚才那次签到的请求 → 右键 → **复制为 cURL**
3. 面板中添加账号 → 站点选「自定义 HTTP」→ 把 cURL 粘贴到「cURL 命令」框 → 点「从 cURL 导入」
   - 请求地址、方法、请求头（含 **Cookie，自动带入，无需手动复制**）、请求体都会自动填好
4. 填写「响应应包含」（签到成功时响应里的关键词，如 `success`），保存后点「执行」验证一次
5. 完成。之后每天 08:00 自动签到。Cookie 失效时执行日志会提示，重新录制一次即可（1 分钟）

### 方式二：自动探测

在「自定义 HTTP」表单点「自动探测」，输入网站首页地址，面板会自动抓取页面、
在链接文字和 JS 代码中寻找候选签到接口（含 WordPress 站的 `action=user_qiandao` 这类），
点候选结果即可填入，再点「执行」验证。

> 实测：在糊涂鳄资源站（dj.hutue.cn）上自动探测到了 `user_qiandao` / `xb_user_qiandao`
> 两个签到动作，未登录请求返回 `{"status":"0","msg":"请登录后签到"}`，接口格式确认有效。

## 扩展新站点

1. 在 `src/sites/` 新建文件，如 `src/sites/bilibili.js`，导出：

```js
export const bilibili = {
  id: 'bilibili',
  name: 'B站',
  desc: '站点描述',
  fields: [
    { key: 'cookie', label: 'Cookie', type: 'text', required: true },
  ],
  tips: '给用户的填写提示（可选）',
  // 返回 { ok: true/false, message: '...' }
  async run(creds, ctx) {
    // ctx: { env, db, account, meta }，meta 可读写（会自动持久化）
    return { ok: true, message: '签到成功' };
  },
};
```

2. 在 `src/sites/index.js` 的 `SITES` 数组中注册。
3. 重新部署，Web 界面自动出现新站点的表单。

适合做成站点的：纯 HTTP API 类签到。不适合的：需要验证码/滑块、浏览器自动化的站点（Workers 无浏览器环境）。

## 安全说明

- 管理密码：PBKDF2-SHA256（12 万次迭代）哈希存 D1
- 账号凭据：AES-GCM 加密存 D1，密钥来自 `ENCRYPT_KEY` Secret 或自动生成
- 会话：服务端 session + HttpOnly + Secure + SameSite Cookie，7 天过期
- 推送密钥：设置页读取时脱敏，更新时留空即保留旧值

## 项目结构

```
daily-checkin-panel/
├── wrangler.toml        # Worker 配置、Cron、D1 绑定
├── src/
│   ├── index.js         # 路由 + API + Cron 入口
│   ├── runner.js        # 执行引擎（遍历账号/写日志/推送）
│   ├── db.js            # D1 表结构与 settings 读写
│   ├── crypto.js        # 密码哈希 / 凭据加密
│   ├── notify.js        # Telegram / Bark / Webhook 推送
│   └── sites/
│       ├── index.js     # 站点注册表
│       ├── quark.js     # 夸克网盘
│       ├── cloud189.js  # 天翼云盘
│       ├── nodeseek.js  # NodeSeek 论坛
│       └── http.js      # 自定义 HTTP
├── public/
│   └── index.html       # 管理后台 SPA
└── README.md
```

## 免责

本项目仅供学习交流。签到接口由各站点提供，若对方更新接口导致失效，需按新接口调整对应 `src/sites/` 文件。请勿用于非法用途。
