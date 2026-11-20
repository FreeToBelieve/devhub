# DevHub MCP Bridge 架构

ChatGPT 通过 OpenAI Secure MCP Tunnel 调用官方 `tunnel-client`。客户端启动 `apps/mcp-server` 的 stdio 子进程。开发者也可以让本机 MCP 客户端连接回环 Streamable HTTP 端点。两种传输使用同一个 MCP SDK（`@modelcontextprotocol/sdk` 1.32.2）和同一套只读工具。

Bridge 将类型化操作交给回环 Hub API。Hub 使用 Project Registry、Task Store、Codex Runtime 的持久化记录、Unity 的报告和 Artifact Manager、Git Delivery 和 Git Provider。Bridge 进程本身没有仓库、SQLite、命令执行或系统凭据接口。

| 范围 | 读取内容 |
| --- | --- |
| 项目 | 注册记录、运行环境、最近活动、登记的 Markdown 文档 |
| 任务 | 状态、修订时间、已有授权活动 |
| Codex | Run、Thread ID、状态、事件、变更文件数量、安全诊断码 |
| Unity | 构建、测试、环境、日志节选、PNG、MP4 元数据和受限 MP4 资源 |
| Git | 已交付 Commit、候选 Diff、DevHub 跟踪的 PR/MR、Review、CI |

Git 列表取自 DevHub 的交付记录。详情通过项目绑定的 Provider 查询远端。Codex 事件保持已有的脱敏粒度，Token 用量未被 Runtime 持久化，返回 `null`。任务修订时间从 SQLite v8 起记录，缺少历史时间字段的旧任务返回 `null`。

运行 `pnpm mcp tools` 查看工具目录。通过 MCP Resources 可读 `devhub://projects` 及其按项目 ID 命名的任务、规范、Git 和执行资源。分页资源使用 `?offset=`，调用者根据 `nextOffset` 继续读取。Unity 产物 URI 包含项目、运行和产物 ID。截图通过 MCP Image Content 或 PNG Resource 返回。超限录屏返回元数据和同一次运行中已发布的审核帧引用。审核帧的可用性取决于 Unity 运行时原有的采集设置。

写能力保留关闭。未来写接口需有可验证的调用者和操作员绑定，且复用任务校验、请求审批、Runner Claim、Worktree 锁和 Git Candidate Tree。Sprint 2.7 不注册写工具。停用时可退出 Bridge 和撤销配对，存量 Hub 和执行流程继续使用。

### Resource 表示

| URI（相对 `devhub://projects`） | MIME 与内容 |
| --- | --- |
| 空路径 | JSON，项目概要 `items`、`nextOffset` |
| `/{projectId}/overview` | JSON，`project`，以及按权限返回的 `recentTasks`、`recentCodexRuns`、`recentUnityRuns` |
| `/{projectId}/tasks` | JSON，任务对象 `items`、`nextOffset` |
| `/{projectId}/codex-runs` | JSON，脱敏运行记录 `items`、`nextOffset` |
| `/{projectId}/unity-runs` | JSON，Unity 运行摘要 `items`、`nextOffset` |
| `/{projectId}/git` | JSON，`connection`、`currentBranch`、`headSha`、`recentOperations` |
| `/{projectId}/documents/{documentId}` | JSON，`id`、`kind`、`text`、`nextOffset` |
| `/{projectId}/unity-runs/{runId}/report` | JSON，运行 ID、任务 ID、版本、状态、时间、诊断及阶段 |
| `/{projectId}/unity-runs/{runId}/artifacts` | JSON，产物 ID、类型、MIME、大小、SHA-256、时间及可用资源 URI |
| `/{projectId}/unity-runs/{runId}/artifacts/{artifactId}/image` | `image/png`，Base64 blob |
| `/{projectId}/unity-runs/{runId}/artifacts/{artifactId}/recording` | `video/mp4`，Base64 blob；超限时返回 JSON 元数据和审核帧 |
