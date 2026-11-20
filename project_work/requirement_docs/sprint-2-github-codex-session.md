# Sprint 2.8 · GitHub Inbox 与 Codex Sessions

## 来源、授权与恢复

Inbox 使用固定仓库 ID、作者、目标分支、同仓来源分支、开放 PR 和路径白名单。以 PR 的完整 Head SHA 读取 Git 树和普通 blob，校验 Markdown Task Key、Project ID 和必填段落。每个事件以仓库、PR、Head 去重。每个 PR 绑定一个 UUID Task，每个 Task 绑定一个 Session。Listener 默认关闭，每 30 秒轮询，首次启用补扫已有 PR。独立细粒度只读令牌存系统凭据管理器。

Hub 内只运行一个长期管理器。安装、Host 和 Runner 身份持久化，macOS 的 flock 文件锁、Windows 的命名互斥锁及 SQLite 唯一租约共同防止第二个有效所有者。只有最近取得租约的 Host 可事务领取 Inbox 授权。不同 Session 各用原 Codex Runtime 与受管 Worktree，保留子进程监督、现有 SQLite Worktree 锁、旧授权摘要和中断保锁语义。

Inbox 正文作为不可信需求数据随提示词摘要进入现有审批。操作员在 Dashboard 准备审批时分配工作树。获批后仍需 Host、消息、PR Head、Task revision、工作树、Prompt 和 Runner Claim 全部匹配；关闭或更新的 PR、重复请求、仍持锁的工作树均失败关闭。旧一轮运行尚有效时，新修订留队，随后使用原 Thread 与 Worktree。原生锁基于真实 SQLite 路径，Windows 通过 Global 命名空间在登录 Session 之间共享互斥锁。所有隔离层均通过才会激活 Host。

Unity 失败的同 Thread 修复配置关联当前已完成 Inbox 消息、最新 Codex Run、同一 Worktree 和 Thread。修复提示词使用 Unity 既有脱敏处理，并以摘要绑定独立审批和独立 Run。PR 换 Head 或关闭时撤销未领取的修复审批。修复与新需求复用同一套 Worktree 锁、Runner Claim 和 Codex Runtime。

## 兼容与回退

SQLite v10 为增量迁移。退出或断开 Host 保留会话、运行、任务和消息。重启复用安装与 Host ID。未确认退出的运行保持锁，无自动重放。暂停 Inbox 后可继续查看记录。回退到旧二进制时使用升级前数据库副本。

## 验收

验证真实 PR #1 的仓库与作者、精准 Head 和队列绑定，再在现有审批中心由操作员批准。Codex、Unity 和 GitLab 交付分别记录真实结果。自动化测试使用临时项目、真实 SQLite 事务以及合成 GitHub / SDK 数据；CI 与本机桌面验收独立记录。
