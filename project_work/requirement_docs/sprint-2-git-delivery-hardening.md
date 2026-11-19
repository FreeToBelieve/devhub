# Sprint 2.4.1 Git 交付加固

从 DevHub main `c077a628` 开发。Git Provider、操作员审批、Codex 沙箱、Worktree 锁和原有依赖工具入口沿用 Sprint 2.4。

- 使用独立仓库配置、对象目录与临时 Index 生成候选 Tree。文件清单、真实文本差异、二进制摘要、警告以及 Tree SHA 均来自同一候选对象。批准绑定候选 Tree 和 Worktree 快照。重新生成后必须与批准的 Tree 一致，并在更新分支前验证实际 Commit 的 Tree。
- 文本差异有单文件及总量上限，截断和无法展示的内容有明确标记。Git LFS 指针单列，实际 LFS 资源上传及子模块 Gitlink 变更需要单独处理。历史文件若含秘密，隐藏其差异内容。
- SQLite 持久化待删除的系统凭据引用、安全错误码和重试时刻。撤销立即禁用连接，清理成功后移除引用。Hub 启动继续处理未完成项目。
- 自建 GitLab 诊断验证固定公网 IP 的 TCP 和 TLS，真实写入仅限独立测试仓库。依赖 Fetch 继续使用认证 CONNECT 和应用范围网络限制。

## 兼容性和恢复

候选预览限制为 1,000 个文件和合计 512 MiB Blob 扫描。较大文本保留大小和完整 SHA-256，并显示展示限制。旧审批未绑定候选 Tree，需要重新生成预览。已在升级前生成 Commit 或完成 Push 的老记录应先核对本地 HEAD 和远端状态，再决定如何继续。

SQLite v5 保留旧任务和交付记录。系统凭据写入前预留随机引用，连接替换和撤销在事务中排队。清理使用短租约和退避，成功或条目已不存在时删除引用，Hub 启动及运行期间继续处理。日志与 SQLite 只有固定错误码和引用。旧版本回滚使用迁移前备份，系统凭据需重新核对连接。

旧 GitHub Fetch 仍被 `run_dependency_client` 使用。它面向匿名公共依赖，受 Seatbelt、认证 CONNECT、固定 IPv4 和 TLS 校验约束。Git Delivery 的授权 Push 不能代替该入口。Fetch 只保留固定失败类别与计数。
