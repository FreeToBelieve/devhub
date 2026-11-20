# Sprint 2.8 验收报告

基线 `2fa881a8db3e3a4b317eb52407b220bc065e2e89`，分支 `feature/sprint-2-github-codex-session`。

## 本机自动化

macOS 14.5 arm64，Node.js 24.22.3，pnpm 11.25.0。

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm build` | PASS |
| `pnpm test` | 15 个文件通过，123 项通过，9 项跳过 |
| `pnpm run doctor` | 基础环境通过，发现 Unity 6000.3.28f1。未配置 Doctor 工程路径，Unity 授权未验证 |
| Chromium Dashboard | 登录门禁、Inbox 表单、原生 Host 连接和断开通过 |
| 本机 Keychain | 独立运行合成凭据写入、读取与幂等清理测试，通过 |
| SQLite v0–v9 → v10 | 10 个历史结构副本分别重复打开。保留任务、授权摘要、历史 Thread、Unity 运行与 Git 引用，完整性和外键检查通过 |
| 并发 | Worker Threads 各自打开 SQLite，用屏障同时进入真实写事务。同一项目三个 Codex Session 和跨项目的第四个都领取成功。重复领取和同 Thread 注册竞争各只有一个成功。不同树 Unity 与 Git 交付可并行 |
| 原生 Host 锁 | 独立子进程竞争同一数据库路径的 OS 锁和独立 SQLite 连接竞争租约。两项均拒绝第二个持有者 |
| 队列与安全 | 验证去重、Head 更新撤销旧审批、关闭 PR、Host 断开、重启、项目归档隔离、错误作者、fork、路径越界、blob 伪造、Origin 与 CSRF。未确认退出时持续占用 Worktree |
| 执行链路 | 用临时 Git 仓库、真实 Worktree、Runner IPC 和授权事务走完整流程。GitHub 和 SDK 流使用合成数据。初始 Turn 和 Unity 失败后的续跑使用同一测试 Thread，分别消耗独立批准 |

## 真实服务与桌面边界

| 项目 | 结果 |
| --- | --- |
| 私有 Inbox PR #1 | PASS。通过 GitHub REST 读取并使用 Inbox 校验器核对仓库 ID `1465512371`、开放 Draft、作者和分支。Head `63ee2d8572c4ce50728f10cc3c95c85025ecefc6`，任务 blob `6743e04b1be82393c7d9c94ee9d4cc91efc23ac4`，正文 6736 字节。此项使用已登录 GitHub CLI 只读访问 |
| DevHub HTTPS 传输 | PASS。经本机受信 CONNECT 代理固定公网 IP 并校验 GitHub TLS，公开 API 返回 HTTP 200 |
| DevHub MCP 项目读取 | PASS。现有连接查到任务指定项目为 ACTIVE，Unity 版本 `6000.3.28f1` |
| 应用内真实 Listener 首次投递 | BLOCKED。需在本机 Dashboard 登记专用 Inbox 只读凭据 |
| 真实 Codex Turn、Unity 实机结果、GitLab MR 与本次结果的 MCP 回读 | BLOCKED。需完成真实投递并取得绑定任务、工作树和配置的审批。Unity 和 Git 交付各有独立审批 |
| Windows 11 x64 桌面验收 | NOT TESTED。暂无桌面测试机。Windows Server CI 结果见 Draft PR 的 Checks |

## 手动复验

进入「GitHub 任务收件箱」，登记独立只读凭据并启用监听。选择已登记本机 Runner 连接 Host。打开消息，确认 PR Head 和目标项目，准备审批并在授权中心批准。记录 Task、Session、Worktree、Thread 和每次 Run 的对应关系。推送同一任务 PR 的新 Head 后核对最新版本是否使用原 Session、原 Worktree 和原 Thread，以及旧授权是否已撤销。
