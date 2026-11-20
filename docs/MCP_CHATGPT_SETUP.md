# 在 ChatGPT 中连接本机 DevHub

## 1. 启动和配对

在 DevHub 根目录运行 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm start`。在另一个终端运行 `pnpm authorization bootstrap`。打开 [本机授权中心](http://127.0.0.1:4317/#authorization)，登录后在「MCP 集成」选择允许的项目和工具权限，生成一次性显示的配对凭据。

`DEVHUB_MCP_PAIRING` 是本机配对凭据。轮换后重启对应 Bridge 或 Tunnel 进程，并提供新的凭据。

## 2. 配置官方 Secure MCP Tunnel

下载适合系统和 CPU 的 [官方 tunnel-client 发布版](https://github.com/openai/tunnel-client/releases/latest) 并加入 `PATH`。确认 `node -v` 为 Node 24 LTS，同时运行 `tunnel-client --version`。

在目标 OpenAI Platform 组织中准备 Tunnel ID 和具备 Tunnels Read + Use 的 Runtime API Key。创建 Tunnel 的账户需要 Tunnels Read + Manage；在 ChatGPT 中添加私有自定义 MCP 也需要对应工作区权限。该密钥使用 `CONTROL_PLANE_API_KEY`，与 ChatGPT 登录和本机 DevHub 配对凭据是三个独立入口。[Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

以下示例使用绝对路径。命令字符串里的脚本路径可以加双引号。Windows PowerShell 使用同一条命令，替换成对应的 Windows 绝对路径和 Tunnel ID。若 `node` 无法从 PATH 解析，使用 Node 的绝对可执行路径。

```sh
tunnel-client init --profile devhub --sample sample_mcp_stdio_local --tunnel-id tunnel_实际ID --mcp-command 'node "/absolute/path/to/DevHub/apps/mcp-server/dist/main.js" start stdio'
```

在专用于 Tunnel 的本机终端输入密钥和配对凭据。macOS zsh：

```zsh
read -rs 'CONTROL_PLANE_API_KEY?Tunnel Runtime API Key: '; printf '\n'
read -rs 'DEVHUB_MCP_PAIRING?DevHub MCP pairing: '; printf '\n'
export CONTROL_PLANE_API_KEY DEVHUB_MCP_PAIRING
tunnel-client doctor --profile devhub --explain
tunnel-client run --profile devhub
unset CONTROL_PLANE_API_KEY DEVHUB_MCP_PAIRING
```

Windows PowerShell 7：

```powershell
$env:CONTROL_PLANE_API_KEY = Read-Host 'Tunnel Runtime API Key' -MaskInput
$env:DEVHUB_MCP_PAIRING = Read-Host 'DevHub MCP pairing' -MaskInput
try {
  tunnel-client doctor --profile devhub --explain
  if ($LASTEXITCODE -eq 0) { tunnel-client run --profile devhub }
} finally {
  Remove-Item Env:CONTROL_PLANE_API_KEY, Env:DEVHUB_MCP_PAIRING -ErrorAction SilentlyContinue
}
```

请将密钥限于专用终端或系统密钥管理器。不要复制到聊天、命令参数、`.env`、仓库或 Dashboard。确认官方客户端报告 Ready，并保持该进程运行。

## 3. 在 ChatGPT 中添加私有 MCP

从 [ChatGPT 插件](https://chatgpt.com/plugins) 添加自定义 MCP Server，选择 Tunnel Connection 和刚创建的 Tunnel。按目标工作区的权限要求完成认证，只共享给预期的使用者。使用 `devhub_list_projects` 验证项目列表，随后调用项目详情、Codex Runs 和 Unity Runs。先用 `devhub_list_unity_artifacts` 找到已发布的截图 ID，再用 `devhub_get_unity_screenshot` 查看实际画面。[ChatGPT 自定义 MCP 连接指南](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)

## 可选本机客户端

`pnpm mcp start http` 在 `http://127.0.0.1:4318/mcp` 前台启动。客户端每次请求携带同一个配对 Bearer。使用 `pnpm mcp stop http` 或 Ctrl+C 停止。默认端口用 `DEVHUB_MCP_PORT` 调整。自定义 `DEVHUB_PORT` 时，Hub 和 Bridge 要使用同一值。stdio 的停止由客户端控制，可运行 `pnpm mcp start stdio` 作为本机 MCP 子进程。

### 可选本机 Tunnel 状态

如需在 Dashboard 查看 Tunnel ID 和 Ready 状态，将官方客户端的健康监听设为回环端口，例如初始化时指定 `--health-listen-addr 127.0.0.1:4320`。在同一个专用启动进程设置非秘密变量 `CONTROL_PLANE_TUNNEL_ID` 为实际 Tunnel ID，并设置 `DEVHUB_MCP_TUNNEL_HEALTH_PORT=4320`。Dashboard 显示由 Bridge 心跳报告的本机 `/readyz` 状态。实际 ChatGPT 调用仍须单独验收。

持有配对凭据时，`pnpm mcp doctor stdio` 可在本机启动临时 SDK 客户端执行初始化和工具发现。
