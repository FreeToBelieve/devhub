# Sprint 2.2 测试

| 路径 | 验收 |
| --- | --- |
| 旧任务和重启 | 打开 Sprint 2.1 数据库，任务内容原样读回并获得 revision 1。重启后继续查询申请、授予和审计。 |
| 操作员会话 | 一次性凭据只能交换一次。校验 Cookie 属性、Origin、CSRF、会话过期和注销。检查持久层与日志不含原始凭据。 |
| Runner | 登记本机设备，通过真实子进程 IPC 领取。操作者会话、另一设备身份和其他平台均无法领取目标授予。 |
| 状态和竞争 | 竞争审批、撤销、领取，检查只有合法操作成功，审计和资源状态一致。过期、重复领取、陈旧版本与重复幂等键按契约返回。 |
| 任务与 Git | 改变任务 revision、工作树内容或 HEAD，验证旧授权失效。拒绝任意命令、路径逃逸和不在白名单的操作。 |
| Dashboard | 用终端签发的凭据登录授权中心，提交并审查申请，执行批准或撤销，重新加载后查看状态。 |
| 回归 | macOS 与 Windows CI 执行 frozen install、typecheck、test 和 build。测试使用独立仓库、模拟线程 ID 和真实本机 IPC。 |

## 2026-11-19 本地证据

- macOS 14.5 arm64、Node.js 24.22.3 LTS 上，frozen install、typecheck、build、Doctor 及 45 项 Vitest 通过，2 项 Windows 原生 ACL 用例按平台跳过。
- 在临时资源上，两个独立 CLI 进程同时竞争同一授予，只有一个领取成功。覆盖拒绝、撤销、重试键冲突、过期、会话/Runner 交叉攻击、任务和 Git 漂移，以及文件库重启恢复。
- Chrome 验证本机登录、HttpOnly 和 SameSite=Strict、申请、审批、原生 Runner 领取、重新加载会话、审计与注销。页面未写入 localStorage 或 sessionStorage，非交互式终端签发被拒绝。
