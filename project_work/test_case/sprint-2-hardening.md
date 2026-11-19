# Sprint 2.1 测试用例

以独立于游戏仓库的数据库、假凭据和测试任务验证。

| 范围 | 操作 | 预期 |
| --- | --- | --- |
| 默认数据库 | 在权限宽松的目录和已有文件中保留测试任务并重启 Hub | 收紧目录、数据库及已有事务文件，任务记录不变 |
| 外部数据库 | 将数据库指向已有安全目录，记录父目录权限再启动 | 父目录权限一致，数据库文件受保护。拒绝共享权限路径和符号链接 |
| Windows 事务文件 | 用当前用户 SID 创建目录及子文件，并检查 ACL | 默认目录与新建子文件没有其他普通主体的 Allow，既有外部目录的 DACL 一致 |
| 日志 | 写入多层对象、数组、子日志绑定和异常对象，注入假凭据 | 字段值脱敏，原对象与正常业务字段保留 |
| Doctor | 用边界版本测试 Windows 10、Windows 11、Windows Server、macOS 13.4/13.5 以及读取失败 | 版本、架构、客户端标志按支持门槛判定，JSON 与退出码一致 |
| Dashboard | 打开系统设置并重新检测，在新建任务页提交并重启 Hub 查看记录 | 显示实际系统版本和检查状态，任务列表仍可创建和恢复记录 |
| CI | 运行 Windows 和 macOS 作业 | 两组分别执行 frozen install、typecheck、test、build |
| 授权设计 | 评审过期、批准与撤销并发、内容改变、重复领取及 Runner 身份不符 | 事务和身份约束清晰。授权中心的功能测试待后续实施接口和执行器时加入 |

## 2026-11-19 本机证据

- macOS 14.5 arm64、Node.js 24.22.3 LTS、pnpm 11.25.0。frozen install、typecheck、build 和 doctor JSON 正常。Vitest 31 项通过，2 项 Windows 原生测试在本机跳过。
- 模拟覆盖 Windows 10、Windows 11 的最低 build、Windows Server、macOS 13.4/13.5、架构边界及版本查询失败。
- Chrome 验证系统设置展示并刷新实际版本。通过 Dashboard 创建任务，重启 Hub 后 API 读回一致。外部父目录的 `0751` 保留，数据库使用 `0600`。
- Windows ACL 由 Windows Server CI 验证。Windows 11 桌面 x64/arm64、macOS Intel 和非默认文件系统上的 ACL 或挂载策略另需实测。macOS 权限断言检查 POSIX mode bits。
