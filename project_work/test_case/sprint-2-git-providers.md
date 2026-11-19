# Sprint 2.4 Git 交付验收

| 场景 | 验收条件 |
| --- | --- |
| 连接和重新授权 | Git 管理页登录后配置测试项目，校验账号、默认分支及凭据状态。凭据不返回浏览器，不写 SQLite 或日志。 |
| 自建 GitLab | HTTPS 自定义域名、端口、API 前缀在独立项目验收。无效证书、跨域重定向、地址字面量和私网解析在发出凭据前失败。 |
| Worktree 和交付 | 先预览差异，审批后提交到独立分支。修改任务、路径内容、目标 Remote 或 HEAD 后要求重新授权。 |
| PR/MR | 分别创建、读取 diff、评论、CI、更新和关闭。改变文件或根据已审阅的 Review 续跑沿用同一个 PR/MR。 |
| 重试 | Push、API 或 Hub 中止后根据远端状态恢复。重复请求不重复创建 PR/MR，关闭状态不自动重开。 |
| 安全 | 禁止 Force Push 和正式分支写入，限制凭据项目归属。只用合成秘密验证泄漏路径。 |
| 平台 | Node 24 冻结安装、typecheck、Vitest、build。macOS、Windows Server CI 和 Windows 11 桌面分别记录。 |

## 本机与远端记录

- macOS 14.5 arm64，Node 24.22.3，冻结安装、typecheck、Vitest（72 通过、2 跳过）和 build 通过。Git Smart HTTP 使用临时 bare 仓库测试 Push 和 Fetch。操作员会话、任务 revision、Remote 变化和 PR 创建结果不明确的恢复均有自动化测试。
- Git HTTPS 出口的合成 CONNECT 代理只接收到已固定的公网 IP 和端口。请求头未包含测试令牌。
- Keychain 合成数据写入、读取和清理通过。实际 PROJECT_DEVELOPER 原生沙箱调用系统凭据读取命令返回 44，未读到合成凭据。SQLite、审计和接口响应未发现测试令牌。
- GitHub 私有测试仓库执行了真实 Fetch、开发分支、Commit、Push、PR、差异、CI、Review 和 PR 更新。两次提交使用同一个 PR，Review 幂等重放无重复评论，Actions 通过，测试仓库默认分支 HEAD 未变。[独立 GitHub 测试 PR](https://github.com/FreeToBelieve/devhub-sprint24-github-acceptance-20261119/pull/1)
- GitLab.com 和自建 GitLab 的 MR 路径由模拟 API 回归。当前未找到有效的 GitLab 会话，本机 DNS 无法解析 `gitlab.pacher.cn`。真实自建 MR 验收等待可访问的独立测试项目。
- Windows 11 x64 桌面和系统凭据实测仍待设备。Windows Server CI 结果单独列在交付 PR。
