# Feishu Codex 桌面版

Windows 首发版。新图标打开管理工作台并按需启动飞书桥接和共享 Codex，默认在就绪后一起打开官方 Codex 桌面。设置中可关闭自动打开，仅启动后台。原 Codex 图标保持独立模式；误开独立桌面时可选择“连接飞书”，确认终止运行中的任务后，自动关闭并重新打开。Windows 登录自启默认关闭，可在应用内启用。窗口关闭按钮默认收起到托盘，也可设置为退出全部服务；有任务运行时会先确认或提示。

## 文件和进程

- `main.mjs` / `preload.cjs`：Electron 窗口、托盘与固定 IPC 操作。页面没有 Node 或任意命令执行权限。
- `launch-coordinator.mjs`：协调自动打开、手动打开、等待独立桌面退出后的切换。只调用已有宿主打开接口，不结束进程；启动意图执行一次，失败不自动重复提交。偏好保存在数据目录的 `desktop/preferences.json`。
- `host.mjs`：独立 Node 宿主，监听 `127.0.0.1:18792`。由没有任何触发器的 `Feishu Codex Desktop Host` 计划任务按需启动，不随 Windows 登录启动。正常启动使用无控制台窗口的 VBScript 宿主，不创建 PowerShell 窗口。
- 宿主分别启动 `build/server/server.js`、`build/server/desktop-tools-relay.js` 和原生 `codex.exe app-server`。宿主退出异常时，计划任务可重启宿主；已确认退出的组件采用递增等待重启，5 分钟 5 次失败后等待手动重试。活着但无响应的进程不会被强制重启。
- `desktop/host-state.json` 是公开健康快照；`desktop/host-control.json` 含本机控制令牌，仅宿主、Electron 主进程和桥接服务器读取，绝不返回页面。
- 每个组件使用 PID、CIM 创建时间、可执行路径和端口归属核验身份。停止操作还等待进程及监听端口连续两次消失。

数据保存在 `%USERPROFILE%\.feishu-codex`，日志和进程记录在其 `desktop` 子目录。不会写入或复制 `.codex` 原生历史。组件环境只在子进程中修改，避免 Windows 大小写重复变量，也不污染原 Codex 入口。

## 接口

页面仅可调用 `window.feishuCodex` 的 `getStatus`、`getPreferences`、`setPreferences`、`openCodex`、`switchToShared`、`retry`、`openLogs`、`quit`、`setupFresh`、`migrate`、`showWindow` 和 `onStatus`。桌面偏好包含 `openCodexOnLaunch`、Windows 登录自启开关和关闭窗口方式；登录自启由 Electron 主进程读写当前应用的 Windows 启动项，关闭窗口方式只控制主窗口按钮。宿主状态另附 `launch` 说明准备打开、等待确认、正在重启及失败状态。重启确认框由主进程弹出，页面不能提交进程身份或跳过确认。

宿主 `GET /status` 返回健康快照。`POST /control` 使用 `X-Host-Token`，允许 `checkWrite`、`openCodex`、`retry`、`shutdown`。请求必须来自回环地址、正确 Host，且不带浏览器 Origin。`checkWrite` 会刷新原生进程拓扑；独立桌面、未知身份、组件未就绪或退出期间均禁止发送新指令。不会自动重放消息。

桥接启动环境包含 `FEISHU_CODEX_DESKTOP_HOST=1`、`FEISHU_CODEX_WRITE_GATE_FILE`、`FEISHU_CODEX_UI_DIR`。用户指令交给原生 Codex，始终 `danger-full-access` / `never`；Electron 的页面隔离仅限制管理网页自身。

## 首次设置

首次打开时点击“开始设置”，应用先检查已有数据、端口和后台任务，再注册按需启动的本机宿主，进入“设置 → 飞书连接”填写应用凭据。飞书处理进度默认开启，用户修改后保存在应用配置中。

## 打包

Electron 主包包含 `desktop/**`。`resources/product` 放置 `build/server`、`build/ui`、运行时依赖、`desktop`、`scripts` 和 `package.json`；`resources/node/node.exe` 放置随包 Node。开发模式通过 `FEISHU_CODEX_NODE_PATH` 或本机 `node.exe` 查找 Node。

`launch-packaged-shared.ps1` 是正式的商店包上下文启动适配器。它通过无控制台窗口的 `wscript.exe` 子进程，只为本次 Codex 桌面设置共享地址，并沿用官方桌面的用户数据和登录状态。`launch-packaged-probe.ps1` 仅保留给隔离诊断和升级复测。两者依赖 Microsoft 的诊断启动接口，不是官方承诺稳定的产品扩展 API；Codex 更新后应复测，独立原图标继续作为回退入口。此版本没有 macOS 支持。

## 验证

`node --test test/desktop-lifecycle.test.mjs test/desktop-windows.test.mjs` 检查环境规范化、进程归属、重试上限、双端模式识别、只读空闲查询及真实隔离进程的安全停止。Windows 测试只创建并停止自己的临时 Node 进程，不访问机器人凭证、不修改计划任务或生产服务。桌面烟测使用临时数据目录与 `FEISHU_CODEX_TEST_HIDDEN=1`，没有 deployment marker 时只打开首次设置页面。

显式运行 `node scripts/desktop-host-integration.mjs` 可验证宿主真实编排。它使用 18801/18802/18803、临时配置、关闭的机器人和独立工具管道，检查启动就绪、活进程无响应时保留 PID 并暂停、确认退出后恢复及空闲退出；没有发送 Codex 指令，也不操作计划任务。结果保存在 `artifacts/desktop-host-integration.json`。此测试通过 JS 注入只对该临时宿主生效的桌面快照；生产命令行没有这些注入入口。
