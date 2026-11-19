# Sprint 2.1 前置加固

Sprint 1 把任务保存在本机 SQLite 中，日志脱敏只覆盖了少量固定路径，Doctor 也只能识别操作系统家族。本次保护数据库及事务文件，补齐日志与平台检查，并通过 Windows 和 macOS CI 验证。授权中心在本次交付接口和数据模型设计，现有任务创建流程继续只登记任务。

## 实施与兼容

| 项目 | 设计及验收 |
| --- | --- |
| SQLite | Hub 管理的默认 `.devhub` 目录在 macOS 使用 `0700`，数据库和已有事务文件使用 `0600`。Windows 为默认目录和数据库文件设置仅当前用户 SID 的受保护 DACL。已有任务可原样读回。 |
| 外部路径 | 保留用户指定目录的权限。Windows 要求外部父目录的 Allow ACE 仅涉及当前用户、SYSTEM 或内置 Administrators，防止新建事务文件继承共享权限。POSIX 拒绝组或其他用户可写的直接父目录。路径不可安全使用时，Hub 在打开 SQLite 前停止。 |
| Pino | 按字段名递归清理结构化对象、数组、子日志绑定和结构化插值。常见字段的大小写、下划线和连字符变体走同一规则。普通日志消息继续使用无凭据文本。 |
| Doctor | Windows 11 客户端需 build 22000 或以上，macOS 需 13.5 或以上，支持 x64 和 arm64。系统版本无法读取时诊断失败，Hub 仍可返回诊断报告。 |
| CI | PR 和 `main` 运行 Windows、macOS 矩阵，使用 Node 24 LTS、仓库锁定 pnpm 和 frozen install，再运行 typecheck、Vitest 和生产构建。 |

macOS 门槛基于 [Node.js 24 预编译包要求](https://nodejs.org/en/blog/migrations/v22-to-v24)。Windows 结合系统 build 和 [Win32_OperatingSystem.ProductType](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem) 区分客户端与 Server。SQLite 仍保留 [磁盘事务日志](https://www.sqlite.org/tempfiles.html)。如退出此分支，既有数据库记录可被 Sprint 1 读取，已收紧的文件权限应保留。

## 本地任务执行授权中心设计

### 信任与授权边界

- Hub 是策略及审批的唯一写入者。仪表板的任务登记、预检通过、回环地址和请求的 Origin 均不能单独授予执行能力。
- 后续实现由本机启动器向操作员提供一次性、高熵的启动凭据，以同源浏览器会话换取有限期、`HttpOnly`、`SameSite=Strict` Cookie。服务端只存会话摘要，审批请求同时校验会话、精确 Origin 和 CSRF 值。会话与凭据到期即失效。
- Runner 用经本机安全通道建立的独立身份连接 Hub，审批接口与领取接口分别按主体授权。Runner 身份绑定经注册的设备实例和平台，操作员审批能力不授予 Runner。
- 策略缺省拒绝。只允许服务端登记的操作及参数模型。审批绑定 `taskId`、任务规范版本、Runner、平台、项目内的目标、能力范围和短期有效期。有任务内容、目标、参数或政策版本变化时重新提交。审批界面展示实际范围和到期时间。
- 项目路径由 Hub 从本机注册信息解析，Runner 领取前复核真实路径、预期工作树、批准的操作摘要和剩余有效期。运行能力须由以后实现的执行器独立限制。授权层只发放一次性执行资格。

### 拟议接口

| 方法与路径 | 调用方 | 输入和行为 |
| --- | --- | --- |
| `POST /api/execution-requests` | 操作员 | 输入 `taskId`、`taskRevision`、`runnerId`、`operation` 与经模式校验的 `scope`。Hub 规范化内容并生成摘要。要求 `Idempotency-Key`，相同主体、键和摘要返回已有请求，摘要不同时返回 `409`。 |
| `GET /api/execution-requests/:id` | 操作员 | 返回操作摘要、有限期、当前状态和脱敏审计事件。 |
| `POST /api/execution-requests/:id/decision` | 操作员 | 输入 `approve\|deny`、预期版本和可选的非敏感原因码。批准生成有限期授予记录。 |
| `POST /api/execution-requests/:id/revoke` | 操作员 | 用预期版本撤销还未领取的批准，重复撤销返回现有状态。 |
| `POST /api/runner/grants/:id/claim` | 已认证的目标 Runner | 领取绑定的授予，校验操作摘要、目标、版本和有效期。成功返回精确操作描述，授权原子消耗。 |

主体无权调用返回 `401/403`，过期、状态冲突、版本不符或重复领取返回 `409`。操作枚举包含 `workspace.write` 和 `process.run` 两类设计能力，使用经登记的项目相对路径或可执行项 ID 及类型化参数。禁止通过字段传入任意 shell、凭据或未登记的网络目标。接口、审批 UI、数据库迁移和执行器均属于后续实施。

### 拟议 SQLite 模型

| 表 | 关键字段与约束 |
| --- | --- |
| `execution_requests` | `id`、`task_id` FK、`task_revision`、`runner_id`、`target_platform`、`operation`、`scope_json`、`scope_sha256`、`policy_version`、`status`、`row_version`、`created_by`、`idempotency_key`、`created_at`、`expires_at`。唯一键 `(created_by, idempotency_key)`，索引 `(runner_id, status, expires_at)`。 |
| `execution_grants` | `id`、唯一 `request_id` FK、`approved_by`、`approved_at`、`expires_at`、`claimed_by`、`claimed_at`、`revoked_at`。授予到期不得晚于对应请求。 |
| `execution_audit_events` | `id`、`request_id` FK、`actor_kind`、`actor_id`、`event_kind`、`reason_code`、`scope_sha256`、`created_at`。以 `(request_id, id)` 读取事件序列。应用只追加事件，日志保留非敏感摘要。 |

请求从 `PENDING` 到 `APPROVED`、`DENIED` 或 `EXPIRED`。已批准请求可到 `CLAIMED`、`REVOKED` 或 `EXPIRED`。审批、撤销和领取都在单个 SQLite 写事务中执行，带状态、时效和版本条件更新，同时追加审计。领取响应丢失时可查询结果，发生冲突不重放执行，需重新发起审批。领取只授予执行资格，不能把任务标记为完成或再次拉起执行。迁移采用新表，保持现有任务数据及 ID 兼容。

验收用例见 [Sprint 2.1 测试用例](../test_case/sprint-2-hardening.md)。
