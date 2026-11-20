# Sprint 2.4 GitHub 与 GitLab 交付

基线为 GitHub main `e7f741c6ac839ef68e4534b3907129a6bd37198e`，已包含 PR #5。开发分支为 `feature/sprint-2-git-providers`。

- Git Provider 将仓库、分支、PR/MR、评论和检查结果归一化。GitHub 固定公共 REST 端点，GitLab 允许自建 HTTPS 实例及 API 前缀。API 与 Git 传输禁用重定向并验证 TLS 主机名，默认拒绝地址字面量与非公网解析，使用已核验的固定 DNS 地址建立连接。
- 每个项目连接分配独立的系统凭据引用。API 请求和受控 Git 传输在 Hub 内使用系统凭据。日志、Codex 环境和业务数据库只使用安全状态或引用。
- 交付预览与执行绑定连接、Worktree、分支、HEAD、变更摘要和作者。已有 Codex 授权及工作树完整性检查继续生效。版本控制、持久记录和远端结果查询共同约束重试。正式分支、强推和合并没有交付入口。
- Git 管理页复用本机操作员会话、安全来源和 CSRF 验证。远端评论作为待审阅内容，由操作员确认后进入同一 Worktree 的下一次授权。
- 自动化只在临时本地仓库及独立远端测试仓库验收。Windows Server CI 与 Windows 11 桌面分别记录。

新增数据库表使用事务迁移。部署前备份业务数据库。回滚二进制时使用迁移前备份，并保留分支及 PR/MR 的远端交付记录。

## 写入边界

- 审批摘要覆盖任务 revision、工作树身份、快照、连接版本、远端分支 HEAD、作者及文本。批准后只能由当前操作员会话领取。交付和 Codex 执行在同一工作树互斥。
- 本地 Commit 使用临时索引，确认内容摘要和树对象后写入恢复记录。更新分支时比较原 HEAD。HTTPS Smart HTTP 中继只允许认证过的本机 Git 客户端，以及审批中的单一 ref、原 SHA 和新 SHA。实际 Provider 令牌只在 Hub 到已验证的上游 HTTPS 连接中使用。
- GitHub 和 GitLab 通过同一接口查询、创建、更新、关闭和读取 PR/MR。重试先查询远端开发分支和现有 PR/MR。评论的幂等键绑定内容，发送结果不确定时搜索相同标识。关闭或已合并的记录须显式启用新开发分支才能再交付。
- Hub 如果在持有 Worktree 写锁时异常终止，会记录持续锁定状态。无法证明原 Git 子进程结束时保留锁。人工恢复需核对原进程、HEAD 与远端状态。
- 系统凭据库的安全边界为操作系统账户与 Codex 原生沙箱。开发者模式仍默认关闭工具网络。宿主机同一账户的受信任 DevHub 进程具有访问凭据的权限。
- 配置本机 Git HTTPS 出口时，CONNECT 默认使用已固定的公网 IPv4 或 IPv6 和端口。原目标主机以 TLS SNI 和证书校验保护。令牌只在已建立的 TLS 会话内传输，不进入 CONNECT 请求。Codex 和依赖网络的代理配置保持独立。
- 如果自建站点依赖代理的域名分流，操作员可以为一个精确 HTTPS origin 设置 `DEVHUB_GIT_PROXY_DNS_ORIGIN`。该选项要求显式配置受信回环 CONNECT 代理，并由该代理处理指定 origin 的 DNS 与出站地址。原域名证书校验和重定向拒绝继续生效。未匹配的 origin 保留 DevHub 的 DNS 固定策略。
