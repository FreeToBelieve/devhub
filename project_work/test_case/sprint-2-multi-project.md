# Sprint 2.6 验收

- 使用版本 0 至 6 的 SQLite 夹具复跑迁移，检查行数、原授权摘要、凭据引用、Thread、Run 和迁移报告。重复执行迁移检查幂等性。
- 使用三个独立 Unity 项目，其中两个同仓库不同子目录。分别登记、创建任务和 Worktree，尝试交叉提交及读取资源。
- 在 Dashboard 登录后进入项目页新增、切换和归档项目，核对任务、Git、Codex 和 Unity 列表。切换时允许旧项目的运行继续。
- 使用真实 Unity 6.3 和隔离仓库，其他版本与 Git Provider 测试区分模拟和实机。Windows Server CI 与 Windows 11 桌面验收独立记录。

## 自动化与实机证据

| 范围 | 结果 |
| --- | --- |
| SQLite v0–v6 | 7 个迁移用例覆盖保留任务、授权、凭据、Thread、Run，唯一归属和歧义报告。 |
| 三项目集成 | 两个 Unity 子目录共用一个 Git 仓库，第三个使用独立仓库。通过真实本地 Git Worktree、API、SQLite 和合成 GitHub/GitLab Provider 验证任务、Thread、凭据与媒体隔离，覆盖路径联接、旧审批失效、归档和 Hub 重启。 |
| 版本与构建门禁 | 模拟 2022.3 安装，验证目录与应用元数据矛盾、注册版本变化、Build Support 缺失均阻止运行或构建。 |
| Chrome | 真实 Dashboard 与本机 Hub 完成登录、注册两个项目、创建 Worktree、新建任务、切换项目和归档，归档后任务仍可读。 |
| macOS arm64 Unity | 真实 `6000.3.28f1` 在 Monorepo 子工程执行 Batch 导入 `b7fb7a7e`、GUI Editor `fbc95f7c`、EditMode `dfd711f0` 共 1 项通过。第一次冷启 `dc0d4459` 获得 Editor 就绪标记但未确认退出，锁保持。单独热身后复测通过。 |
| macOS arm64 Codex | 使用已授权的本机登录，在独立 Worktree 运行真实 SDK Turn `5b8e15c9`，记录 Thread 并确认只写当前工程。相同 SDK 版本的原生沙箱探针验证当前工程可写、同一 Monorepo 的兄弟工程和另一项目 Worktree 的合成文件均返回操作不允许。 |
| 同 Thread 修复回归 | 真实 Codex Turn `aaf35b4f` 和 `f98fb9e0` 使用同一个 Thread。真实 Unity EditMode 从 2 项失败恢复到 3 项通过，随后的 PlayMode 1 项通过。Git 候选 Tree 与本地 Commit Tree 相同，SHA 为 `67f6d3c9194c2b68352a20dd9c14007b2cebb59c`。更新原变更单的步骤使用模拟 Git 传输。 |

Unity 2022 LTS 在当前机器以模拟安装验证，未启动实际 2022 Editor。GitHub/GitLab 配置验收使用合成 Provider 和凭据引用。Windows 11 桌面测试机不可用，标准 CI 用于 Windows Server 和 macOS 回归。macOS 真实测试可在本仓库构建后用 `node scripts/smoke-multi-project.mjs` 复跑。添加 `--codex` 会使用专用登录执行真实 Codex Turn。
