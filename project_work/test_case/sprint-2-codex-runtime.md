# Sprint 2.3 验收

| 层级 | 证据 |
| --- | --- |
| SDK 配置 | 工作树范围写入、审批模式、工具网络和环境白名单 |
| 授权 | 原子领取、指定工作树、上下文漂移、提示词和配置摘要 |
| Turn | ID、事件增量、取消、恢复及旧数据迁移 |
| Dashboard | 登录后读取实时状态、审计事件及取消 |
| 实机 | 临时 linked worktree。记录账号方式、文件读写、命令结果、事件、取消和恢复 |

## macOS 实测

macOS 14.5 arm64、Node.js 24.22.3 LTS、pnpm 11.25.0、Codex SDK 0.170.0。`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test` 和 `pnpm build` 通过。Vitest 共 6 个文件，49 项通过，2 项 Windows 专属测试跳过。

- 使用 `main@6ed46207` 的迁移在临时文件中创建 SQLite v1 数据库。新版本升级到 v2 后保留了原任务和 revision，外键检查通过。
- 本机 Chrome 使用模拟 SDK，验证审批提示词摘要、Dashboard 实时刷新和会话保护的取消请求。
- `pnpm codex-runtime:smoke` 使用已登录的 ChatGPT 账号、独立登录目录和显式本机模型代理。只访问临时测试仓库和其 detached linked worktree。三个 Turn 的 Provider Thread 摘要均为 `8682993c64bb9923`，SDK 配置摘要均为 `fea74434eb207c65f32c677ab7d669e5cb598a653e502edf2e9113d0d79acf63`。

| DevHub Run ID | 持久化状态 | 验收证据 |
| --- | --- | --- |
| `30255c88-174c-48eb-9003-4418077b874b` | `COMPLETED` | 9 个事件。首次命令返回 127，重试返回 0。读取种子文件并在工作树创建验收文件 |
| `36df4738-f2f6-4a64-807f-12015f715859` | `CANCELLED` | 2 个事件。收到 `turn.started` 后通过 AbortSignal 取消，延迟写入文件未出现 |
| `2559902f-6828-49cf-a1f3-d6388bc70429` | `COMPLETED` | 7 个事件。继续同一 Thread，命令返回 0，验收文件新增预期的第二行 |

每个 Turn 都保留独立提示词摘要。三个 Provider Turn ID 都为空。测试末尾验证源工作目录没有验收文件，linked worktree 的 `.git` 指针内容保持一致。

## Windows 验收边界

Windows GitHub Actions 使用 Windows Server，覆盖锁定依赖、类型检查、Vitest 和构建。本轮环境没有已登录 Codex 的 Windows 11 主机。真实账号调用、Windows 沙箱初始化、文件写入、取消和恢复需在该平台运行同一个冒烟脚本验证。
