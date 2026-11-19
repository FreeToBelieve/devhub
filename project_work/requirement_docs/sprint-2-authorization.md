# Sprint 2.2 本地执行授权中心

基于 main `c8ee763`，落实 [Sprint 2.1 授权设计](sprint-2-hardening.md)。授权中心提供本机登录、设备和工作树登记、审批、一次性领取及审计。领取产生审计回执，执行引擎由后续 Sprint 实现。

- 本机受信任的交互式 Hub CLI 签发短期一次性启动凭据。SQLite 只保存摘要。交换时检查精确 Origin，浏览器收到 host-only、HttpOnly、SameSite=Strict Cookie。审批、注销和其他写请求同时校验会话及 CSRF。
- Runner 登记绑定本机设备标识和平台。受信任的 Hub CLI 通过内核创建的匿名父子 IPC 管道启动 Runner 验证进程，短期 Runner 凭据仅通过该通道交接。Runner 领取不暴露为浏览器 HTTP 入口。
- 创建、批准和领取均读取当前任务规范、登记工作树和 Git HEAD。审批绑定任务规范摘要、任务 revision、repo/worktree ID、HEAD、Codex Thread ID、Runner ID、平台、类型化范围和策略版本。发现规范或工作树变化时撤销仍有效的申请，保留历史记录。
- SQLite 增量迁移保留旧任务并补入 revision 1。审批、撤销、领取、过期、幂等记录和审计由事务及版本条件更新保护。重复领取不会返回可执行授权。
- 首版白名单包括限定路径的 `workspace.write` 与固定命令枚举的 `process.run`，审批范围只作为结构化数据交付。当前本机同用户进程可直接操作其本机数据，系统管理员权限及本机已被入侵的情况由操作系统边界处理。

## 接口

| 接口 | 规则 |
| --- | --- |
| `POST /api/operator/session` | 使用 JSON 的 `bootstrapCredential` 一次性交换 Cookie 和 CSRF。同源请求才可交换。 |
| `GET /api/operator/session`、`DELETE /api/operator/session` | 恢复同一会话的 CSRF 或注销。注销校验 Origin 和 CSRF。 |
| `GET /api/authorization/catalog`、`GET /api/authorization/worktrees/:id` | 已登录操作员读取登记项和当前可审批的工作树。 |
| `PUT /api/tasks/:id/spec` | 操作员通过 `expectedRevision` 更新任务规范，并在同一事务作废该任务的有效申请。 |
| `POST /api/execution-requests`、`GET /api/execution-requests[/:id]` | 创建、列出申请，或读取详情及审计。创建校验 CSRF、精确 Origin 和 `Idempotency-Key`。 |
| `POST /api/execution-requests/:id/decision`、`POST /api/execution-requests/:id/revoke` | 操作员提交预期版本、幂等键并进行事务化审批或撤销。 |
| `pnpm authorization runner-claim …` | 受信任本机控制命令通过匿名父子 IPC 将短期凭据发送给绑定设备的 Runner。Runner 发出领取请求后接收回执。重复领取返回冲突。 |

## 持久化与边界

- 任务规范摘要由服务端对标题、说明和目标平台的固定顺序编码生成。申请保存规范化绑定 JSON、独立 SHA256 和任务、Runner、工作树外键。
- 原子写使用 `BEGIN IMMEDIATE`，以状态和乐观版本更新申请，同时写入授予、领取状态、幂等记录及审计。幂等重试返回原申请的当前状态。同一键换内容返回冲突，重复领取一律拒绝。
- `PENDING` 可批准、拒绝、过期或因上下文变化撤销。`APPROVED` 可领取、撤销或过期。终态保留为历史记录。
- HTTP 写入必须匹配确切的回环 Origin。浏览器同源 GET 可能省略 Origin，此时仍验证 Host 和会话，响应不开放跨源读取。启动凭据只在受信任的交互式 CLI 显示，操作员须使用未录制的终端。浏览器页面只在内存保留必要请求值。
- 工作树校验覆盖核验时可见的 HEAD、工作树身份和 Git 文件状态。发生漂移时作废原授权。校验和未来执行之间的文件变化需要执行器在落地实际动作前再次验证。

验证路径见 [Sprint 2.2 测试](../test_case/sprint-2-authorization.md)。
