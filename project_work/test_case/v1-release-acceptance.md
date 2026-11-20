# ShanHe DevHub V1 Release Acceptance Report

验收环境为 2026-11-20 的 macOS 14.5 arm64、本机桌面、Node.js `24.22.3` LTS、pnpm `11.25.0`。实际基线为 `FreeToBelieve/devhub` `main@e83c732cb349f989cc30abf413d40dc2dee7614f`，包含 Sprint 2.6。验收变更位于本地 `release/v1-rc-acceptance`。已核对 README、AGENTS.md、Sprint 2.x 技术设计与历史报告、CI 配置及 SQLite v0–v7 迁移。

**发布判断为保留 Release Candidate。** Windows 11 桌面、macOS Player 启动、Unity 2022.3 的许可后流程和历史业务数据库副本均有缺口。GitLab 的真实 Push 和 MR 已单独验收。本文的 `PASS` 只表示该行限定的环境和断言通过。`BLOCKED` 表示所需环境或结果缺失，`NOT TESTED` 表示该项未实际执行。

## 回归与首次使用

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 本机冻结安装、类型检查、Vitest、构建 | PASS | `pnpm install --frozen-lockfile`、`pnpm typecheck`、`DEVHUB_TEST_NATIVE_KEYCHAIN=1 pnpm test`、`pnpm build`。13 个测试文件，107 项通过、8 项平台专用用例跳过。 |
| `pnpm doctor` 与 DevHub Doctor | PASS | pnpm 自带诊断通过，有全局 bin 未在 PATH 的提示。`pnpm run doctor` 的 DevHub 检查通过，正确识别 macOS arm64 和 Unity。未设单一工程路径时跳过该探针。 |
| 主仓库 CI | PASS | 精确基线的 macOS 15 和 Windows Server 2025 均通过 Node 24、frozen install、typecheck、test、build。[基线 CI](https://github.com/FreeToBelieve/devhub/actions/runs/44669284902) |
| 本轮变更 CI | PASS | 独立私有测试仓库用原工作流复验迁移与许可诊断改动。macOS 15 为 106 通过、9 跳过，Windows Server 2025 为 110 通过、5 跳过。两组均通过 Node 24、冻结安装、类型检查和构建。候选回归 CI（链接保留在本机验收记录。） |
| README 与首次使用 | PASS | 使用可信回环代理从公开 GitHub 重新克隆 `main`，通过 frozen install、生产构建和 `pnpm start`，回环健康检查返回 `ok`，Dashboard 页面可用。另一个本地新克隆的首轮构建收到 `SIGKILL`，在同克隆重跑构建及 Doctor 成功。真实 Chrome 通过授权登录、注册、Worktree、任务和切换路径。README 补充环境安装、隔离 Codex 登录、任务和交付顺序。 |
| 新开发者从空白 Windows 11 走通 README | NOT TESTED | 缺少 Windows 11 桌面；PowerShell 命令以文档检查和 Windows Server 组件回归为限。 |

## Windows 11 x64 桌面

本轮没有 Windows 11 x64 测试机。以下均为 `BLOCKED`。Windows Server CI 提供 Node 24、锁定依赖、存储、Windows Credential Manager 原生合成条目、Artifact ACL 和并发锁的回归证据。

| 桌面验收项 | 结果 |
| --- | --- |
| Node 24 安装、启动、Codex ChatGPT 登录、Developer Mode | BLOCKED |
| 创建真实 Worktree、Windows Credential Manager、GitHub 与 GitLab 连接 | BLOCKED |
| Unity Editor、Batch Mode、EditMode 和 PlayMode | BLOCKED |
| Windows Player 构建、实际启动、截图与录屏 | BLOCKED |
| 实际桌面 Worktree 并发锁、Artifact ACL、项目切换与越权拒绝 | BLOCKED |

## Git Provider

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| GitHub 连接、Fetch、默认分支及 Worktree | PASS | 新建独立私有测试仓库，以 DevHub Git 传输抓取 `main`，连通性验证及 macOS Keychain 写入成功。以 `68a10b306d9b5794272811b79edb1acaf6f407b5` 创建 `devhub/v1-rc-20261120-7ca7c4`。 |
| GitHub Commit、Push、PR、Diff、Review、CI 和更新原 PR | PASS | 通过 DevHub 审批并执行两次。读回 `Assets/ReleaseCandidate.txt` 的实际差异、一条合成 Review 评论和两个成功的 CI 检查。重复执行回到同一条交付。两次 Push 与本地 Commit 一致，同一 PR #1 更新，测试仓库默认分支在交付前后 SHA 不变，最后撤销测试 Keychain 引用。 |
| 自建 GitLab 《山河问仙》只读连接、仓库及默认分支 | PASS | 使用本机配置的可信代理按域名连接，通过 DevHub GitLab Provider 已认证读取仓库和默认分支 `main`。HEAD 为 `c6c17b1caab5f0d4a7686a16d1d2774166880eeb`。 |
| GitLab.com 连接与写入 | BLOCKED | 通过 DevHub 固定地址 HTTPS 访问 API，TLS 校验通过、未认证请求返回 401。本轮没有核实可用的 GitLab.com 登录与测试项目。 |
| GitLab 真实 Commit、Push、草稿 MR 和 Diff | PASS | 经用户授权在正式《山河问仙》用独立检出和 `devhub/gitlab-acceptance-20261120-f3486a` 完成真实交付。MR 仅含 `Unity/DEVHUB.md`，已读回远端 Diff，默认分支保持原 HEAD。 |
| GitLab 新增评审、更新原 MR 和 Pipeline 执行 | NOT TESTED | 本轮范围是提交、Push、创建并读回草稿。当前流水线规则仅匹配受保护的默认分支，验收开发分支没有触发 Pipeline。 |

2026-11-20 13:04（北京时间）复测《山河问仙》。DNS 仍为 0 条 A、1 条 AAAA。本机没有可用的直连 IPv6 路由。固定 IPv6 的回环代理返回 CONNECT 200，随后 TLS 仍被 `ECONNRESET` 重置。DevHub 两条路径均返回 `GIT_NETWORK_UNAVAILABLE`。按主机名做无凭据对照时，证书校验通过，`/api/v4/user` 返回 401，仓库 API 返回 404，项目页面返回 302 并跳转到同站登录页。仍未取得仓库元数据或默认分支，GitLab 交付状态保持 `BLOCKED`。

追加本机代理复测。系统配置的 HTTP CONNECT 和 SOCKS5 共享 `127.0.0.1:7890`。按主机名访问 `/api/v4/user` 时，两种协议均通过证书校验并返回 401。固定 IPv6 时，HTTP 代理返回 CONNECT 200，HTTP CONNECT 和 SOCKS5 随后的 TLS 握手均报 `SSL_ERROR_SYSCALL`，无上游 HTTP 响应。DevHub 固定地址的仓库读取仍为 `BLOCKED`。

启用精确 origin 的代理解析后，构建版 DevHub 通过本机 `.env` 和回环代理访问正式 GitLab。账户 API、仓库 API、Git 读取握手的 TLS 证书均校验通过，未认证响应依次为 `401`、`404`、`401`。

2026-11-20，使用本机隐藏窗口输入的只读令牌，构建版 DevHub GitLab Provider 通过仓库 API 和分支 API 核对了《山河问仙》的仓库地址、默认分支 `main` 及实际 HEAD `c6c17b1caab5f0d4a7686a16d1d2774166880eeb`。令牌仅用于当次读取。

代理解析回归覆盖精确域名和端口、其他 origin 保留固定 IP、无受信回环代理时拒绝启用，以及 CONNECT 请求不携带 Git 凭据。Node 24 冻结安装、typecheck、Vitest 与构建通过，本机 109 项通过、8 项跳过。

Git 管理表单通过真实 Chrome、临时 Git 仓库及本机 Hub 验收。标准 GitHub 和带自定义端口的自建 GitLab 默认只显示令牌输入，提交时带上已识别的 Provider 和仓库。GitLab 高级设置可选填 API Base URL，无 HTTPS 远端时仍可手工配置。界面回归的提交请求使用合成值并在浏览器中拦截。正在运行的本机 Hub 已加载新版界面，并使用用户已保存的 GitLab 连接只读查到《山河问仙》的默认分支 `main`。本机检测到匹配的 Unity Editor、Build Support 和图形会话。

正式仓库的 Worktree 检出实测耗时 10.5 秒，超过原有 8 秒通用 Git 超时。DevHub 将实际检出操作的超时调整为 60 秒后成功创建受管 Worktree。隔离副本执行交付，额外凭据只在该验收进程的内存中使用。首次 Push 在本地已提交阶段返回网络错误；远端只读确认目标分支为空后重试同一个提交。复测 GitLab receive-pack 握手和提交上传均返回 HTTP 200 并通过 TLS 证书校验。Commit 为 `e32cff5e42bae8167b2d540cf4efea21bfdf2228`，实际 Tree 和审批 Tree 均为 `577bcae4130bcd0fc1a846e591b39d7b2912e415`。GitLab 回读确认 `!2` 是打开的草稿 MR。本机原 Git 工作区保持在 `zgl`。

DevHub 本机服务已启用 Codex 登录复用。专用目录仅引用本机的认证文件。真实 SDK Turn `c309d1b5` 在临时 Worktree 完成，原生探针验证当前工程可写，并拒绝读取同仓兄弟目录和另一 Worktree 的合成文件。

GitHub 交付两轮均从实际 Commit 对象读取 Tree SHA，并与批准候选 Tree 比较。

| 轮次 | 实际 Commit SHA | 候选与实际 Tree SHA |
| --- | --- | --- |
| 创建 PR | `6a66f739d129eda70e572985796ed4fca1b3ba22` | `3c1258dcf7a3dc381d5380e64c78f3043376930f` |
| 更新 PR | `23a8ed87cb0d7d8f974223589c6bd56a520e3582` | `dc7cb78eaec59d54a215ad1f132bc947048e1e37` |

## Unity 真机

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 6.3 精确版本、GUI Editor、导入和 C# 编译 | PASS | `6000.3.28f1`。Batch `3e171a49`、GUI `c5e59e9f`、带 Unity Test Framework 的导入 `6a66763c` 均完成并确认退出。故意增加编译错误时捕获 `CS0103`（`d3507c5b`）。 |
| 6.3 EditMode 和 PlayMode | PASS | `a712b7af`、`b29f0a9d` 各 1 项通过。故意失败 `99f26e30` 返回 `UNITY_TESTS_FAILED`。主动取消 `26bb96f3` 和测试超时 `d185ce3b` 保持 Worktree 锁。 |
| 6.3 macOS Player 构建 | PASS | `2e9fbef8` 与 `be994c0a` 生成 `StandaloneOSX`，构建字节数均为 `106136183`。第二次构建的库存 SHA-256 为 `68fd7772bce92ab749a5a15162cd9ea372b9eed275dc20ff55987911dbd324f2`。 |
| 6.3 Mac Player 实际启动与场景 | BLOCKED | `2e9fbef8` 的 Player 收到 `SIGKILL`。`be994c0a` 初始化 Metal 后超时，30 秒独立原生复测同一应用仍没有场景回执。临时场景后台运行探针再构建 `ed33637e` 也收到 `SIGKILL`。应用嵌套签名静态校验通过，同时记录到 `amfid -423`。该日志也曾出现在 [Sprint 2.5.1 成功的 Player](sprint-2-unity-runtime.md#macos-player-和-amfi-诊断) 中，当前启动原因仍未确定。无可用签名身份，证书签名路径为 `PLAYER_SIGNING_REQUIRED`。系统策略未改动。 |
| 6.3 Editor Game View、截图和录屏 | PASS | 首次 `f6fcf921` 生成媒体但未确认退出，保留锁。复跑 `1bc9081a` 确认退出，读到中文路径、关键对象及技能回执。PNG 为 960×540，MP4 为 H.264、24 帧、3 秒，FFmpeg 完整解码通过。媒体来自 Editor Game View。 |
| 6.3 独立 Player 媒体 | BLOCKED | 未获得独立 Player 场景回执。 |
| Unity 2022.3 LTS 安装及精确版本匹配 | PASS | 隔离安装 macOS arm64 版 `2022.3.62f3`。DevHub 从真实 `ProjectVersion.txt` 和 `Unity.app` 匹配版本、发现 Build Support；实际 Batch 日志确认 `2022.3.62f3 (96770f904ca7)`，未使用 Rosetta。[Unity 2022.3.62f3](https://unity.com/releases/editor/whats-new/2022.3.62f3) |
| Unity 2022.3 LTS Asset Import 和 C# 编译 | BLOCKED | 原生 Editor 两次在导入前因 LicensingClient IPC 中止，均退出 `199`。`afc5c6b2` 原报 `UNITY_READY_UNCONFIRMED`，窄范围修复后复测 `d3f6bba3` 返回 `UNITY_LICENSE_UNAVAILABLE`，且退出未知时仍持锁。本机 Unity CLI 能识别活动许可。2022 Editor 的 IPC 仍未建立。 |
| Unity 2022.3 LTS EditMode 和最小 Player Build | NOT TESTED | 导入前的许可客户端阻塞阻止了后续两个阶段。 |

Game View PNG SHA-256 `1ed391cd4ecfb6afd3d1e95c170f0f32e75c64d339567f8f5896facfa2e5fdeb`，画面人工核查通过。MP4 SHA-256 `72de6abc813038f7d93e64fb3a7c6ad1704e3d0ab494d0eaa96ae563a581e943`，解码的 24 帧均不同。

## 多项目隔离

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 三项目注册、切换、任务、独立 Worktree、归档及重启 | PASS | Chrome 运行真实构建和本机 Hub，注册 3 个临时工程，分属 2 个 Git 仓库，各创建一个 Worktree。切换后任务隔离，归档后仍可查询历史。关闭并重启 Hub，浏览器可重新读回项目和任务。 |
| macOS Codex 原生项目边界 | PASS | 真实 SDK Turn `96cb9975` 完成并登记 Thread。同一原生沙箱允许写当前工程，拒绝读同仓兄弟工程和另一 Worktree 的合成文件。 |
| 三个独立真实 Codex Thread | PASS | A、B、C 的真实 Turn 为 `4e6f4776`、`bebb7748`、`b473f904`，Thread 摘要各不相同。分别写入自己的合成文件，重开数据库后任务和工作树归属保持隔离。 |
| 真实 Unity 媒体归属与 API 访问 | PASS | A 的 Game View `3020bf49` 已确认退出，同项目读取 PNG 和 MP4 均返回 200，跨项目均为 404。C 的 `fc0d22f5` 生成媒体，但退出不可确认，锁继续保留。 |
| 任务、凭据引用、媒体、规范和 API 跨项目拒绝 | PASS | 本轮集成测试使用实际本地 API、Git、SQLite 和工作树，验证不同项目的任务、授权、媒体 URL、Git 凭据引用与设计文档。远端 Provider、媒体和附加 Thread 数据使用合成记录。 |
| A/B/C 同一套实机验收的远端、版本、媒体和独立凭据 | BLOCKED | GitHub 与 macOS 原生结果可独立核验。未获得 B 的真实 GitLab 连接及三项目的联合端到端证据。 |

## SQLite 迁移

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| v0–v7 SQLite 文件备份回归 | PASS | 8 个合成库各创建 SQLite 在线备份，走实际 `openTaskStore` 两次。按源版本核对 Tasks、Execution Requests、Grants、Codex Runs、Unity Runs、Git Provider、凭据引用及 Project Registry，保留历史归属和歧义记录。二次打开 `user_version=7`，`PRAGMA integrity_check` 为 `ok`，`PRAGMA foreign_key_check` 返回空，源库版本保持。 |
| 实际历史业务数据库副本 | BLOCKED | 在 DevHub 工作区未找到可用于本轮的 v0–v7 历史业务库备份。当前证据来自按历史 schema 生成且存放于磁盘的合成备份。 |

本机原始回执和媒体保存在仓库忽略目录 `.devhub/v1-rc/`。DevHub 改动还包括 README、SQLite 回归、Unity 2022.3 许可 IPC 脱敏诊断、Git 管理表单和 Worktree 检出超时。GitLab 正式仓库的写入限于上述开发分支和草稿 MR。DevHub 与《山河问仙》的 `main` 均未直接写入，未自动合并。
