# B 站直播画面替换

在普通直播间 **B** 内观看另一个直播间 **A** 的画面，同时保留 **B 的声音、滚动弹幕、聊天和互动控件**。这是一个本地运行的 Chrome Manifest V3 扩展，无自建后端。

本项目由社区独立开发，与哔哩哔哩官方无隶属关系。

## 安装（Windows 11）

运行扩展需要 Chrome 111 或更高版本。

### 使用发布包

从 [GitHub Releases](https://github.com/zed-runzeZhang/bilibili-live-swap/releases/latest) 下载扩展安装包 `bilibili-live-swap-v0.1.0.zip`，并解压到本地固定目录。解压后的目录直接包含 `manifest.json`；使用发布包不需要 Node.js。

1. 地址栏打开 `chrome://extensions`，开启右上角的「开发者模式」。
2. 点击「加载已解压的扩展程序」。
3. 选择解压后**包含 `manifest.json` 的目录**。
4. 打开或刷新准备作为 B 的普通直播间。安装、更新或在扩展管理页点击「重新加载」后，之前已打开的 B 标签页都需要刷新。
5. 可在扩展菜单中固定「B站直播画面替换」，方便打开控制面板。

### 从源码构建

需要 Git、Node.js 24.x 和 npm。在准备存放项目的目录中打开 PowerShell，运行：

```powershell
git clone https://github.com/zed-runzeZhang/bilibili-live-swap.git
cd bilibili-live-swap
npm ci
npm run check
npm test
npm run build
```

构建完成后，按上方步骤在 Chrome 中加载仓库内的 **`dist` 目录**，该目录包含生成的 `manifest.json`。

修改源码后重新运行 `npm run build`，在扩展管理页重新加载扩展，再刷新 B 页面。

## 使用与验收

1. 打开 B 的普通直播间，例如 `https://live.bilibili.com/7777`。先在 B 的原播放器中手动点击播放、取消静音，并确认听到了 B 的声音。扩展不会替你播放、暂停或调节 B 的音量。
2. 点击扩展图标，在「画面来源」输入 A 的房间号，例如 `6`，或完整链接 `https://live.bilibili.com/6`。
3. 点击「启用画面替换」。加载完成前继续显示 B；状态变为「替换中」后，画面应来自 A，声音仍来自 B。
4. 检查 B 的滚动弹幕位于 A 画面上方，B 的聊天输入框、互动区域和播放器控件仍能正常使用。A 的弹幕、交互界面和声音应被抑制。
5. 使用 **B 原播放器**的网页全屏与原生全屏按钮，检查 A 画面和 B 弹幕仍在同一个播放器区域内。覆盖层跟随原播放器容器进入全屏；其他结构的全屏方式需要单独验证。
6. A 长时间缓冲或发生错误时，面板会显示原因并恢复 B 画面。可点击「重新连接 A」，或输入另一个 A 后点击「更新画面来源」。
7. 点击「关闭替换」会销毁 A 的播放器，恢复 B 的原画面。**刷新 B 页面后默认关闭**，所有状态只存在于当前页面。

若面板提示「未连接」，先刷新 B 页面再重新打开面板；若一直显示「等待播放器」，先确认 B 已播放，并且当前页面是受支持的普通直播间。B 被静音或暂停时，面板会给出对应提示，需要在 B 的原播放器中处理。

## 实现方式

实测普通直播间使用 `#live-player.live-player-mounter`：其直接子元素 `<video>` 同时承载 B 的音视频，视频层 `z-index: 1`；独立的 `.web-player-danmaku` 弹幕层为 `z-index: 10`。扩展将 A 的官方嵌入播放器 iframe 放在两者之间，当前结构下为 `z-index: 2`，并设置 `pointer-events: none`，使操作继续传递给 B。

扩展不会移除 B 的视频，也不会修改其媒体源、暂停状态、静音或音量。运行时只识别已知的播放器容器，并检查视频和弹幕之间存在可用层级；不满足条件的页面会显示提示。

A 使用 [B 站官方嵌入活动播放器](https://live.bilibili.com/p/html/bilibili-live-player/docs/player-activity.html)，传入官方静音参数 `mute=1`。此外，`source-guard.ts` 在嵌入子页面的 `document_start` 阶段、`MAIN` 执行环境中安装静音约束，限制媒体的 `muted`、`defaultMuted`、`volume` 和 `play()`，处理新增媒体及 Web Audio 输出，并隐藏 A 的非视频界面。该约束只对携带本扩展随机 token 的官方嵌入子页面启用。关于注入时机、执行环境及 iframe 匹配，可参阅 [Chrome content scripts 文档](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)。

B 端验证消息来源、iframe 窗口和随机 token；仅在静音约束就绪、A 视频实际开始推进后显示覆盖层。缓冲、失联或启动超时会恢复 B 画面。播放器 DOM 重建时进行有限次数的重新挂载。

房间短号由浏览器扩展的 service worker 调用 B 站官方 `room/v1/Room/room_init` 接口解析，并检查直播状态。例如 2026-10-25 的接口响应将短号 `6` 解析为真实房间号 `7734200`；映射每次通过接口获取，没有写死。service worker 只做房间解析，无自建服务器、流代理或远程执行代码。

## 权限与数据

`public/manifest.json` 声明的范围如下：

| 权限或匹配范围 | 用途 |
| --- | --- |
| `activeTab` | 用户打开面板时识别当前标签页，并向该直播间发送控制消息。 |
| `https://api.live.bilibili.com/*` | service worker 解析短号、真实房间号和直播状态；请求使用 `credentials: 'omit'`。 |
| `https://live.bilibili.com/*` | 注入 B 页面脚本；代码进一步限定为顶层、数字房间号路径及已知播放器结构。 |
| `https://www.bilibili.com/blackboard/live/live-activity-player.html*` | 在匹配的 iframe 中注入 A 静音约束；代码进一步限定路径、子页面及随机 token。 |

扩展不使用持久化存储，不读取或保存用户凭据，也不调用 cookies API。官方嵌入播放器自身的正常网络请求和登录状态处理仍由 B 站页面负责。

## 测试

本次执行的详细结果见 [VERIFICATION.md](VERIFICATION.md)。

`npm run check` 检查 TypeScript；`npm test` 运行输入、消息、播放器分层、B 媒体状态不变、关闭清理、重建恢复、静音约束和弹窗等单元/DOM 测试。测试数量以当前命令输出为准。

浏览器测试需要 Playwright Chromium，首次使用可先运行：

```powershell
npx playwright install chromium
npm run build
npm run test:browser
```

本机已有近期版本 Chrome 时，也可以跳过浏览器下载，使用独立配置目录测试（Chrome 的扩展调试接口用于加载测试扩展）：

```powershell
$env:BILI_SWAP_BROWSER_CHANNEL = 'chrome'
npm run test:browser
```

若测试浏览器需要显式网络代理，可设置 `BILI_SWAP_PROXY` 为自己的代理地址；该设置只影响测试浏览器，不会写入扩展配置。

`test:browser` 在独立 Chromium 配置目录中实际加载构建后的未打包扩展，将 B 页面、A 官方播放器地址及房间解析接口替换为可控测试页面和响应。它检查真实扩展注入、弹窗操作、媒体时间推进、A 静音约束、B 媒体状态、图层及清理。这项测试使用合成媒体，不能据此确认当时的真实直播服务可播放。

真实站点检查可另行运行：

```powershell
npm run test:browser -- --live
```

该模式访问真实 B 站页面及 A 直播间，受当时开播状态、网络、登录及浏览器环境影响。测试报告和辅助产物写入 `artifacts/`；是否通过以当次输出和报告为准。浏览器脚本使用静音启动参数，人工验收时仍应按上文确认实际听到的声音只来自 B。

## MVP 限制

- B 仅支持已知结构的普通直播间；赛事专题、活动页或其他播放器结构暂不支持。A 可以使用可由官方接口解析、且可在官方嵌入播放器中播放的直播间。
- 不绕过未开播、轮播、登录、地区、版权或其他访问限制；遇到限制会显示失败或超时提示。
- A、B 是两条独立直播流，天然存在延迟差；此版本不做音画同步或直播时钟调整。
- 同时运行两个官方播放器，需要两路网络流量和视频解码资源。A 静音并不消除这部分开销；关闭替换后销毁 A iframe。
- 扩展依赖 B 站官方嵌入播放器及页面 DOM。站点更新后可能需要调整选择器、布局或静音约束。

## 许可证

本项目采用 [MIT License](LICENSE)。
