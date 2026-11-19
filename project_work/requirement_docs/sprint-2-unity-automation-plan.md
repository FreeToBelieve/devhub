# Sprint 2.5 Unity 6.3 实机自动化计划

验收目标是在 macOS arm64 与 Windows 11 x64 桌面分别使用安装的 Unity 6.3，验证隔离 Worktree 中一个可运行的游戏项目。验证从导入、编译、测试和构建开始，延伸到场景运行、Game View 截图、录屏和可复用的失败反馈。使用临时项目和独立测试仓库。Sprint 2.4.1 的交付审批继续约束最终 Git Tree。

| 阶段 | 实施 | 必须保留的实机证据 |
| --- | --- | --- |
| 1. Editor 生命周期 | Doctor 校验 ProjectVersion、已安装 Editor、许可、目标平台模块和磁盘预算。Runner 在受管 Worktree 启动固定版本 Editor，使用结构化参数和独立日志。运行记录绑定 Worktree、HEAD、编辑器版本、目标平台和审批摘要。取消使用现有 Worker 监督，确认退出后释放锁。 | 两平台从全新 Worktree 启动并正常退出。模拟取消、启动失败和进程失联，证明锁状态与退出确认一致。 |
| 2. 导入、编译与测试 | 在 Batch Mode 等待 Package Manager、Asset Database 和域重载完成。收集 C# 编译诊断。分别发起 EditMode 与 PlayMode，解析测试 XML。按步骤记录退出码、完成标记和超时。 | 修改 Scene、Prefab、Shader、Script、Packages 和 .meta 后重新导入。分别跑一轮通过样例和故意失败样例，保留 XML 和脱敏 Console。 |
| 3. Player 构建 | 在 Windows 实机生成 Windows x64 Player，在 macOS 实机生成 macOS Player。使用固定构建入口，记录 BuildReport、场景清单、产物摘要、运行环境和签名状态。 | 两个平台从新 Worktree 构建后实际启动 Player，校验目标场景加载和可执行产物。 |
| 4. 场景、截图与录屏 | 使用具有图形会话的 Runner 启动 Player 或受管 Editor，按测试步骤驱动输入，等待明确的场景就绪和画面进展信号。抓取 Game View 渲染输出和短视频，采集 Console 与 Player 日志。录制与截帧绑定分辨率、时间区间及运行 ID。 | 两平台可播放视频和非空截图，并有可定位到日志时间点的操作、场景变化和画面断言。 |
| 5. 失败反馈与交付 | 将失败阶段、退出原因、规范化文件位置和脱敏日志摘要送入现有 Codex 续跑审批。修复后在同一 Worktree 重新运行失败场景及必要回归。为交付生成新的候选 Tree 和 Diff，并按现有流程审批。 | 注入可复现的编译或 PlayMode 故障，由同一 Codex Thread 修复，看到实机回归通过，再更新独立仓库的同一个 PR/MR。 |

采集物使用按运行隔离的目录，并为 Console、截图、视频、测试 XML 和构建报告设置容量及保留期限。应用收到未知退出状态时保持锁定。Windows Server CI 用于自动化代码回归，Windows 11 图形会话与实际 macOS 运行各保留独立验收记录。
