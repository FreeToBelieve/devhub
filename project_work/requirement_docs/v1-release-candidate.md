# ShanHe DevHub V1 发布候选验收

验收基线为实际获取的 `FreeToBelieve/devhub` `main@e83c732cb349f989cc30abf413d40dc2dee7614f`。本轮补发布验证、README 首次操作路径，以及 Unity 2022.3 在许可客户端 IPC 中止时的脱敏诊断。正常回退到旧许可系统的提示继续按原运行结果判断。执行、授权、Git 传输、Unity 运行和 SQLite 模型沿用 Sprint 2.x。

| 门槛 | 应采集的证据 |
| --- | --- |
| 首次启动 | 干净检出后锁定依赖、构建、启动回环 Hub。通过 Dashboard 登录、登记项目、创建任务和 Worktree，按文档操作 Codex、Unity 和 Git 交付。 |
| Windows 11 x64 | 桌面实机运行 Node 24、Codex、Developer Mode、Credential Manager、Git Provider、Unity Editor、Batch 和测试。Windows Player 实际启动，并取得截图、录屏和可靠的退出与互斥证据。 |
| GitHub 和 GitLab | 读取默认分支，生成开发分支，审批候选 Tree，完成提交、Push、创建并更新同一 PR/MR，读回差异、评审及检查。GitHub 使用独立测试仓库。GitLab 依用户明确授权，在正式《山河问仙》的专用开发分支验证 Push 和草稿 MR。 |
| Unity 多版本 | 用准确的 `6000.3.28f1` 完成 Editor、导入、编译、EditMode、PlayMode、Player 和媒体。实际安装的 `2022.3` 另验证版本匹配、导入、编译、EditMode 和最小构建。测试工程均独立于正式游戏。 |
| 项目隔离 | 三个项目的任务、Worktree、Thread、凭据、版本、媒体和规范可分别归属。浏览器切换和归档、Hub 重启恢复及跨项目访问拒绝需取证。证据标明真实 Provider、Editor 或 Codex 参与的环节。 |
| SQLite | 复制历史 v0–v7 数据库并逐个打开工作副本，再重复打开。验证任务、申请、授予、Codex 和 Unity 运行、Git Provider、凭据引用与 Project Registry，要求 `PRAGMA foreign_key_check` 无异常。合成库也走备份文件和真实存储入口，单独报告。 |
| 回归 | Node 24 下运行 frozen install、typecheck、Vitest、build、`pnpm doctor` 和 DevHub Doctor。核对实际基线上的 macOS、Windows Server 作业，再复验本轮测试变更。 |

验收记录使用 `PASS`、`BLOCKED`、`NOT TESTED`。`PASS` 以该行标注的环境和断言为限。Windows 11 桌面或真实 GitLab Push/MR 缺失即保留 Release Candidate。其他必验项无法取证时，记录具体阻塞并保留 RC。升级实证使用 SQLite 副本。回退时使用升级前备份，保留已发生的交付记录。Git 实际写入默认使用独立测试仓库，正式《山河问仙》按用户本轮授权只写入专用开发分支和草稿 MR。

## 自建 GitLab 的代理兼容性

本机代理对域名和固定 IPv6 可以使用不同出口。操作者可以通过 `DEVHUB_GIT_PROXY_DNS_ORIGIN` 为一个精确 HTTPS origin 启用代理解析，须同时配置受信任的 `DEVHUB_GIT_HTTPS_PROXY` 回环代理。DevHub 把该 origin 的域名及端口交给代理的 CONNECT 端点，HTTP API 与 Smart HTTP 共享此策略。该 origin 的 DNS 和出站地址选择由代理负责。GitLab TLS 证书仍由 DevHub 按原域名校验，重定向仍被拒绝，凭据仅在 TLS 隧道内发送。其余 origin 继续由 DevHub 校验并固定公网地址。

已登记项目的 Git 管理表单优先使用保存的连接或本地仓库的 HTTPS origin。常规首次授权只填写令牌。无可识别远端时保留手工输入，自建 GitLab 的自定义 API 路径收在高级设置。空白 API 地址继续由 Hub 推导。

较大的 Unity 仓库创建 Worktree 时，Git 须写出完整检出。该步骤单独使用 60 秒超时。读取 Git 元数据、限制外部 Filter 和检查 Worktree 完整性的策略沿用原设置。

[V1 发布验收报告](../test_case/v1-release-acceptance.md)
