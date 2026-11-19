# Sprint 1 工程骨架

以《ShanHe DevHub v0.1 技术架构与第一阶段实施任务书》的 Sprint 1 和本次实施要求为范围。Windows 11 与 macOS 使用同一源码和依赖锁，任务数据按本机保存。

- Dashboard 可显示总览、新建任务、浏览任务和查看环境。Codex、Unity 测试、GitLab MR 页面展示集成状态。
- Hub 提供健康检查、任务读写和环境检测。新任务从 `CREATED` 开始，重启后可读取。
- `devhub doctor` 检查 Node 24 LTS、pnpm、Git、Codex CLI 和指定版本的 Unity 安装路径。支持人读输出及 JSON。Unity 检查只读取文件系统。
- Windows 和 macOS 共享 pnpm 命令，各有安装、启动及诊断脚本。运行数据、凭据和本机配置由 Git 忽略规则覆盖。
- 本 Sprint 的安全边界是本机回环接口、输入校验、同源校验和结构化日志脱敏。执行调度、GitLab 和 Unity 自动化属于后续 Sprint。

验收路径见 [Sprint 1 测试用例](../test_case/sprint-1.md)。
