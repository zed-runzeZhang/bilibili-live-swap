# 验证记录

日期：2026-10-25（Asia/Shanghai）。环境：Windows 11、Node 24.18.0、Chrome 155.0.8059.86。

以下记录对应上述日期的验证，真实站点的后续状态需重新运行测试确认。

## 结果

- `npm run check`：通过，TypeScript 无错误。
- `npm test`：5 个测试文件，75 项测试通过。覆盖房号与消息校验、短号解析与接口异常、A 静音、Web Audio 输出、真实时间推进判定、视频层级、B 媒体保留、关闭清理、异步取消和延迟重建恢复。
- `npm run build`：通过，生成 Manifest V3 扩展及本地脚本。
- `npm audit --omit=optional`：0 vulnerabilities；更新依赖时的完整审计也为 0。
- 实际 Chrome 加载扩展的合成媒体测试：通过。A/B 均包含音视频轨，媒体时钟均推进，B 控件点击和聊天输入可用。
- 实际 Chrome 加载扩展的真实站点测试：通过。B 为普通房间 `7777`；从真实 popup 输入 A 短号 `6`，由扩展 service worker 实际解析为 `7734200`，调用真实官方播放器。

## 真实扩展测试快照

最终通过时间：2026-10-25 15:18（上海时间）。

| 检查 | 观察 |
| --- | --- |
| A 播放 | `videoWidth=1280`，`paused=false`，currentTime 持续增加 |
| A 静音 | 设置 `muted=false`、`volume=1`、`defaultMuted=false` 后仍是 true / 0 / true |
| B 声音状态 | `muted=false`、`volume=0.6`、`paused=false`，媒体时钟持续增加 |
| B 媒体保留 | 替换前后为同一个 video，currentSrc 未变 |
| 分层 | A iframe z-index 2，B 弹幕 z-index 10；iframe pointer-events none |
| 控制 | popup 的启用、重新连接 A、关闭均通过 |
| 恢复 | 关闭后 A iframe 被移除，B video 保留；刷新后无替换 iframe |

另在已连接的真实浏览器里运行同一核心代码超过五分钟，A 时间达到 345 秒且保持静音；B 的 video、src、音量与静音状态保留，关闭正常恢复。

浏览器自动测试使用 `--mute-audio` 让测试不向扬声器输出，验证的是媒体轨、时间、静音与音量状态。实际听到的声音、登录后的发送弹幕、礼物互动，以及原生/网页全屏按 README 的人工清单复核；自动测试不会发送真实弹幕或礼物。真实站点在游客会话中出现过 B 站验证弹层，测试未处理或绕过该弹层，媒体仍在播放。

首次独立浏览器访问出现过网络和房号解析超时；同一扩展构建在显式使用本机已有代理后，最终完整流程通过。扩展对解析请求设置 10 秒超时并提供重试，不写死任何代理。

## 复现与产物

参见 README 的浏览器测试命令。默认使用 Playwright Chromium；本次使用 `BILI_SWAP_BROWSER_CHANNEL=chrome`，通过 Chrome 的 CDP 接口在独立配置目录加载本地扩展，并模拟真实扩展按钮动作授予 activeTab。

测试会在本地生成 `artifacts/fixture-report.json`、`artifacts/live-report.json` 等机器记录和辅助截图。`artifacts/` 与独立浏览器配置目录均忽略入库。这些报告和截图保留在执行测试的本机，不随公开 Release 安装包发布；安装包也不包含浏览器配置、cookies 或凭据。
