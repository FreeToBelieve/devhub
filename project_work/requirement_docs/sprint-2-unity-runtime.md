# Sprint 2.5 Unity 6.3 运行自动化

基线为 DevHub main `11432575`。验收固定 Unity `6000.3.28f1`。阶段 A 至 E 的顺序和证据见 [实施计划](sprint-2-unity-automation-plan.md)。

- Hub 使用新的 `unity.run` 范围和既有 Runner 领取机制，绑定任务 revision、Worktree、Git HEAD、文件快照、Unity 可执行文件和运行计划。SQLite 串行协调 Unity、Codex 与 Git 的 Worktree 锁。
- Unity Adapter 负责固定版本发现、日志、测试、构建和媒体协议。Runner 启动进程和报告阶段。Dashboard 只读写已验证的 API。Unity 项目代码按本机受信项目执行，权限由操作员显式批准。默认无须向 Unity 传入凭据。
- 以测试框架报告、Editor 完成标记及 Player 场景断言作为验收。未知进程退出时保持锁。Runner 在解析后移除原始日志与测试 XML，只向 Dashboard 提供脱敏副本。中途异常可能留下原始文件，Artifact API 按名称和已确认退出状态过滤。
- 媒体采集来自实际 Editor Game View 或 Player。失败报告经新请求申请原 Codex Thread 续跑。Git Tree 与交付沿用 Sprint 2.4.1。

## 运行协议

Runner 使用结构化参数启动固定 Editor。Editor bridge 等待 UPM、首次导入、域重载及 AssetDatabase 稳定，写出由本次 Run ID 绑定的就绪标记。测试使用 Unity Test Framework 原生 NUnit XML，构建使用 `BuildPipeline.BuildPlayer` 的原生 BuildReport，并对产物目录的普通文件按路径和内容计算 SHA-256。场景执行验证加载路径、关键对象、确定性技能输入和实际画面帧。Game View 与独立 Player 分别使用不同标记和文件名，PNG 帧经 FFmpeg 编码并解码检查。

Runner 先取得工作树租约。Windows 以 Job Object 管理 Runner 及子进程，macOS 使用进程组与出生时间匹配的后代追踪。异常退出、心跳中断、进程身份不明时保留 SQLite 中的 Worktree 锁，重启不会释放未知运行。Editor 和 Player 以本机用户权限运行，限受信项目。Codex 继续使用独立 SDK 沙箱和工具网络策略。

## 产物与修复审批

产物目录位于工作树外，默认 `.devhub/unity-runs/<run-id>`。产物按允许文件名发布，禁止符号链接和额外硬链接，macOS 根目录须为当前用户私有目录。构建产物保留在 Run 的 `build/`，SQLite 仅保存报告、状态与产物元数据。每个 Run 文件预算为 2 GiB，总目录预算为 10 GiB，检查新运行及运行期间产物。采集上限为 1920×1080、12 秒、8 帧每秒。启动、运行前及每小时清理退出已确认且超过七天的产物。

修复申请只接收同一任务、同一工作树中已结束且可确认退出的 Unity 失败，以及原成功执行的 Codex Thread。报告以受限结构化诊断组成提示词。操作者通过现有授权中心审查新的提示词摘要、工作树快照和 SDK 配置摘要。修复、Unity 复测和 Git 交付各自审批。

## Sprint 2.5.1 运行加固

- Codex、Unity 和 Git Delivery 使用同一个 Worktree 占用查询。在 SQLite `BEGIN IMMEDIATE` 事务内检查三类执行记录，随后取得租约。Codex 与 Unity 的租约和授权消费同一事务提交，冲突会回滚授权消费与审计事件。`RUNNING`、`INTERRUPTED` 和持有 `owner` 的 Git 操作都占用工作树。既有数据库约束继续生效。
- Windows 的默认 `.devhub/unity-runs` 由 Hub 配置为受管目录，启动时给当前用户设置可继承的专用 DACL。外部目录须预建，以只读方式检查真实路径、可信所有者、当前 SID 的可继承访问和 DACL 中所有 Allow ACE。仅接受当前用户、SYSTEM 及内置 Administrators。拒绝不可信 ACE、重解析点、读权限失败，以及取消安全继承的 Run 子目录。Hub 重启重新校验；Run 创建、产物读取及清理也校验权限。macOS 延续私有目录权限检查。
- 场景路径为 `Assets/` 下的相对 `.unity` 文件，支持 Unicode、空格、括号、逗号和普通目录名中的点。禁止绝对路径、空命名段、`..`、控制字符、Windows 设备名及替代数据流。工件配置在请求、批准和领取重检场景的真实路径以及普通文件类型；Unity 仍加载原生 `SceneAsset`。

### macOS Player 签名验证

在一次性测试 Player 上检查签名。`security find-identity -v -p codesigning` 应显示可用身份。`0 valid identities found` 对需要签名的验收路径记为 `PLAYER_SIGNING_REQUIRED`。本轮保留构建与启动结果各自的错误码。BuildReport 只证明构建完成，Player 验收需要收到当前 Run 的场景回执并确认退出。

如需验证本机签名后的启动，在本机终端自行设置 `DEVHUB_MACOS_SIGNING_IDENTITY`，例如已在钥匙串中验证的 `Developer ID Application` 证书。对实际测试产物中的嵌套原生代码由内向外签名，应用最后签名。以下命令针对临时验收用的 Mono Player，其 `Contents/Frameworks` 仅含直接子级的 `.dylib`。含嵌套 Framework 或插件的工程须为实际组件签名。分发验证与公证按 Apple 的要求另行进行。[Apple 代码签名指南](https://developer.apple.com/library/archive/technotes/tn2206/) · [签名和公证问题排查](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)

```sh
security find-identity -v -p codesigning
(
  set -e
  test -n "$DEVHUB_MACOS_SIGNING_IDENTITY"
  test -d "$APP/Contents/Frameworks"
  for dylib in "$APP"/Contents/Frameworks/*.dylib; do
    codesign --force --sign "$DEVHUB_MACOS_SIGNING_IDENTITY" "$dylib"
  done
  codesign --force --sign "$DEVHUB_MACOS_SIGNING_IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=4 "$APP"
)
# 对准备分发的产物另查 Gatekeeper 策略和公证状态。
spctl --assess --type execute --verbose=4 "$APP"
```

签名会改变构建文件及其 SHA-256。后续若在 DevHub 实现可选的签名阶段，其身份选择须绑定审批，在构建后和产物库存计算前完成，省略钥匙串身份详情和私钥。当前手工验证使用独立副本，在新的产物目录以实际 Player 验证场景标记，避免将手工修改后的内容归于已登记的构建摘要。

```sh
exe=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$APP/Contents/Info.plist")
output=$(mktemp -d)
run_id=$(uuidgen)
(set -e
"$APP/Contents/MacOS/$exe" -logFile "$output/player.log" \
  -devhubRun "$run_id" -devhubArtifacts "$output" -devhubStage PLAYER \
  -devhubScene 'Assets/Automation.unity' -screen-fullscreen 0
test "$(plutil -extract run raw -o - "$output/player-ready.json")" = "$run_id"
test "$(plutil -extract scene raw -o - "$output/player-ready.json")" = 'Assets/Automation.unity'
test "$(plutil -extract objectPresent raw -o - "$output/player-ready.json")" = true
test "$(plutil -extract skillTriggered raw -o - "$output/player-ready.json")" = true)
```
