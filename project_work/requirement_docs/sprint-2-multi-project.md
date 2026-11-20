# Sprint 2.6 多项目管理

基线为 main 的 `f347abc`，包含 Sprint 2.5.1。单项目时期 Git Provider 已有项目 ID，任务、工作树和运行记录仍是全局的。Unity 使用固定版本。Sprint 2.6 引入 Project Registry，按项目授权和查询，并从项目文件验证 Editor 版本。

SQLite v7 在原数据库事务中增加 Registry、归属字段和迁移报告。Git 连接和历史凭据引用的 Project ID 原样保留。以同一 Task 和 Worktree 的历史关联建立连通分组。分组唯一对应某个 Git 项目时继承该 ID，缺乏证据或有多个候选时进入固定的 Legacy / Unassigned 项目。报告列出待确认实体及候选 ID。迁移不重写旧授权摘要、Cookie 会话、审计、Thread、Git 操作或 Unity 产物引用。旧 Unity 运行记录保留 6000.3.28f1。

实施按 Registry 和迁移、服务端归属、动态 Unity、Dashboard、跨项目验收推进。

## 登记与隔离

项目登记读取本地 Git 根目录、Unity 相对路径、Unity 版本、目标平台和 Markdown 规范。通过 realpath 和文件类型校验判断仓库与工程边界。同一个 Monorepo 可登记多个互相独立的 Unity 子目录。重叠工程和链接路径会被拒绝。迁移生成的 Git 项目须补登记实际本地路径，原项目 ID 和凭据引用继续有效。Legacy 提供历史与歧义报告。后台运行期间保留锁，阻止更改正在使用的配置或归档。

项目 API 通过操作员会话和项目上下文查询同一项目的数据。请求传播 `X-DevHub-Project-Id` 或 `projectId`，媒体 URL 用查询参数。服务端逐一检查资源归属，SQLite 写入约束再次检查任务、Worktree、运行和凭据引用。Git 凭据继续在系统密钥库中按项目引用。候选 Diff 拒绝作用于其他 Unity 子目录的文件和重命名。历史 Git 操作仍可查，归属有冲突的旧操作不能领取。

新授权绑定项目 ID、仓库路径、Unity 相对路径、版本、平台及规范文件列表的摘要。仓库或 Unity 配置变化后，旧授予会在验收或领取时因上下文不符被拒绝。Codex 使用所选项目子目录作为工作目录和显式文件权限范围。原生 AGENTS 查找以项目标记为边界，登记的 Markdown 相对路径随 SDK 配置绑定。SDK 只收到当前项目文档路径列表。宿主 Runner 仍负责工作树和任务归属确认。 [OpenAI Docs 权限配置](https://learn.chatgpt.com/docs/permissions) · [OpenAI Docs 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

## Unity 版本策略

支持检测 Unity 2022.3 LTS、2023 和 Unity 6 系列已安装的正式或补丁版本。读取 ProjectVersion.txt，并核对候选 Editor 文件或应用元数据中的精确版本。构建前检查本机目标的 Build Support。版本缺失、无法验证或与项目登记不同会阻止执行。版本检测只读工程文件。Run 持久化版本并绑定项目，产物以该 Run 的项目和版本提供查询。原有磁盘产物路径和引用继续可用。

## 升级

部署时备份现有 SQLite 文件并停止旧 Hub。打开数据库会一次性运行 v7 迁移。迁移事务失败可原样重新启动升级。旧版 Hub 无法使用 v7 文件，回退时使用升级前备份。项目切换仅切换查询与页面组件，正在运行的 Worker 保留启动时的上下文。
