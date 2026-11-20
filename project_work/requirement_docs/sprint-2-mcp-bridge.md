# Sprint 2.7 · MCP Bridge

## 数据流与权限

ChatGPT 经 OpenAI Secure MCP Tunnel 启动 stdio Bridge；本机客户端也可通过受认证的回环 Streamable HTTP 调用同一个 Bridge。独立 Bridge 只向 Hub 发送类型化读取请求。Hub 按每次请求校验配对摘要、有效期、项目与工具授权、对象归属，再读取现有领域服务。存量任务、执行授权、工作树锁和凭据访问规则沿用现有实现。

Dashboard 操作员使用原会话和 CSRF 管理配对，可选择多个项目及读取权限组。凭据只显示一次，Hub 保存摘要。审计只保存标识、工具、时间和安全结果码。Bridge 限制请求、响应、速率和并发。Git 内容、文档、日志及模型输出均按不可信数据处理。写操作保留关闭，后续须单独设计调用方身份与本地审批绑定。

## 阶段与验收

1. 安装稳定版 MCP SDK，建立 stdio 与本机 HTTP。
2. 接入项目、任务、Codex、Unity 和 Git 的只读工具、资源与提示模板。
3. 接入配对、撤销、轮换、权限和审计。
4. 接入官方 Tunnel 客户端并文档化本机配置。
5. 区分本机协议测试、平台 CI、真实 Tunnel 和 ChatGPT 截图验收。
6. 留出写操作配置边界。撤销配对或退出 Bridge 即可停止对外共享。

操作员可明确选择永久配对。永久配对和原有定时配对共享项目权限、审计、限流和撤销规则。SQLite v8 保持原结构，`expires_at=0` 表示无到期时间，API 使用 `expiresAt: null`。
