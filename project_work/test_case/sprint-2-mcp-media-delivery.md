# Sprint 2.9 测试报告

## 自动化回归

macOS arm64 使用 Node 24.22.3、pnpm 11.25.0、FFmpeg 8.1.2。冻结安装、typecheck、Vitest、构建和 doctor 均通过。Vitest 共 126 通过、9 跳过。Windows Server 与 macOS GitHub Actions 均通过。 [CI](https://github.com/FreeToBelieve/devhub/actions/runs/44878609082)

测试包含 PNG、JPEG、MP4、Range、默认 8 帧、指定时间点、最多 12 帧、格式和校验和错误、跨项目、无效 ID、超限、FFmpeg 缺失和超时、并发处理及临时副本清理。

## 真实媒体

只读使用现有护身剑气 Run 的原始记录。原片为 5 秒、1280×720、30 fps，文件大小 2,725,190 字节。

| 验收 | 结果 |
| --- | --- |
| 已配对 ChatGPT MCP 的原图 | PASS。激活、环绕、受击和关闭均返回独立 PNG ImageContent。视觉模型可见人物、受击数字和关闭提示。 |
| 已配对 ChatGPT MCP 的 MP4 资源 | PASS。收到 `video/mp4` 的资源链接和完整嵌入式 Blob。 |
| 已配对 ChatGPT MCP 的项目隔离 | PASS。把原图请求改为配对范围外的项目，返回 `MCP_PROJECT_FORBIDDEN`，无图像块。 |
| Live Hub 与本机 MCP SDK 的抽帧 | PASS。发现 33 个只读工具，收到 8 张 1280×720 JPEG ImageContent，耗时 2.399 秒，完整 SDK 结果 2,743,284 字节。 |
| Live Hub 与本机 MCP SDK 的聚合审查 | PASS。收到 8 张视频帧和 8 张阶段截图，耗时 6.694 秒，完整 SDK 结果 3,739,977 字节。 |
| Live Hub 与本机 MCP SDK 的原片完整性 | PASS。`resources/read` 和嵌入 Blob 字节相同，SHA-256 与登记值一致。 |
| macOS Chrome Dashboard | PASS。旧 Run 的 PNG 正常解码，原片取得 HTTP 206，可跳到 2 秒并继续播放。 |
| ChatGPT 的两个新增工具 | BLOCKED。当前对话只加载旧工具列表，待 ChatGPT 网页端刷新 DevHub 插件并在新对话复测。 |
| ChatGPT 原生 MP4 播放 | NOT TESTED。已验证完整 Blob 传输。 |

默认抽帧的实际显示时间为 `0.333333 / 0.966667 / 1.566667 / 2.2 / 2.833333 / 3.466667 / 4.066667 / 4.7` 秒。用 FFmpeg 顺序解码原片，核对第 1、4、8 张图像对应的源帧，SSIM 分别为 `0.974564 / 0.974445 / 0.974412`。画面可区分激活前、环绕中和剑气消退后的状态。
