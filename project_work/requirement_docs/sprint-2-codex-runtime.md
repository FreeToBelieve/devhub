# Sprint 2.3 Codex Developer Runtime

以 `main@6ed46207` 为基线，提供单机、经审批的 Codex SDK Turn。工作树归 Git Adapter 管理，每次 Turn 独立留存 DevHub ID、两个输入摘要和脱敏事件。真机验收使用与游戏工程分离的测试 Git 仓库。

- Runner 向 SDK 请求 `workspace-write` 和 `on-request`，关闭工具网络、Apps 和插件。域名策略与模型传输环境分别维护。SDK 0.170.0 底层的无界面 CLI 对用户审批采用 `never`，当前交互式提权不可用。DevHub 的 Turn 审批在启动前生效，运行时没有自动提权。[上游 CLI 实现](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/exec/src/lib.rs#L607-L650)
- 专用 Codex 登录目录与工作树分离，子进程只接收运行所需环境字段。DevHub 的 GitLab 凭据不进入传输。DevHub 不读取或复制已有登录凭据。
- 新 Thread 的服务端 ID 由 SDK 事件确认。继续 Thread 仍需新批准、工作树快照和新 Turn 记录。Provider Turn ID 在 SDK 提供前为空。

## 运行与审计

- Git Adapter 从干净的本机 Git 根目录创建 detached linked worktree。Codex 使用整个工作树的 sandbox 写入范围。授权绑定 HEAD、工作树登记值与快照；快照覆盖普通文件内容和模式。恢复允许已有工作树的修改，以新快照重新审批。
- Runner 通过已有匿名 IPC 领取 `codex.turn` 授予，领取和 `codex_runs` 预留同事务提交。工作树部分唯一索引阻止同时启动两条 Turn。各次 Turn 独立绑定 `devhubRunId`、`promptSha256`、`sdkConfigSha256`。恢复匹配已有 Thread、同一工作树和同一配置。
- SDK 本地 Thread 会话由专用 profile 保管。`codex_run_events` 顺序保留事件类型、Thread ID、文件数量和命令退出码。原始提示词、模型文本、命令字符串及标准输出由 DevHub 事件投影排除。
- `GET /api/codex-runs` 和 `GET /api/codex-runs/:id/events?after=…` 供登录后的 Dashboard 增量读取。取消使用会话、精确 Origin 和 CSRF，并通过 AbortSignal 传给 SDK。
- 工具网络缺省关闭，域名决策以 HTTPS、精确名称和显式启用为前提。模型服务传输通过独立环境白名单，默认直连，可显式使用无凭据的本机 HTTP 代理。所选代理纳入配置摘要。后续启用工具代理时，转发器还须在建立连接时应用域名、DNS 和地址策略。

SDK 行为见 [OpenAI Codex SDK 文档](https://learn.chatgpt.com/docs/codex-sdk)。
