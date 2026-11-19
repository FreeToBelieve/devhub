# Sprint 2.5 验收

| 阶段 | 验收路径 |
| --- | --- |
| A | Doctor 和 Unity 页检查版本及锁。审批后从隔离 Worktree 启动、等待就绪、退出和取消。 |
| B | 实际 Batch Mode 导入编译，解析 Unity Test Framework 的 EditMode 和 PlayMode XML。保留失败、超时和退出证据。 |
| C | 读取实际 BuildReport、校验 Player 产物 SHA-256，再从 Runner 启动。 |
| D | 检查场景、关键对象和技能触发。分别查看 Editor Game View 与 Player 媒体。 |
| E | 脱敏失败报告发起新审批，同一 Codex Thread 修复并实机重新运行。Git 生成新候选 Tree。 |

Windows Server CI 与 Windows 11 桌面证据独立记录。全程使用临时工程及独立测试仓库。

## macOS arm64 Phase A 和 B

使用 macOS 14.5、Unity 6000.3.28f1 和 Node 24。GUI Editor 与 Batch Import 发出本次 Run 的就绪标记，退出确认通过。首次临时 Worktree 缺少被 Git 省略的空 Assets 目录，已新增启动前布局检查。对真实 Unity 辅助进程观察到独立进程组，Supervisor 同时追踪出生时间匹配的后代进程，等待确认结束。

| 验证 | 实测 |
| --- | --- |
| Batch 导入 | `0f175aaf` 和最终复测 `158c664b` 就绪并退出，`83f0ab1f` 带 Unity Test Framework 的工程导入通过 |
| GUI Editor | `41d4730e` 和最终复测 `9b8b0dec` 就绪并退出 |
| 主动取消 | `d3cceead` 在 Unity 已启动后提交取消，记录 `UNITY_CANCELLED`。未确认全部后代退出，锁继续保留 |
| EditMode | `d2532860` 1 通过 |
| PlayMode | `4819a897` 1 通过，断言帧推进 |
| 故意失败 | `4b33122e` 1 失败，NUnit XML 确认，保留失败测试名 |
| C# 诊断 | `78e7ad9f` 捕获 Assets/BrokenCompile.cs 第 1 行 CS0103。无法确认后代进程结束，保留 Worktree 锁 |
| 无测试报告退出 | `8334f02a` 实际 Editor 退出 19，没有 NUnit 结论，保留 Worktree 锁 |
| 超时 | `489a8de7` 受控 5 秒超时，保留 Worktree 锁 |

## macOS arm64 Phase C 和 D

| 验证 | 实测 |
| --- | --- |
| Player 构建 | `fa532adf` 使用 `BuildPipeline.BuildPlayer` 生成 `StandaloneOSX`，BuildReport 为 0 错误、0 警告。文件清单总大小 106,127,195 字节，SHA-256 为 `27a8c57f9e2b7aec99749d3c9bad06645d1f94f239247a5e9a94ec32bec96a8d`。 |
| Player 启动 | 两次实际启动均在写入 Player 日志前收到 `SIGKILL`。macOS AMFI 记录 `-423`，拒绝 ad-hoc 签名或不受信任证书链。`security find-identity -v -p codesigning` 显示 0 个有效签名身份。独立 Player 的场景、截图和视频待具有可用签名的本机验收。 |
| Editor Game View | `e24c4b31` 加载 `Assets/Automation.unity`，确认关键对象，触发演示技能，收到 27 帧的运行回执，Runner 确认进程退出。 |
| Editor 截图与录屏 | 实际渲染为 960×540。PNG 人工验看，MP4 通过 FFmpeg 完整解码和 FFprobe 检查，为 H.264、24 帧、3 秒。 |

[查看实际 Game View 截图](assets/sprint-2.5-game-view.png) · [下载实际 Game View 录屏](assets/sprint-2.5-game-view.mp4)

PNG SHA-256 `4daa2dc976471e26330a4ec874477e3d8defcea039eef728168cdcb1ec6980d9`。MP4 SHA-256 `8dbcd3566d0911aad6a42ef935790a199a8082e9ce31ad560b23be1c1a3f6141`。

## macOS arm64 Phase E

1. 真实 Codex Turn `11ac45d3` 修改临时 Worktree 的 C# 代码。Unity 导入 `cd29a86e` 通过，`838ed35d` 返回 NUnit XML，3 项中 2 项失败。脱敏诊断保留断言预期值和实际值。
2. 修复申请重新计算提示词和配置摘要。操作员批准新授予后，真实 Codex 续跑 `e2179fd7`。两次 SDK 执行确认使用同一 Thread，两个 DevHub Run ID 独立。
3. Unity 重新导入 `e28e00ca`，EditMode `370469ce` 3 项全部通过，PlayMode `032a40e1` 1 项通过。
4. 本地 Git Adapter 生成并验证候选 Tree `adf83ddec31b5f3455a34e552657690df8c68c9e`，本地 Commit 使用同一 Tree。原 PR 更新使用模拟 Provider 和 Git 传输，返回已存在的 PR 8。该步骤未向远端推送测试工程。

## 安全、性能与回归

- API 回归包含操作员会话、CSRF 与精确 Origin 检查。Vitest 验证任意命令和路径逃逸被拒绝，授权领取与租约在同一事务，未知进程退出继续持锁，产物链接和超额文件拒绝，日志遮盖合成认证值。
- macOS 冷导入受 Editor 初次启动和 UPM 缓存影响。Phase E 中 2 次导入分别约 16.6 秒、7.5 秒，EditMode 复跑约 5.5 秒，PlayMode 约 6.3 秒。数值来自这台桌面上的临时工程。项目规模、Library 和依赖下载会改变耗时。
- macOS 本机使用 Node.js `24.22.3` 与 pnpm `11.25.0`，锁定依赖安装、typecheck、Vitest、构建和 Doctor 均通过。Vitest 88 项通过、2 项跳过，启用本机 Keychain 测试。
- Chrome 加载真实构建的 Dashboard 与本机 Hub，验证登录控制、Unity 安装状态、报告区、Game View 场景和采集表单。

## Windows 11 x64 桌面

当前没有 Windows 11 x64 测试机，原生 Editor、Job Object 的真实 Unity 子进程生命周期、Player、图形采集和 Codex 沙箱联合验收均待补。GitHub Actions 的 Windows Server 作业用于回归和原生组件测试，Mac Actions 作业用于回归。两者均需与桌面真机记录区分。
