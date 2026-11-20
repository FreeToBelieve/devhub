# Unity 外部采集证据导入

《山河问仙》已有使用生产按键的采集流程。DevHub 接收操作员明确选取的外部媒体及报告，保留正式工程、桥接包和生产场景现状。导入在 Unity 时间线生成独立 Run ID，标注为外部采集，不创建 Runner 或执行授权记录。

导入边界为本机 Dashboard 操作员登录和 CSRF，按项目校验 Git 提交与场景。清单绑定外部采集入口、时间、Unity 版本、原生分辨率、技能 ID 以及每个文件的 SHA-256 和大小。Hub 仅接收上传的字节，校验整包后发布。PNG 和 MP4 保留原始字节，Console 和报告以脱敏版本供读取，保留原始摘要。设备、人为操作及文件产生过程属于操作员声明。

外部 Run 可通过 Dashboard 和现有 MCP 读取工具查看。访问范围沿用 Project ID、Run ID 和 Artifact ID 的检查。大录屏可从 Dashboard 播放，MCP 按既有媒体上限返回资源或同技能审核帧。

## 采集包与操作员审批

在游戏仓库以外准备采集包。每个技能有稳定 ID、一段 3–5 秒的 MP4 和一组独立 PNG。文件名为 `<skill-id>__<phase-id>.png` 及 `<skill-id>__<clip-id>.mp4`。片段和截图使用同一原生分辨率，允许奇数尺寸。原始画面与录屏按字节归档。

现有青溪村采集器的 `review.json` 可直接用于整理上传目录。整理工具核对源文件哈希和原生尺寸，生成 `manifest.json`，保留 `console.json`、`evidence-report.json` 和可选的 `visual-audit.txt`。目标目录须是游戏仓库以外的新目录。

```sh
node scripts/prepare-unity-evidence.mjs /absolute/capture/review.json /absolute/new-upload-directory
```

清单记录 `projectId`、实际本地提交 `commit`、Unity 相对场景路径 `scene`、来源标识 `captureSource`、`editorVersion`、`platform`、`capturedAt`（Unix 毫秒）、`width`、`height`、各技能的 `frames` 和 `recording` 及各文件的大小与 SHA-256。Git 校验认当前登记仓库中存在的完整本地提交及该提交内的场景，无须远端可达。

在 DevHub 选中目标项目并登录授权中心。进入「Unity 测试 → 导入外部采集证据」，分别选择 `manifest.json` 和清单内的全部媒体、Console 与报告，确认来源并提交。运行报告会显示 Run ID，可下载源哈希清单和脱敏报告。

接口为 `POST /api/unity/evidence/import`，操作员 Cookie、精确 Origin、`X-CSRF-Token` 和 `X-DevHub-Project-Id` 适用。Content-Type 为 `application/vnd.devhub.unity-evidence`。请求体由四字节大端清单长度、UTF-8 JSON 和依照 `unityEvidenceFiles` 顺序拼接的原始产物组成。成功响应包含 Run ID。导入不安排 Runner，授权执行与批准流程沿用各自的原入口。

MCP 可用 `devhub_list_unity_runs` 发现 Run，`devhub_get_unity_run` 核对来源，`devhub_get_unity_diagnostics` 查阅 Console 和报告摘要，`devhub_list_unity_artifacts` 获取按技能关联的产物 ID。小于媒体上限时返回原始 PNG 或 MP4；大媒体保留在局部 Dashboard。
