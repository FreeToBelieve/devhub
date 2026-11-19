# Sprint 2.5 Unity 6.3 运行自动化

基线为 DevHub main `11432575`。验收固定 Unity `6000.3.28f1`。阶段 A 至 E 的顺序和证据见 [实施计划](sprint-2-unity-automation-plan.md)。

- Hub 使用新的 `unity.run` 范围和既有 Runner 领取机制，绑定任务 revision、Worktree、Git HEAD、文件快照、Unity 可执行文件和运行计划。SQLite 串行协调 Unity、Codex 与 Git 的 Worktree 锁。
- Unity Adapter 负责固定版本发现、日志、测试、构建和媒体协议。Runner 启动进程和报告阶段。Dashboard 只读写已验证的 API。Unity 项目代码按本机受信项目执行，权限由操作员显式批准。默认无须向 Unity 传入凭据。
- 以测试框架报告、Editor 完成标记及 Player 场景断言作为验收。未知进程退出时保持锁。Runner 在解析后移除原始日志与测试 XML，只向 Dashboard 提供脱敏副本。中途异常可能留下原始文件，Artifact API 按名称和已确认退出状态过滤。
- 媒体采集来自实际 Editor Game View 或 Player。失败报告经新请求申请原 Codex Thread 续跑。Git Tree 与交付沿用 Sprint 2.4.1。

## 运行协议

Runner 使用结构化参数启动固定 Editor。Editor bridge 等待 UPM、首次导入、域重载及 AssetDatabase 稳定，写出由本次 Run ID 绑定的就绪标记。测试使用 Unity Test Framework 原生 NUnit XML，构建使用 `BuildPipeline.BuildPlayer` 的原生 BuildReport，并对产物目录的普通文件按路径和内容计算 SHA-256。场景执行验证加载路径、关键对象、确定性技能输入和实际画面帧。Game View 与独立 Player 分别使用不同标记和文件名，PNG 帧经 FFmpeg 编码并解码检查。

Runner 先取得工作树租约。Windows 以 Job Object 管理 Runner 及子进程，macOS 使用进程组与出生时间匹配的后代追踪。异常退出、心跳中断、进程身份不明时保留 SQLite 中的 Worktree 锁，重启不会释放未知运行。Editor 和 Player 以本机用户权限运行，限受信项目。Codex 继续使用独立 SDK 沙箱和工具网络策略。

## 产物与修复审批

产物目录位于工作树外，默认 `.devhub/unity-runs/<run-id>`。产物按允许文件名发布，禁止符号链接和额外硬链接，macOS 根目录须为当前用户私有目录。构建产物保留在 Run 的 `build/`，SQLite 仅保存报告、状态与产物元数据。每个 Run 文件预算为 2 GiB，总目录预算为 10 GiB，检查新运行及运行期间产物。采集上限为 1920×1080、12 秒、8 帧每秒。启动、运行前及每小时清理退出已确认且超过七天的产物。

修复申请只接收同一任务、同一工作树中已结束且可确认退出的 Unity 失败，以及原成功执行的 Codex Thread。报告以受限结构化诊断组成提示词。操作者通过现有授权中心审查新的提示词摘要、工作树快照和 SDK 配置摘要。修复、Unity 复测和 Git 交付各自审批。
