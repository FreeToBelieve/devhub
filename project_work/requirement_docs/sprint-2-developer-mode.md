# Sprint 2.3B Developer Mode & Execution Security

以 `main@7b6ea153` 为基线，扩展现有 Codex SDK 和一次性 Turn 授权。保留旧请求、运行和事件的读兼容。Project Developer 审批覆盖受管 Git Worktree 的全部项目资源。Sprint 2.2 的按路径操作另有独立契约。

## 实施顺序

1. 将 `PROJECT_DEVELOPER`、工具网络模式、工作树快照及 SDK 配置绑定到审批。新 Profile 继承 workspace 写入能力并拒绝读取工作树之外的个人文件。专用登录目录和认证文件通过本机权限检查。运行中的命令采用预授权，人工运行时提权需另行接入 App Server。
2. 保持 Shell 直接联网关闭。依赖下载经独立的受控 HTTPS 代理工具，使用精确公共仓库域名、443、逐跳检验和解析后固定的公网地址。模型服务保留独立传输配置。
3. Git 索引与忽略规则共同识别根目录生成物。扫描源文件内容、未跟踪资源及普通忽略项，统计文件数、体积和耗时。拒绝可见的链接和特殊文件，扫描不稳定时重新申请。
4. 受监控的 Worker 提供身份、心跳、脱敏状态和取消确认。无法确认进程退出时锁定工作树，恢复需重新审批。
5. 在临时 Unity 6.3 工程上验证完整修改、导入、构建及安全边界，分别记录 macOS arm64、Windows 11 x64 和 CI 的结果。

权限变化需要新审批。Windows 原生读限制、代理兼容、子进程清理和 Unity 模块可用性分别以平台证据判断。认证与宿主机敏感路径用合成文件验证，路径元数据检查不读取真实认证内容。macOS Intel 和 Windows arm64 留待后续验收。

## 执行边界

- SDK 0.170.0 使用继承 `:workspace` 的命名权限，把工作树内写入与磁盘范围读取分开。macOS 通过原生 Seatbelt 检查。Windows 使用原生 elevated 沙箱，ACL 实现只接受当前用户、SYSTEM 和管理员组。若系统拒绝命名 Profile，保留 SDK 错误代码。普通工作树不可配置本地 Codex 插件、执行规则或配置。
- macOS 运维人员可显式选择 `DEVHUB_REUSE_LOCAL_CODEX_LOGIN=1`，在私有 profile 内引用本机 Codex 登录。该模式仅接受当前用户默认 Codex 目录中属主和权限合格的 `auth.json`，配置及历史单独保留，应用不复制登录内容。此选择纳入配置摘要。
- `DEVELOPER_ALLOWLIST` 是 SDK 启动的独立 MCP 下载进程。只支持公开依赖的 HTTPS GET，固定 443，拒绝 IP 字面量、查询参数、用户信息与私网解析。只解析 IPv4，连接固定在通过检查的地址，保留目标 TLS SNI 和证书校验。每次重定向重新验证并限制跳数，下载限制为 20 次、总共 128 MiB。结果以唯一名称落到工作树根目录。GitHub 走公开归档，npm 和 Unity UPM 可下载公开包至本地处理。Shell 内 npm、Git 和 Unity UPM 客户端的直连与透明代理仍关闭。模型传输沿用完全独立的 provider 配置。
- 缓存剔除只覆盖 Git 可证的顶层 `Library`、`Temp`、`Obj`、`obj`、`Logs` 和 `node_modules`。Unity 专用项要求存在 `ProjectVersion.txt`。其余忽略项仍计入摘要。预览可按文件标识与纳秒修改元数据复用前次结果，领取时完整读取源内容。扫描预算为 125,000 项、24 GiB、35 秒和深度 64。若超限或扫描期间变动，授权会被安全拒绝。
- 进程身份是随机 Worker ID 加匿名 IPC。macOS 监控 Worker 进程与进程组，Windows 在 Worker 接收执行消息前绑定 Job Object。超过 15 秒未收到心跳标记中断。仍在执行命令、断开 IPC、原生容器中存在进程或无法证明终止时，会继续保留工作树锁。macOS 进程组不提供跨会话进程的系统级枚举，强隔离生产部署可把 Runner 和项目挂载放到专用虚拟机，将会话与下载边界独立管理。
- 动态权限批准可以由 Codex App Server 的 `item/commandExecution/requestApproval` 和相应审批响应实现。迁移时应将 App Server 的审批请求绑定 DevHub Run、工作树快照和会话，拒绝授予没有预授权的范围。当前 SDK Turn 使用 `never`，范围变化使用 DevHub 新授权。

参考 [Codex 命名权限](https://learn.chatgpt.com/docs/permissions)、[Codex App Server](https://learn.chatgpt.com/docs/app-server) 和 [Unity UPM 网络要求](https://docs.unity3d.com/6000.3/Documentation/Manual/upm-network.html)。
