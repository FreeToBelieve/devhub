# Sprint 2.3C 验收

| 场景 | 验收条件 |
| --- | --- |
| 审批 | 授权中心选择受管工作树和 CONNECT。策略、域名及限制变化须重新审批，旧模式行为可回归。 |
| 秘密 | 只用合成值。快照拒绝秘密命名及内容，原生沙箱拒绝敏感路径读取，模板及合法 Unity 文件仍可用。 |
| CONNECT | 固定 IPv4、TLS 目标、端口、逐隧道复核、连接和传输预算。拒绝 IP、私有解析、额外回环端点和公网直连。 |
| 依赖 | 冷缓存 npm、pnpm、Git HTTPS、Unity UPM 分别保留真实客户端证据。 |
| Unity | 测试工程批量修改、导入和 Player 构建与主工程隔离。 |
| 生命周期 | 保留取消、心跳、Job Object 和退出确认。未知任务状态继续锁定。 |
| 平台 | Node 24 冻结安装、typecheck、Vitest、build。macOS 真机、Windows Server CI、Windows 11 桌面单列。 |

## 2026-11-19 macOS arm64 记录

macOS 14.5 arm64、Node.js 24.22.3 LTS、pnpm 11.25.0、Codex CLI 0.170.0、Unity 6000.3.28f1。工程和缓存均使用临时测试目录。秘密值来自合成样本。

- `scripts/smoke-developer-completion.mjs` 通过原生 PROJECT_DEVELOPER 验证工作树内 .env、.npmrc、PEM、KEY、credentials.json 不可读取。模板可读，普通源码可读写。
- 相同 Seatbelt 配置下移除代理并指定注册表公网地址，直连失败。连接另一回环测试端口也失败，监听器收到 0 个请求。通过批准的代理访问公共注册表成功。Vitest 拒绝私网 DNS 混入、IP 字面量、非 443、错误域名、TLS SNI 不匹配和超过并发上限的请求。
- 真实 npm install 和 pnpm install 各自在空缓存解析并安装公共 `is-number@7.0.0`。首次实现限制 Git ALPN 为 HTTP/1，实际 GitHub 抓取未通过。改用单域名并禁用重定向的 HTTP/2 Git 模式后，真实 HTTPS fetch 通过，且验证临时 bare 仓库中的 FETCH_HEAD。
- 以 `DEVHUB_UNITY_UPM_SMOKE=1` 运行 `scripts/smoke-unity-developer.mjs`。公开 `com.unity.nuget.newtonsoft-json@3.2.2` 经两个 CONNECT 隧道下载，第二次为 Unity CDN 重定向。全新隔离缓存的 Unity Package Manager 从本地归档解析依赖，锁文件记为 `local-tarball`。同一临时工程通过 Scene、Prefab、Shader、.meta、Script、Packages、ProjectSettings 修改、导入和 macOS Player 构建。
- 单独尝试把完整 Unity Editor 放入 CONNECT 客户端沙箱并直接从在线注册表恢复。Editor 在访问代理前退出，在线 UPM 客户端路径尚未通过。登记的是受控下载加本地 UPM 恢复的结果。
- 回归包含 Worker 的原生进程和 IPC 退出确认、取消，以及心跳过期后保持锁并拒绝竞争领取。macOS 跨 Session 子进程退出仍可能无证据，保留锁。VM 方案见设计文档。

## Windows 11 x64 桌面记录

本轮没有 Windows 11 x64 测试机。以下条目均待桌面验收。Windows Server CI 结果独立列在 PR。

| 条目 | 记录要求 |
| --- | --- |
| 登录与 ACL | Windows build、Node 24、SDK 版本，真实账号登录成功及专用目录、认证文件 ACL 检查结果。禁止导出登录内容。 |
| 原生工作区 | 受管临时工作树，五类合成秘密读取失败和普通 Unity 文件批量修改。 |
| Unity | Unity 6.3 的录入版本、临时工程导入和 Windows Player 构建结果。 |
| 生命周期 | Worker ID、Job Object 绑定、取消状态和退出确认。模拟异常时保留锁。 |
| 网络 | CONNECT 模式在缺少 Windows 原生约束时拒绝启用。独立 Windows 网络边界完成后复验公网和旁路回环拒绝。 |
