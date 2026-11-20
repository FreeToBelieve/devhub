# MCP 故障排查

| 现象 | 检查 |
| --- | --- |
| CLI 未构建 | 使用 Node 24 LTS，运行 `pnpm build` |
| `MCP_PAIRING_REQUIRED` | 在 Dashboard 生成配对，在专用启动终端提供 `DEVHUB_MCP_PAIRING` |
| `MCP_PAIRING_INACTIVE` | 检查配对到期、撤销情况。轮换后用新凭据重启客户端 |
| `MCP_PROJECT_FORBIDDEN` / `MCP_TOOL_FORBIDDEN` | 核对该配对勾选的项目 ID 和权限组 |
| `MCP_NOT_FOUND` | 核对 Task、Run、Artifact 或已跟踪 PR/MR 的真实归属 |
| `MCP_RESPONSE_LIMIT` | 减小分页大小；媒体使用同一次 Unity 运行的较小产物或审核帧 |
| `MCP_RATE_LIMIT` / `MCP_TIMEOUT` | 减少并行请求并重试；Git 详情查看原 Git Delivery 的连接状态 |
| Tunnel Ready 未确认 | 运行 `tunnel-client doctor --profile devhub --explain` 并检查本机官方客户端日志 |
| 重启后发现工具失败 | 关闭旧的 Tunnel 客户端，使用同一有效配对启动；让 MCP 客户端重新初始化 |
| 录屏无法播放 | MCP 客户端可能仅理解资源元数据。可在本机 Dashboard 播放该产物或通过截图工具审查帧 |

`pnpm mcp status` 和 `pnpm mcp doctor` 检查 Hub、当前配对、HTTP 状态和安装的 Tunnel 客户端。使用 stdio 时，Dashboard 的连接心跳和 MCP initialize 结果提供本机证据。真实 OpenAI 连接状态以官方客户端状态和 ChatGPT 调用为准。

macOS 和 Windows 使用同样的协议、数据库和项目权限。Windows 需使用本机 `tunnel-client.exe`，Unity 产物仍通过现有 Windows ACL 检查。CI 上通过测试不能代表 Windows 11 桌面与 ChatGPT 的端到端验收。
