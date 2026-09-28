# 参与贡献

欢迎提交可复现的问题、文档改进和 Pull Request。项目当前聚焦 **Windows 上的 Codex 桌面与飞书会话接续**。

## 开始开发

开发环境、运行命令和目录结构见 [开发指南](docs/development.md)。提交前运行：

```powershell
npm run typecheck
npm test
npm run build
npm run test:ui
```

这些自动化测试使用隔离数据或模拟服务，不要求配置真实飞书凭据。UI 测试使用 Microsoft Edge。涉及 Windows 启动、退出、升级和卸载的改动，还需按 [验收清单](docs/testing.md) 做实机验证。

## 提交约定

- 一次 PR 聚焦一个问题，说明实际行为、预期行为和验证结果。
- 使用 TypeScript / ESM，保持现有代码风格。只为行为变化补充有意义的回归测试。
- 不修改用户的 Codex 登录信息、项目文件、历史记录或个人 Skills。
- 保留线程与轮次归属判断、消息去重和进程身份检查。网络结果不确定时不得自动重放指令。
- 不提交 App Secret、访问令牌、用户日志、真实会话截图或本机配置。
- 不对已有机器人启动第二个消息接收器；联调使用独立测试应用。

贡献以本项目的 [MIT License](LICENSE) 发布。引用第三方实现时保留相应版权声明，并更新 [NOTICE.md](NOTICE.md)。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中贴凭据或利用细节。
