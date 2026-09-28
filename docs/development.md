# 开发与构建

## 环境

- Windows x64。
- Node.js 22.13+，建议 Node.js 24。
- npm、Git；UI 测试需要 Microsoft Edge。
- 真实双端联调需要已安装并登录的 Windows Codex；自动化测试不需要真实飞书凭据。

```powershell
git clone https://github.com/xinyu68/feishu-codex.git
cd feishu-codex
npm ci
npm run typecheck
npm test
npm run build
npm run test:ui
```

## 安全的界面开发

```powershell
npm run dev:ui
```

打开 Vite 打印的地址，并加上 `?demo=1`。演示模式使用模拟项目、消息和账号，不连接真实飞书，不提交 Codex 任务。

`npm run dev:desktop` 用于开发 Electron 壳；桌面宿主会读本机配置，首次设置可能注册本应用的后台任务，因此请在测试账号或隔离环境中进行真实生命周期联调。

`npm run dev` 运行桥接服务。联调时先设置独立的 `FEISHU_CODEX_DATA_DIR` 和空闲端口，保持测试配置 `enabled: false`；不要复制正在使用的机器人凭据再启动另一套接收器。没有需要真实机器人时，使用 `scripts/serve-api-fixture.ts` 与 UI 测试夹具。

## 构建安装包

```powershell
npm run package:win
```

产物：`release/Feishu-Codex-<版本>-Setup.exe`。

构建先生成 `build/server` 和 `build/ui`，随后在 `.desktop-package` 准备生产依赖与 Node.js 运行时，再用 electron-builder / NSIS 打包。`afterPack` 会检查依赖文件完整性，并用随包 Node 加载服务入口。

Node.js 运行时来自当前构建机的 `node.exe`；安装包必须在 Windows x64 下构建。依赖和 Node.js 许可证下载需要联网。当前构建没有配置发布者签名证书，不应描述为签名发行版。

GitHub Actions 中的 **Build Windows installer** 支持手动构建，成功后生成带 SHA-256 校验文件的下载产物；它不会自动创建 Release 或发布版本。

## 自动检查

| 命令 | 检查内容 |
| --- | --- |
| `npm run typecheck` | 服务与前端类型 |
| `npm test` | Codex 协议、去重、授权、通知、进程与安装生命周期 |
| `npm run build` | 服务和界面生产构建 |
| `npm run test:ui` | Edge 中的工作台、设置、会话切换与隔离 API 测试 |

UI 测试服务使用本机 8795 / 8796 端口及临时数据。Windows 进程测试只操作自己创建的夹具进程。更深的宿主编排测试和安装卸载验收应在测试环境中显式运行，详见 [验收清单](testing.md)。

## 仓库内容

公开源码不包含 `node_modules/`、`build/`、安装包、个人配置、真实聊天数据和本机诊断记录。截图来自演示模式。

`DESIGN.md` 介绍架构；`desktop/README.md` 记录宿主细节。部分迁移脚本仅用于开发阶段维护，不是新用户安装步骤。不要把旧脚本写入全局环境变量的操作用于新安装流程。

维护者：**xinyu68 <1693784423@qq.com>**。
