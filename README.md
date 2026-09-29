# 每日签到面板

**一句话**：把你每天要手点的那些「签到」，交给它每天自动点一遍，签完还会推到你手机上。

跑在 Cloudflare 上，**免费**。只要一个 Cloudflare 免费账号，不用买服务器、不用信用卡、不用域名。

<p>
  <a href="https://github.com/guoxpeng/daily-checkin-panel"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-guoxpeng%2Fdaily--checkin--panel-5b8cff?logo=github"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3ddc84"></a>
  <a href="CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-ffb020"></a>
</p>

---

## 部署（Cloudflare）

**准备**：一个 Cloudflare 账号（免费注册）、一个 GitHub 账号，大约 15 分钟。不用在电脑上装任何东西。

---

**第 1 步：把代码弄到你自己的 GitHub**

打开本仓库页面，点右上角 **Fork** → 直接点 **Create fork**。之后你就有了一份完全属于你的代码副本。

---

**第 2 步：建 D1 数据库**

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com/)，左侧菜单点 **Workers & Pages**
2. 点 **D1**（如果没看到，先点一下左侧的 `Storage & Databases`）
3. 点 **Create**，在 `Database name` 里填 `daily-checkin-panel`，点 **Create**
4. 建好后点进这个数据库，复制 **Database ID**（形如 `8f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8` 的一串字符），先粘到记事本备用

---

**第 3 步：接 GitHub 自动部署**

1. 回到 **Workers & Pages**，点 **Create**
2. 点 **Connect to Git**（不是 `Upload files`）
3. 按提示授权 Cloudflare 访问你的 GitHub，选中你刚 Fork 的 `daily-checkin-panel` 仓库，点 **Begin setup**
4. 配置页面：
   - **Production branch**：填 `master`
   - **Build command**：填 `npx wrangler deploy`
   - **Deploy command**：留空（构建命令里已经包含了部署）
   - 其他保持默认
5. 点 **Save and Deploy**，等它跑完（第一次会失败，没关系，继续往下做）

---

**第 4 步：绑定数据库**

1. 点进刚建好的 Worker，顶部点 **Settings**
2. 左侧找到 **Bindings**，点 **Add binding**
3. 类型选 **D1 database**，填：
   - **Variable name**：`DB`（⚠️ 必须一字不差叫这个，代码里写的是 `env.DB`，改了就连不上库）
   - **D1 database**：下拉选中第 2 步建的 `daily-checkin-panel`
4. 点 **Add binding**

> 备选做法：把第 2 步复制的 Database ID 填进仓库 `wrangler.toml` 的 `database_id` 那一行再推送，效果一样。仓库里默认是占位符 `REPLACE_ME_WITH_YOUR_OWN_D1_ID`，不填的话就用上面的绑定方式。

---

**第 5 步：设置加密密钥 ENCRYPT_KEY**

