# Sprint 2.3B 验收

| 场景 | 验收条件 |
| --- | --- |
| 授权中心 | 选择受管工作树和 Project Developer。审批显示工具网络模式及摘要，变更后旧批准无法领取。 |
| 文件 | 临时 Unity 6.3 工程的 Assets、Scene、Prefab、Shader、Packages、ProjectSettings 及 .meta 批量修改。重新审批须检查全部源变化。 |
| 凭据 | 检查认证文件及目录权限。合成的凭据目录、个人文件和其他项目数据在 Shell 内不可读。 |
| Git 与路径 | .git 只读。跨工作树写入、符号链接和不受管根目录受限制。 |
| 网络 OFF | Shell 直接联网失败，依赖下载工具不可用。 |
| 网络代理 | 公共依赖下载经批准代理成功。非白名单域名、IP 字面量、私网解析、非 443 和不合格的重定向被拒绝。 |
| 生命周期 | 领取原子化，心跳失联持久化诊断，已确认退出后结算，未知进程状态保持工作树锁。 |
| Unity | 分别记录文件修改、编辑器导入与构建。 |
| 回归 | 本机和双平台 CI 执行冻结安装、typecheck、Vitest 和 build。Windows Server 的 CI 单列。 |

## macOS arm64 实测

- macOS 14.5、Node.js 24.22.3 LTS、pnpm 11.25.0、Codex CLI 与 SDK 0.170.0。冻结安装、类型检查、Vitest 和构建通过。52 项测试通过，2 项 Windows 专属测试跳过。
- 采用安装的 Unity `6000.3.28f1`，通过 `scripts/smoke-unity-developer.mjs` 在临时项目生成 Scene、Prefab 和 .meta，从 Git Adapter 创建 linked worktree。原生 Codex Seatbelt 接受跨目录修改。新建 Script、修改 Scene、Prefab、Shader、.meta、Packages 和 ProjectSettings 后，Unity 重新导入并完成 macOS Player 构建。
- 同次原生探针中的认证目录、私钥样本和其他项目 .env 都是临时合成数据。拒绝打开三类文件及指向样本的工作树符号链接，拒绝越界写入和打开 `.git` 指针写入。Shell 对隔离的回环 HTTP 探针没有产生请求。此证据来自实际原生沙箱和 Unity Editor。
- 实际 MCP 下载 broker 获得 npm tarball 3,730 字节、Unity UPM 元数据 192,139 字节及 GitHub codeload 归档 67,998 字节。落盘长度与 SHA256 一致，额外主机、IP 字面量及非 443 端口被拒绝。当前主机到 `github.com` 直连返回 `UPSTREAM_ERROR`，此路径未验收。私网 IPv4、IPv6 字面量及重定向规则由测试覆盖。
- 实际 v2 临时数据库迁移到 v3，保留任务 revision、审批记录和运行记录，旧活动运行进入 `INTERRUPTED`，工作树仍锁定。Vitest 覆盖真实 Worker IPC 与退出、过期心跳和锁定后的领取竞争。

## 真实账号与平台待验收

本机原有日常 Codex 目录不满足专用私有 profile 的要求。macOS 带 ChatGPT 账号的新 Profile Turn 尚待专用登录目录。Windows 11 x64 主机需独立验证登录、原生 Sandbox、ACL、Job Object、Unity 导入和 Player 构建。Windows Server CI 只提供服务器版运行时回归证据。
