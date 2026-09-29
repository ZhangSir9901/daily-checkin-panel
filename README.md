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

**准备**：一个 Cloudflare 账号（免费）、一个 GitHub 账号，大约 15 分钟。不用在电脑上装任何东西。

**1. 把代码弄到你自己的 GitHub**
Fork 本仓库（右上角 Fork），或下载 ZIP 后上传到你新建的仓库。

**2. 建 D1 数据库**
Cloudflare 控制台 → 左侧 `Workers & Pages` → `D1` → `Create`：
- 名称填 `daily-checkin-panel`
- 建好后点进去，复制 **Database ID**（一串 UUID）备用

**3. 接 GitHub 自动部署**
Cloudflare 控制台 → `Workers & Pages` → `Create` → `Connect to Git`：
- 选你 Fork 的仓库，分支 `master`
- 构建命令填 `npx wrangler deploy`，点 `Save and Deploy`

**4. 绑定数据库**
Worker 建好后 → `Settings` → `Bindings` → `Add binding` → `D1 database`：
- Variable name 填 `DB`（**必须叫这个**，代码里写的是 `env.DB`）
- 选第 2 步建的 `daily-checkin-panel` 库 → `Add binding`

> 或者把第 2 步复制的 Database ID 填进 `wrangler.toml` 的 `database_id` 再推送，效果一样。仓库里默认是占位符。

**5. 设置加密密钥**
`Settings` → `Variables and Secrets` → `Add` → 类型选 **Secret**：
- 变量名 `ENCRYPT_KEY`
- 值填一串 32 字节的 base64（在线生成一个，或跑 `openssl rand -base64 32`）
- `Save` 后重新 `Deploy` 一次

⚠️ 这把钥匙丢了，已存的账号 Cookie 就解不开了，只能重新录入。**不要删除它。**

**6. 打开面板**
部署成功后，`Workers & Pages` 里点你的 Worker，`Visit` 打开的就是面板地址（形如 `https://daily-checkin-panel.你的名字.workers.dev`）。

之后每次往 GitHub 推代码，Cloudflare 会自动重新部署，无需手动操作。

变量名、绑定名、每一项填什么的速查表 → [Cloudflare 部署清单](docs/Cloudflare部署清单.md)；
部署报错要弄清原因 → [详细手册](docs/详细手册.md)。

---

## 部署完还要做 4 件事

**1. 打开面板设置管理密码**（至少 8 位）。⚠️ 记到密码管理器里，忘了没法找回。

**2. 生成扩展的 API Key**：设置 →「🔌 浏览器扩展」→ **🎲 重新生成 API Key**。
⚠️ 这串 Key **只在生成那一刻显示一次**，页面上没有「查看」。生成后马上点 **📋 复制**，粘进扩展弹窗；
忘了就再生成一把（旧的立刻失效）。

**3. 装浏览器扩展**：同一张卡点 **⬇️ 下载 签到面板助手** → 解压到固定文件夹（**别删别移动**）
→ `chrome://extensions` 打开**开发者模式** → **加载已解压的扩展程序** 选那个**文件夹本身**
→ 点 🍪 图标填 API Key → **🔌 面板连接检查**显示「连接正常」即成功。
（下载包**已自动写好你现在的面板地址**，不用手抄；面板里的「安装步骤」折叠块有同样的 4 步。）

**4. 加第一个账号**：打开目标网站**手动登录** → 停在网站上，点扩展 **📋 一键复制全部信息（含 UA）**
→ 面板「添加 / 更新账号」→「📋 粘贴即保存」里 **Ctrl+V** → 面板自动认站点、填信息、立刻试跑。
要加第二个网站就再来一遍这 4 步。

> 同一张卡另一个标签 **🔍 Cookie 解析器**（默认就在那儿）：粘一串 Cookie 点「拆分看看」，
> 逐段告诉你每段是什么、哪些是登录必需，**只看不存**；没问题再点「↗️ 填到粘贴区并保存」。

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
