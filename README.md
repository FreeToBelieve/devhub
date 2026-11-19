# ShanHe DevHub

《山河问仙》的本机开发工作台，支持任务管理、Codex 执行授权、受管工作树，以及 GitHub 和 GitLab 代码交付。

## 启动

在仓库根目录执行。需要 Node.js 24 LTS、pnpm 11.25.0 和 Git。可用 `node -v` 和 `pnpm -v` 核对当前终端的版本。

Doctor 支持 Windows 11 客户端（build 22000 起）和 macOS 13.5 起的 x64、arm64 运行环境。Windows 通过 PowerShell CIM 读取系统版本和产品类型，Windows Server 会报告不符合桌面环境要求。macOS 版本门槛与 [Node.js 24 预编译包要求](https://nodejs.org/en/blog/migrations/v22-to-v24) 一致。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。可从 Dashboard 新建任务、展开任务详情或在系统设置里执行环境检测。按 Ctrl+C 退出 Hub。

| 操作 | macOS | Windows PowerShell |
| --- | --- | --- |
| 安装依赖并构建 | `./scripts/macos/install.sh` | `.\scripts\windows\install.ps1` |
| 启动 Hub 和 Dashboard | `./scripts/macos/start.sh` | `.\scripts\windows\start.ps1` |
| 检测环境 | `./scripts/macos/doctor.sh` | `.\scripts\windows\doctor.ps1` |
| 输出诊断 JSON | `./scripts/macos/doctor.sh --json` | `.\scripts\windows\doctor.ps1 -Json` |

也可从仓库根目录运行 `pnpm exec devhub doctor`、`pnpm exec devhub doctor --json` 或 `pnpm run doctor`。退出码 `0` 表示基础检查通过，`1` 表示基础环境有阻塞，`2` 表示参数无效。Codex、Unity 和 Unity 工程版本的警告只用于诊断。Unity 检查读取可执行文件路径和可选的 `ProjectVersion.txt`。

如 Windows 的执行策略限制 `.ps1`，可使用上面的 pnpm 命令。需要放在 `PATH` 上的 CLI 包括 Node.js、pnpm 和 Git。Codex CLI 的检测也使用 `PATH`。

## 本机配置

可在仓库根目录按 [.env.example](.env.example) 创建可选的 `.env`。当前终端的环境变量优先。数据库默认位于 `.devhub/devhub.sqlite`。

| 变量 | 用途 |
| --- | --- |
| `DEVHUB_PORT` | 本机监听端口，默认 `4317`。修改后用实际端口打开 Dashboard |
| `DEVHUB_DB_PATH` | 本机 SQLite 文件路径，可用绝对路径或相对仓库根目录的路径 |
| `DEVHUB_LOG_LEVEL` | 结构化日志级别，默认 `info` |
| `DEVHUB_UNITY_HUB_ROOT` | 自定义 Unity Hub Editor 根目录，内含 `6000.3.28f1` 版本子目录 |
| `DEVHUB_UNITY_PROJECT` | 可选的 Unity 工程根目录，内含 `ProjectSettings/ProjectVersion.txt` |
| `DEVHUB_UNITY_ARTIFACT_ROOT` | 独立运行产物根目录，默认 `.devhub/unity-runs` |
| `DEVHUB_UNITY_FFMPEG` | 可选的 FFmpeg 可执行文件绝对路径。未配置时从 `PATH` 查找 |

默认数据目录 `.devhub` 和 SQLite 文件在 macOS 分别使用 `0700`、`0600`，在 Windows 使用仅当前用户 SID 的受保护 DACL。配置外部路径时，Hub 保留父目录权限并检查其是否适合 SQLite 事务文件。macOS 的数据库和直接父目录须由当前用户所有，且父目录只允许所有者写入。Windows 外部父目录的 Allow ACE 只允许当前用户、SYSTEM 和内置 Administrators。目录及数据库应位于受信任的本机文件系统。路径为链接或权限无法安全应用时，Hub 会停止启动。

Hub 仅监听 `127.0.0.1`，请求使用同一地址和端口。应用可由同一台电脑上的进程访问。日志记录结构化运行信息，任务内容与凭据应分开保存。

## 本机 API

| 方法与路径 | 返回 |
| --- | --- |
| `GET /api/health` | Hub 状态 |
| `GET /api/tasks` | 按创建时间倒序排列的任务 |
| `POST /api/tasks` | 创建任务，返回 `201`、任务对象和 `Location` |
| `GET /api/tasks/:id` | 查询指定任务 |
| `GET /api/doctor` | 当前平台和逐项诊断结果 |

创建任务使用 JSON，字段为 `title`、`description` 和 `targetPlatform`。目标平台可选 `WINDOWS`、`MACOS` 或 `BOTH`，说明可传空字符串。新任务的状态为 `CREATED`。

## 本地执行授权

先完成构建。从本机交互式终端登记 Runner 和一个受信任、已提交且干净的 Git 工作树，再签发有效期五分钟的一次性启动凭据。Hub 和授权命令使用同一份 `.env` 与 SQLite 文件。

```sh
pnpm authorization runner-register "本机 Runner"
pnpm authorization worktree-register "/path/to/clean/worktree"
pnpm authorization bootstrap
```

从 Dashboard 的「授权中心」输入启动凭据。登录后选择任务、Runner 和工作树，填写 Thread ID 与白名单范围，提交并审查申请。批准的记录会显示授予 ID、请求版本和绑定摘要。以下命令通过父子进程间的本机 IPC 领取授权并返回审计回执。

```text
pnpm authorization runner-claim <runner-id> <grant-id> <version> <binding-digest> <idempotency-key>
```

凭据和 CSRF 值只用于本机登录和本机 IPC。操作员 Cookie 为 HttpOnly、SameSite=Strict、host-only。会话有效期八小时。申请最长十分钟，批准后的授予最长两分钟且不超过申请到期时间。

审批与领取会重查任务 revision、规范摘要、工作树身份和 HEAD。原有文件范围操作还要求干净工作树。Codex 操作改用受管工作树快照和 SDK 配置摘要，并重新审批每次 Turn。工作树策略要求普通 Git 索引，拒绝带外部 Git 内容过滤器、子模块或稀疏索引的工作树。工作树只允许受信任的本机用户登记。

接口、状态和迁移细节见 [Sprint 2.2 设计](project_work/requirement_docs/sprint-2-authorization.md)。验收路径见 [Sprint 2.2 测试](project_work/test_case/sprint-2-authorization.md)。

## Codex Developer Runtime

使用独立的私有 Codex 登录目录，通过现有 Codex CLI 的网页登录流程登录。将同一目录设置为 `DEVHUB_CODEX_HOME`。该目录用于认证与 SDK Thread 历史，配置文件与扩展留在日常 Codex profile 中。

macOS 要求目录与 `auth.json` 归当前用户所有，通常分别设置为 `0700` 和 `0600`。Windows 检查目录及认证文件 ACL，访问主体限于当前用户、SYSTEM 和内置管理员组。DevHub 只校验用户设置的权限。

如果模型服务需要本机 HTTP 代理，可显式设置 `DEVHUB_CODEX_PROVIDER_PROXY` 为带端口的 `http://127.0.0.1` 地址。代理只用于模型服务传输。工具网络保持关闭，进程环境中的代理变量需要通过该配置明确选择。

```sh
pnpm build
pnpm authorization runner-register "本机 Runner"
pnpm codex-runtime worktree-create "/path/to/clean/test-repo"
```

在 Dashboard 的「授权中心」选择受管工作树和 Runner，发起并批准「Codex 新 Thread」或「Codex 恢复 Thread」。`PROJECT_DEVELOPER` 允许读写整棵工作树，开发网络默认关闭。选择 `DEVELOPER_ALLOWLIST` 时，Codex 可通过受控工具下载公共 UPM、npm 和 GitHub 依赖。Shell 的网络保持关闭。将审批时使用的同一份 UTF-8 提示词交给终端命令的标准输入。换行也属于摘要输入。Windows PowerShell 可用 `Get-Content -Raw` 配合 UTF-8 输入管道，或直接从 CMD 重定向文件。

```text
pnpm codex-runtime run <grant-id> <version> <binding-digest> <idempotency-key> < prompt.txt
```

Dashboard 的「Codex 执行」增量读取脱敏事件和诊断，可请求取消。终端中也可按 Ctrl+C。每个新 Turn 和权限变化都需要新批准。运行时使用预授权策略。工作树发生中断且无法确认进程已退出时，保留工作树锁和审计记录，新的任务可通过 Git Adapter 创建另一工作树。

快照包含已跟踪、未跟踪和普通忽略项。只有明确被 Git 忽略且没有已跟踪子项的根级缓存可跳过。审批预览可复用文件哈希，Runner 领取时重新流式计算源文件摘要。项目需使用普通 linked worktree，避开符号链接、额外硬链接、特殊文件、子模块和仓库内 Codex 配置。Git 元数据留给 Git Adapter。

配置 `DEVHUB_CODEX_HOME` 后，可显式运行 `pnpm codex-runtime:smoke`。这会使用登录账号在临时仓库发起三次 SDK Turn。

下载代理、运行时审批、快照和生命周期的详细边界见 [Sprint 2.3B 设计](project_work/requirement_docs/sprint-2-developer-mode.md) 和 [验收记录](project_work/test_case/sprint-2-developer-mode.md)。

macOS 可在授权中心为本次 Turn 选择 `DEVELOPER_CONNECT`，运行受控 npm、pnpm、Git 和 Unity 公共归档命令。工作树秘密检测、CONNECT 网络边界及 VM Runner 方案见 [Sprint 2.3C 设计](project_work/requirement_docs/sprint-2-developer-completion.md) 和 [验收报告](project_work/test_case/sprint-2-developer-completion.md)。

## Unity 6.3 运行自动化

在目标机器安装 `6000.3.28f1` 和本机平台的 Build Support，激活 Editor 许可证。运行 Player 和采集 Game View 需要桌面图形会话，录制还需要支持 H.264 的 FFmpeg。将本仓库 `packages/unity-adapter/unity-package` 复制到独立测试工程的 `Packages/com.devhub.unity-automation` 并提交到源测试仓库。测试工程须安装 Unity Test Framework，场景验证须提供 Runtime bridge 使用的测试输入组件和关键对象。参考 [`scripts/unity-fixture`](scripts/unity-fixture/) 中的示例。

通过 `pnpm codex-runtime worktree-create` 创建受管 Worktree。在 Dashboard 登录授权中心，进入「Unity 测试」，选择 Task、Runner 和工作树，创建申请、批准，再启动。Editor、导入与编译、EditMode、PlayMode、构建、Player 和 Game View 可以分别发起。场景路径和采集设置随申请绑定。Unity 会以本机用户身份执行受信工程的代码。

在运行报告中查看 C# 诊断、测试结果、构建报告、脱敏日志和渲染媒体。失败且进程退出已确认时可为原 Codex Thread 生成提示词和新审批申请。修复完成后，重新审批 Unity 运行，通过后在「Git 管理」审查新的候选 Tree 并按原有审批流程交付。

构建完成后可用 `node scripts/smoke-unity-runtime.mjs A` 到 `E` 跑对应阶段的临时工程实测。`DEVHUB_UNITY_SMOKE_ARTIFACTS` 可指定保留证据的私有目录。阶段 E 需要独立的已登录 Codex profile。详情见 [Sprint 2.5 技术设计](project_work/requirement_docs/sprint-2-unity-runtime.md) 和 [实机验收记录](project_work/test_case/sprint-2-unity-runtime.md)。

## GitHub 和 GitLab 交付

首次配置使用独立测试仓库。登录授权中心后，打开「Git 管理」，登记仓库 HTTPS URL 和该项目的令牌。GitHub 使用目标仓库的 Contents 与 Pull requests 读写、Checks 与 Commit statuses 读取权限。GitLab 需要 MR API 访问和 Git 写入权限。自建 GitLab 可设置例如 `https://gitlab.example.com:9998/api/v4` 的 API Base URL，使用与仓库相同的 HTTPS origin、可验证的证书和公网 IPv4 或 IPv6 DNS。撤销按钮清理当前 DevHub 的系统凭据引用和条目，服务端令牌可在 Provider 设置中吊销。

直连不稳定时可在 Hub 中显式设置 `DEVHUB_GIT_HTTPS_PROXY=http://127.0.0.1:7890`，指向操作员信任的本机 CONNECT 代理。DevHub 仍逐次解析并固定公网 IP，在隧道内校验原主机的 TLS 证书。这项配置只应用于 Hub 的 Git 集成。

1. 用干净的本地克隆创建 `devhub/` 开发分支和受管 Worktree。源克隆 HEAD 须与远端默认分支一致。
2. 在授权中心批准 Codex 任务。任务结束后回到 Git 管理页，选择任务和 Worktree，填写 Git 作者和 PR/MR 说明。
3. 审查变更清单并批准摘要。两分钟内执行交付，依次确认本地 Commit、远端 Push 和 PR/MR。失败可检查阶段和诊断，重新批准原记录并继续。
4. 在 PR/MR 详情读取差异、评论与 CI。编辑已审阅的指令并创建续跑申请，再按 Codex 命令审批和运行。使用同一个 Worktree 交付，已有 PR/MR 会更新。

凭据保存在 macOS Keychain 或 Windows Credential Manager。Git 元数据和远端写入由 DevHub 负责。交付功能只推送开发分支，不提供强推和合并。安全设计与平台记录见 [Sprint 2.4 设计](project_work/requirement_docs/sprint-2-git-providers.md) 和 [验收报告](project_work/test_case/sprint-2-git-providers.md)。

## 开发验证

```sh
pnpm typecheck
pnpm test
pnpm build
```

GitHub Actions 使用 Windows Server x64 与 macOS arm64 运行锁定依赖安装、类型检查、Vitest 和构建。Windows Server 作业验证原生 ACL 和构建，Windows 11 桌面仍需单独验收。

加固范围和授权中心接口见 [Sprint 2.1 设计](project_work/requirement_docs/sprint-2-hardening.md)。验收路径和平台覆盖见 [Sprint 2.1 测试记录](project_work/test_case/sprint-2-hardening.md)。
