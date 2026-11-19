# ShanHe DevHub

《山河问仙》的本机开发工作台。Sprint 1 提供任务录入、任务查询、SQLite 持久化和开发环境检测。Codex 执行、GitLab 合并请求与 Unity 测试的集成由后续 Sprint 实现。

## 启动

在仓库根目录执行。需要 Node.js 24 LTS、pnpm 11.25.0 和 Git。可用 `node -v` 和 `pnpm -v` 核对当前终端的版本。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。可从 Dashboard 新建任务、展开任务详情或在系统设置里执行环境检测。按 Ctrl+C 退出 Hub。

| 操作 | macOS | Windows PowerShell |
| --- | --- | --- |
| 安装依赖并构建 | `./scripts/macos/install.sh` | `.\scripts\windows\install.ps1` |
| 启动 Hub 和 Dashboard | `./scripts/macos/start.sh` | `.\scripts\windows\start.ps1` |
| 检测环境 | `./scripts/macos/doctor.sh` | `.\scripts\windows\doctor.ps1` |
| 输出诊断 JSON | `./scripts/macos/doctor.sh --json` | `.\scripts\windows\doctor.ps1 -Json` |

也可从仓库根目录运行 `pnpm exec devhub doctor`、`pnpm exec devhub doctor --json` 或 `pnpm run doctor`。退出码 `0` 表示基础检查通过，`1` 表示基础环境有阻塞，`2` 表示参数无效。Codex、Unity 和 Unity 工程版本的警告只用于诊断。Unity 检查读取可执行文件路径和可选的 `ProjectVersion.txt`。

如 Windows 的执行策略限制 `.ps1`，可使用上面的 pnpm 命令。需要放在 `PATH` 上的 CLI 包括 Node.js、pnpm 和 Git。Codex CLI 的检测也使用 `PATH`。

## 本机配置

可在仓库根目录按 [.env.example](.env.example) 创建可选的 `.env`。当前终端的环境变量优先。数据库默认位于 `.devhub/devhub.sqlite`。

| 变量 | 用途 |
| --- | --- |
| `DEVHUB_PORT` | 本机监听端口，默认 `4317`。修改后用实际端口打开 Dashboard |
| `DEVHUB_DB_PATH` | 本机 SQLite 文件路径，可用绝对路径或相对仓库根目录的路径 |
| `DEVHUB_LOG_LEVEL` | 结构化日志级别，默认 `info` |
| `DEVHUB_UNITY_HUB_ROOT` | 自定义 Unity Hub Editor 根目录，内含 `6000.3.28f1` 版本子目录 |
| `DEVHUB_UNITY_PROJECT` | 可选的 Unity 工程根目录，内含 `ProjectSettings/ProjectVersion.txt` |

Hub 仅监听 `127.0.0.1`，请求使用同一地址和端口。应用可由同一台电脑上的进程访问。日志记录结构化运行信息，任务内容与凭据应分开保存。

## 本机 API

| 方法与路径 | 返回 |
| --- | --- |
| `GET /api/health` | Hub 状态 |
| `GET /api/tasks` | 按创建时间倒序排列的任务 |
| `POST /api/tasks` | 创建任务，返回 `201`、任务对象和 `Location` |
| `GET /api/tasks/:id` | 查询指定任务 |
| `GET /api/doctor` | 当前平台和逐项诊断结果 |

创建任务使用 JSON，字段为 `title`、`description` 和 `targetPlatform`。目标平台可选 `WINDOWS`、`MACOS` 或 `BOTH`，说明可传空字符串。新任务的状态为 `CREATED`。

## 开发验证

```sh
pnpm typecheck
pnpm test
pnpm build
```

验收路径和平台覆盖见 [Sprint 1 测试记录](project_work/test_case/sprint-1.md)。