1. 还在 Worker 的 **Settings** 里，左侧点 **Variables and Secrets**
2. 点 **Add**，在弹窗里：
   - **Type**：选 **Secret**（⚠️ 一定要选 Secret，不要选 Text。Secret 是加密存储的，Text 会以明文显示在页面上）
   - **Variable name**：填 `ENCRYPT_KEY`（⚠️ 大小写一字不差）
   - **Value**：填一串 32 字节的 base64 字符串，形如 `zB2sJ9kQ7xVmP3nR8tY5wE2uI6oL4aS1dF0gH=`（44 个字符，末尾通常有个 `=`）
     - 怎么生成：在任意 Linux/macOS 终端跑 `openssl rand -base64 32`，复制输出
     - 没终端？打开 [https://generate-secret.vercel.app/32](https://generate-secret.vercel.app/32) 点生成，复制结果
3. 点 **Save**

⚠️ 这把钥匙丢了或换了，已存的账号 Cookie 就解不开了，只能重新录入。**记到密码管理器里，不要删除它。**

---

**第 6 步：重新部署并打开面板**

1. 回到 Worker 页面，点右上角 **Deployments** → **Deploy**（或 **Retry deployment**），等状态变绿
2. 点 **Visit**（或复制 `https://daily-checkin-panel.你的名字.workers.dev`），看到「设置管理密码」页面就是成功了
3. 设一个至少 8 位的管理密码（⚠️ 记到密码管理器，忘了没法找回）

**之后每次往 GitHub 推代码，Cloudflare 会自动重新部署**，什么都不用管。

---

**部署完还要做 3 件事**（在面板网页里操作）：

1. **生成扩展的 API Key**：设置 →「🔌 浏览器扩展」→ **🎲 重新生成 API Key** → 马上点 **📋 复制**（⚠️ 只显示一次，忘了就再生成一把，旧的立刻失效）
2. **装浏览器扩展**：同一张卡点 **⬇️ 下载 签到面板助手** → 解压到固定文件夹 → `chrome://extensions` 开**开发者模式** → **加载已解压的扩展程序** → 点 🍪 图标填 API Key → **🔌 面板连接检查**显示「连接正常」
3. **加第一个账号**：目标网站手动登录 → 点扩展 **📋 一键复制全部信息（含 UA）** → 面板「添加 / 更新账号」→「📋 粘贴即保存」→ Ctrl+V，面板自动认站点并试跑

**对不上号时的速查** → [Cloudflare 部署清单](docs/Cloudflare部署清单.md)（D1 名、绑定名、变量名一张表）；
**部署报错要弄清原因** → [详细手册](docs/详细手册.md)。

---

## 日常怎么用

| 我想…… | 怎么做 |
|---|---|
| 马上签一次 / 全部签一次 | 那一行点 **执行** / 右上角 **全部执行** |
| 改签到时间 | 账号页「全局签到」：点 `每天 08:05`、`时区 中国台湾 · 台北` 两个胶囊，**选好即自动保存**，改完立刻生效 |
| 给某个账号单独一个时间 | 表格「全局签到」列点一下自己选（点「跟随全局」就回去） |
| 暂时不签某个账号 | 那一行的开关关掉 |
| 看每次签的结果、网站原话 | 页面顶部 **运行日志** |
| 看这份登录还能撑多久 | **鼠标移到那一行的站点名上**（名字下面有条虚线），弹出这套凭据的到期时间 |
| 看某个账号为什么没签上 | 「网站反馈」那列；底下有「💡 建议」胶囊时**鼠标移上去**看完整内容 |
| 换个主题 | 右上角主题按钮点一下换一种（跟随系统 / 浅色 / 深色） |

**状态列**：✅ 已签到 · 🔴 未签到（过了你设的时间会全部回到这个状态，签成功才变 ✅）· ⏭️ 跳过（这次没跑，不算失败）。
每天合不合适，右上角那个**网络连接状态**（阿里 / 谷歌 / Facebook / GitHub / Telegram / 百度）能帮你判断是面板出口的问题还是某个站自己的问题。

---

## 推送通知（Telegram，4 步）

面板 → **设置** →「推送通知」→ **📨 Telegram**：

1. Telegram 里找 **@BotFather** → 发 `/newbot` → 按提示走完，拿到 **Bot Token**
2. 粘进面板「Bot Token」
3. **用你自己的 Telegram 给这个 Bot 发一句「hi」**（要推群里就把 Bot 拉进群再在群里发一句）
4. 点 **🔍 自动获取 Chat ID** → 选一个会话 → **📨 发送测试消息**

收到就说明通了。勾上「启用推送」→ **保存推送设置**，以后每天签完自动发汇总。
不想用 Telegram？同一页还有 **Bark**（iPhone）和**通用 Webhook**，填一个就行。

---

## 出问题怎么办

| 现象 | 怎么办 |
|---|---|
| 面板打不开，或扩展老是「连接失败」 | `*.workers.dev` 在国内有时连不上，**绑一个自己的域名**可彻底解决（见[详细手册](docs/详细手册.md)）；换域名后记得去扩展弹窗改地址 |
| 扩展显示「离线」 | 点扩展图标检查「签到面板地址」「API Key」，再点「🔌 面板连接检查」 |
| 「登录已失效 / Cookie 已失效」 | 去那个网站重新登录，再走一遍「加第一个账号」的复制粘贴 |
| 「需要本地网络」 | 打开浏览器、确认扩展启用。有些站会拦机房 IP，只能走你家网络（这就是扩展的用处） |
| 明明签了却写「未签到」 | 点那一行的 **执行**，看「网站反馈」——那是网站自己的原话，不会骗人 |
| 想换 / 忘了管理密码 | 设置 →「修改管理密码」（改完其它浏览器会退出登录）；忘了按[详细手册](docs/详细手册.md)里那条命令清掉重设 |

更多疑难杂症（每种网站的坑、执行模式怎么选、Cookie 怎么手动取）见[详细手册](docs/详细手册.md)。

---

## 开源共建

**面板里没有写死任何网站。** 任何能在浏览器里手动签到的站都能做适配：

1. 用「自定义 HTTP」把签到调通（F12 →「复制为 cURL」，支持多步）
2. **设置** →「🌍 社区站点（开源共享）」→ 选一个**签到网站** →「📤 导出为社区配置」
   （选的是网站不是账号：分享出去的是「这个网站怎么签」；一个站下多个账号时面板自己挑调通过的那个）
3. 配置里的 Cookie / 密码会被换成 `{{cookie}}` 这类占位符，导出一段 JSON，发到 Issue / PR
4. 别人在同一处粘贴导入，**立刻能用，不用改代码、不用重新部署**

规范与现成示例见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [community/README.md](community/README.md)。
**导出的配置里绝不会带登录信息**：导出时自动清洗，导入时校验器直接拒绝带明文 Cookie 的配置。

---

## 数据与安全

| 你关心的 | 实际情况 |
|---|---|
| 账号密码 / Cookie 存在哪？ | 你自己的 Cloudflare D1 里，AES-GCM **加密**后存储；密钥只在你自己的 Worker 上（`ENCRYPT_KEY`） |
| 面板有防护吗？ | 管理接口都要登录；连续输错会临时锁定；改密码踢掉所有会话；跨站请求拒绝；CSP 等安全头。清单见 [SECURITY.md](SECURITY.md) |
| 扩展能干什么？ | 只读你**当前正在看的那一个网站**的 Cookie，不点按钮什么都不做；代发请求只允许公网 http(s)，内网 / 本机地址一律拒绝 |
| 会不会被公开？ | 面板地址只有你知道；API Key 只手动填进扩展，不会写进下载包 |

请只用来签**你自己的**账号。使用本项目产生的后果由使用者自己承担（见 [LICENSE](LICENSE)）。

---

## 文档与开发

| 文件 | 内容 |
|---|---|
| [docs/Cloudflare部署清单.md](docs/Cloudflare部署清单.md) | 部署要填什么：D1 名字、绑定名、`database_id`、各变量 |
| [docs/详细手册.md](docs/详细手册.md) | 手动部署、执行模式、内置站点、社区适配、FAQ、备份与结构 |
| [SECURITY.md](SECURITY.md) / [CONTRIBUTING.md](CONTRIBUTING.md) | 安全说明 / 怎么贡献一个站点适配 |
| [CHANGELOG.md](CHANGELOG.md) | 每一版改了什么 |

```bash
node tools/verify.mjs        # 自检：语法 + HTML 配对 + DOM 引用 + 全部单测（CI 跑的是它）
node tools/pack-zip.mjs      # 打发布包（release/*.zip，带 SHA-256）
node tools/release.mjs minor # 发版：自检 → 升版本号 → 写 CHANGELOG → 打发布包，再提示 git 命令
```

`.github/workflows/` 里：`ci.yml` 每次推送/PR 自检；`release.yml` 推 `v*` tag 自动发 Release；
`deploy.yml` 是可选手动部署（默认只 dry-run）。零第三方依赖，所以 CI 不需要 `npm install`。

```
wrangler.toml  部署配置（数据库 id、定时触发器）      deploy.mjs  一键部署脚本
src/           Worker 端代码（路由、站点适配、加密、定时任务）
public/        网页面板（index.html 就是整个后台界面）
test/  tools/  单测 / 自检与发版脚本          docs/  community/  文档 / 社区站点配置
```

自己加一个内置站点：在 `src/sites/` 加一个模块，再到 `src/sites/index.js` 注册，然后 `node tools/verify.mjs`。

---

## 许可

[MIT](LICENSE)
