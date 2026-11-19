# ShanHe DevHub 协作规范

- 本仓库独立于 ShanHeWenXian。Sprint 1 的操作范围为 DevHub，Unity 检测使用只读文件检查。
- 使用 Node.js 24 LTS、锁定的 pnpm、TypeScript strict 和 Vitest。变更后执行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`。
- 共用输入输出定义归 `packages/contracts`，持久化归 `packages/storage`，平台检测归 `apps/runner`。Hub 和 Dashboard 通过本机 HTTP 协作。
- Hub 只绑定回环地址。源码、日志和测试数据使用无凭据样例；本机环境文件、数据库和日志保持在 Git 忽略范围。
- 外部写入、真实凭据接入、游戏仓库修改及 Unity 自动运行须有对应任务授权。平台验收记录区分真实运行与模拟测试。
