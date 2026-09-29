# Cloudflare 部署清单：名字、绑定、变量各填什么

这份文档只回答一件事：**在 Cloudflare 上到底要建什么、叫什么名字、哪些变量要填、填什么值。**
推荐路线（[README.md](../README.md) 的「部署到 Cloudflare」纯网页版）里，1、2、3 项全部在网页上点出来；
用 `node deploy.mjs` 的话脚本会自动做完 1、2、3；想手动部署、或者部署完想核对一遍，就照这张清单逐项对。

> 一句话版本：**一个 Worker + 一个 D1 数据库 + 一把加密密钥（Secret）。**
> 数据库名和绑定名不能改（要和 `wrangler.toml` 一致），`database_id` 和密钥值必须是你自己的。

---

## 1. Worker（计算）

| 项目 | 填什么 | 在哪里 |
|---|---|---|
| Worker 名称 | `daily-checkin-panel` | `wrangler.toml` 的 `name` |
| 入口 | `src/index.js` | `wrangler.toml` 的 `main` |
| 静态页面目录 | `./public`（面板网页本身） | `wrangler.toml` 的 `[assets] directory` |
| 兼容日期 | `2024-01-01`（保持默认即可） | `wrangler.toml` 的 `compatibility_date` |
| 定时触发 | `* * * * *`（每分钟触发一次） | `wrangler.toml` 的 `[triggers] crons` |

**Worker 名字可以改成你喜欢的**（比如 `my-checkin`），改完记得重新部署。
面板地址会变成 `https://<你改的名字>.<你的账号>.workers.dev`。

**定时触发为什么是「每分钟」**：Worker 内部再按面板里设置的签到时间（默认 08:00）判断到点没有，
所以不会重复签到；频率低于「分钟」的话，面板里设 08:30 这类分钟级时间就不会生效。

---

## 2. D1 数据库（存账号、日志、设置）

| 项目 | 填什么 | 说明 |
|---|---|---|
| 数据库名称 | `daily-checkin-panel` | `wrangler.toml` 的 `database_name`。**必须和这里一致**（网页部署也按这个名字对上），`deploy.mjs` 就是按这个名字去建/去找的 |
| 绑定名（Binding） | `DB` | `wrangler.toml` 的 `binding = "DB"`。代码里写的是 `env.DB`，**不要改**，改了代码就找不到数据库 |
| 数据库 ID | **你自己的那一串**，形如 `8f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8` | `wrangler.toml` 的 `database_id`。仓库里是占位符 `REPLACE_ME_WITH_YOUR_OWN_D1_ID` |

网页部署拿 `database_id`：D1 数据库详情页里直接能看到/复制，不需要任何命令。

拿 `database_id` 的两种命令行办法（用命令行部署时才需要）：

```bash
# 新库（会直接打印 id，把那串 UUID 复制进 wrangler.toml）
npx wrangler@latest d1 create daily-checkin-panel

# 已经建过了（列出来找 uuid 那一列）
npx wrangler@latest d1 list
```

- 建表**不用你管**：第一次访问面板时 Worker 会自己把表建好（`ensureSchema`）。
- 免费额度：5GB 存储、每天 500 万次读 / 10 万次写 —— 签到面板这点量用不到 1%。
- 想换库：把 `database_id` 换成新库的 id 重新部署即可（旧数据不会自动搬过去）。

---

## 3. 变量与密钥（到底要加哪些）

面板一共认 **3 个环境变量**，其中只有第 1 个是「必须」的：

| 变量名 | 类型 | 必填？ | 填什么 | 作用 |
|---|---|---|---|---|
| `ENCRYPT_KEY` | **Secret**（加密变量） | ✅ 必须（`deploy.mjs` 会自动设） | 32 字节、base64 编码的随机串，例如 `zB2sJ9kQ...=`（末尾通常有一个 `=`） | 账号的 Cookie / 密码 / token 用它做 AES-GCM 加密后才写进 D1。**丢了就解不开已有凭据**，只能重新录入 |
| `EXTERNAL_API_KEY` | Secret 或 Text 都行 | 可选 | 24 位以上的随机串 | 只有「用 VM 脚本 / 自己写的程序调 `/api/external/*`」时才需要。不填的话，Key 由面板在设置页生成（推荐这条，面板上还能一键轮换） |
| `ASSETS` | 绑定（不是变量） | 由 `wrangler.toml` 的 `[assets]` 自动提供 | 不用填 | 面板网页（`public/`）由它下发。用了 `[assets]` 就不用管 |

另外两个**不要**手动填：

- `DB`：D1 的绑定名，由 `wrangler.toml` 的 `[[d1_databases]] binding` 提供，不是「变量」。
- 数据库里的设置项（通知渠道、签到时间、扩展 API Key 等）：全在**面板网页**里改，不用碰环境变量。

### `ENCRYPT_KEY` 怎么生成

