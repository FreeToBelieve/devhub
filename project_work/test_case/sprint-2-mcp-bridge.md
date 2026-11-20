# Sprint 2.7 · 验收

使用临时数据库、临时项目和合成凭据。自动化验证两种 MCP 传输、工具/资源/提示协商、项目和所属对象隔离、凭据状态、可注册文件清单、限流、超时、响应限额及审计脱敏。

Dashboard 路径为「授权中心」登录 →「MCP 集成」选择项目和权限 → 配对 → 查看一次性凭据 → 查询工具记录 → 轮换 → 撤销。预期旧凭据立即失效，项目以外的请求被拒绝。

真实 ChatGPT 验收需要官方 Tunnel 的 Runtime API Key、Tunnel ID 和可添加自定义 MCP 的 ChatGPT 工作区。使用专用验收配对调用项目、Codex、Unity 和截图工具，并确认 ChatGPT 收到真实图像。分别记录本机协议结果、平台 CI 和 ChatGPT 结果。

## 2026-11-20 本机记录

- **PASS · macOS arm64 / Node 24.22.3。** 官方 SDK 客户端经 stdio 和 Streamable HTTP 完成初始化和工具发现。测试经 Hub 读取 Sprint 2.5 临时 Unity 工程留存的 960×540 PNG 和 MP4，并逐字节比对。超限录屏返回同运行的审核帧和元数据。
- **PASS · 本机安全回归。** 覆盖未认证、过期、轮换及撤销、项目和 Artifact 归属、未登记文件、请求上限、响应降级、并发限制、读取超时、脱敏及 Hub 和 Bridge 重启。SQLite v7→v8 重复迁移保留任务，`PRAGMA foreign_key_check` 无异常。
- **PASS · 官方客户端配置。** 运行 macOS arm64 官方 `tunnel-client 0.0.21`，核对 `init --help`、stdio 样例与 `doctor --explain`；合成配置成功生成、加载。
- **BLOCKED · 真实 Tunnel 和 ChatGPT。** 官方 doctor 缺 `CONTROL_PLANE_API_KEY`，退出码 2。等待实际 Tunnel ID、具备 Tunnels Read + Use 的 Runtime API Key 和 ChatGPT 工作区权限。远端工具调用、ChatGPT 截图理解和真实 Tunnel 断线恢复未验收。
- **NOT TESTED · Windows 11 x64 桌面。** 当前无桌面测试机。CI 继续覆盖 Windows Server 2025 与 macOS 15。
- **PASS · 浏览器。** 使用本机 Chrome 和临时 Hub 完成操作员登录、选择项目、签发配对、轮换和撤销。旧凭据返回 HTTP 401；有效配对在 `devhub mcp doctor stdio` 中初始化并发现 31 个工具。
- **PASS · 全量回归。** `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`pnpm build` 通过。Vitest 共 14 个测试文件，110 个通过、9 个按平台跳过。