```bash
# Linux / macOS / Git Bash（推荐）
openssl rand -base64 32

# 任何有 Node.js 的机器
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 怎么设到 Cloudflare 上

**命令行（推荐）**

```bash
npx wrangler@latest secret put ENCRYPT_KEY
# 提示 Enter a secret value 时，把上面生成的那一串粘进去回车
```

**网页控制台**：`Workers & Pages` → 选中你的 Worker → `Settings` → `Variables and Secrets` →
`Add` → 类型选 **Secret** → 变量名 `ENCRYPT_KEY` → 值粘进去 → `Save`。
（改完变量要重新 `Deploy` 一次才会对正在运行的版本生效。）

### ⚠️ 三条最容易踩的坑

1. **`database_id` 还是占位符**：这种情况 `wrangler deploy` 也会「成功」，但面板一打开什么都读不出来。
   `deploy.mjs` 现在会在部署前拦住它；手动部署的话，先跑 `npx wrangler@latest d1 list` 核对一遍。
2. **`ENCRYPT_KEY` 填错格式**：必须是 32 字节的 base64。填错了面板会直接告诉你
   「`ENCRYPT_KEY` 必须是 32 字节的 base64 字符串…」，不会含糊地报一个 atob 错误。
3. **换了 `ENCRYPT_KEY`**：等于换了一把钥匙，**旧账号全部解不开**（面板会显示「凭据数据格式异常」）。
   真要换，就换完把账号重新录一遍；备份 D1 不等于能换密钥。

---

## 4. 部署完的核对（30 秒）

1. 打开面板地址 → 能出现「设置管理密码」页面 → 说明 Worker + 静态资源正常。
2. 设好密码 → 进得去、账号页能加载 → 说明 D1 绑定和建表都正常。
3. 面板右上角如果能正常显示时间/心跳（「自动检查 …」），说明 Cron 触发器在跑。

命令行复核：

```bash
npx wrangler@latest d1 list                 # 库在不在、id 对不对
npx wrangler@latest secret list             # ENCRYPT_KEY 在不在
npx wrangler@latest deployments list        # 最近一次部署成功没
npx wrangler@latest tail                    # 实时看 Worker 日志（排错神器）
```

---

## 5. 绑定自己的域名（可选）

Worker 详情 → **设置 → 域和路由 → 添加自定义域** → 输入你的域名（如 `checkin.example.com`）→ 按提示去域名 DNS 加一条 CNAME。

绑定后注意两点（代码已自动适配，不用改任何配置）：

1. **用哪个域名下载扩展，扩展里记住的就是哪个**：面板下载扩展时会自动把「你当前打开面板的那个域名」写进扩展。想让扩展走自定义域名，就用自定义域名打开面板再下载一次（或在扩展弹窗的「签到面板地址」里手动改成自定义域名）。
2. **原来的 `xxx.workers.dev` 地址继续有效**：扩展里填哪个都能用，API Key 和账号数据是同一份，不用来回倒腾。

---

## 6. 一键部署脚本到底做了什么（想手动做的话照着来）

`node deploy.mjs` 依次做 7 件事，对应上面的清单：

1. 检查 Node.js ≥ 18、`wrangler.toml` 里的 `database_name` 还在不在；
2. `npx wrangler login`（没登录就打开浏览器让你点「允许」）；
3. `npx wrangler d1 create daily-checkin-panel`，把拿到的 id **自动写进 `wrangler.toml` 的 `database_id`**；
4. 生成 `ENCRYPT_KEY` 并 `npx wrangler secret put ENCRYPT_KEY`（已经有就保持不变）；
5. 部署前把关：`database_id` 必须真的是 UUID、`name` 必须存在；
6. `npx wrangler deploy`，并打印你的面板地址；
7. 部署完**当场验收**：首页能不能打开、数据库接口通不通（用故意写错的密码探一次登录接口）；
   不过关就把 `wrangler tail` / `d1 list` 这些排错命令直接列出来。

想手动做，就是上面 2→3→4→6 四步；`wrangler.toml` 里除了 `database_id` 之外都不用动。

**只想体检、不发布**：`node deploy.mjs --check` —— 它只读不写（不建库、不设密钥、不部署），
把登录状态、`database_id`、密钥逐项报给你。CI（`.github/workflows/deploy.yml`）部署前用的也是它。

---

## 7. 相关文档

| 文件 | 内容 |
|---|---|
| [README.md](../README.md) | 纯网页部署逐步说明（给第一次用的人）；命令行一键部署收在折叠块里 |
| [docs/详细手册.md](详细手册.md) | 每一步在干什么、每个字段什么意思、常见问题 |
| [SECURITY.md](../SECURITY.md) | 密码 / Cookie 是怎么保护的，密钥为什么不能丢 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 想加一个站点适配（社区共享） |
| [CHANGELOG.md](../CHANGELOG.md) | 每一版改了什么 |
