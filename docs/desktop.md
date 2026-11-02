# Piik-RTC 桌面端

本分支可选接入火山原生 RTC，详见[原生测试说明](native-rtc.md)。原生组件默认不随主程序分发，进入 `volc`/`volc2` 房间时可按需下载（约 22 MB）；下文单文件和 Web SDK 说明适用于未安装原生组件的普通模式。

桌面端是一个 **单文件、免安装** 的 Windows 程序（约 7.4 MB），不是网页套壳：

- 使用系统自带的 Microsoft Edge WebView2 加载现有 React 界面和声网、即构、火山引擎 RTC Web SDK。
- C# 主程序负责窗口枚举、缩略图、画面采集和 IPC，不引入 Electron/Chromium 运行时。
- 内置一个自包含的 .NET 9 音频组件，使用 Windows 进程回环采集声音；发行时压缩嵌入主程序，运行时释放。
- 自定义“程序 / 屏幕”选择器，支持只共享某个程序的声音，以及共享系统声音时过滤 Oopz / KOOK / Discord 等语音软件。

## 使用方式

1. 运行 `release/Piik-RTC-v<版本>.exe`。单文件，不需要安装。
2. 首次启动填写已部署的 Piik-RTC 服务器地址：
   - 生产环境必须使用 `https://`。
   - 本机调试可以使用 `http://localhost:3000`。
   - 如果服务器通过 Nginx 等反向代理启用了 HTTP 认证（如 `auth_basic`），连接后会在应用窗口内显示登录页（与设置页同一套界面），输入代理配置的用户名和密码即可；勾选“记住密码”后会用当前 Windows 账户加密保存，重开程序无需再次输入。服务器地址里不用写 `user:pass@`，写了也会被忽略。
   - 如果构建时内嵌了服务端地址，首次启动会直接连接，不再显示这一步。
3. 地址保存在 `%LOCALAPPDATA%\PiikRTC\config.json`；在窗口内右键打开菜单，选择“服务器设置…”可以修改，也支持启动参数 `--server=https://...` 或环境变量 `PIIK_SERVER_URL`。优先级：启动参数 > 环境变量 > 已保存配置 > 构建时内嵌地址。
4. 本版本起使用 `%LOCALAPPDATA%\PiikRTC`；旧版本留下的 `%LOCALAPPDATA%\PiikDesktop` 不会自动迁移，升级后需要重新填写服务器地址并登录。

桌面端加载服务器上的网页前端，所以服务端更新后界面也会更新；只有桌面壳或原生采集改动才需要重新发布客户端。

## 自动更新

启动后会在后台读取 GitHub Releases 的 `version.json`，与当前程序集版本比较。发现新版本时会从 GitHub 官方 API 获取该版本的 EXE SHA-256 摘要。下载过程显示进度，完成后同时校验文件摘要和程序集版本，再通过 PowerShell 辅助进程在程序退出后启动新版本并删除旧文件。

- 版本信息优先通过 `https://v4.gh-proxy.org/https://github.com/.../releases/latest/download/version.json` 获取，失败后回退 GitHub 直连。
- 程序文件会并发探测 `v4.gh-proxy.org`、`v6.gh-proxy.org`、`gh-proxy.com`、`ghproxy.net`，选择最快的镜像并用 4 个连接分段下载；线路中断时自动切换到其他镜像，全部不可用后回退 `github.com` 原始地址。下载框会显示实时速度。
- 第三方镜像仅用于加速下载，不能决定更新内容。无法从 GitHub 官方 API 验证摘要或文件摘要不一致时，不安装更新。这需要网络能访问 `api.github.com`；官方 API 不可用时可到 GitHub Releases 手动下载。
- 更新会下载到当前 exe 所在目录，因此程序需要放在有写权限的位置；放在受保护目录时请手动下载替换。
- 右键菜单中的“检查更新…”可以手动检查；设置环境变量 `PIIK_DISABLE_UPDATE=1` 可以跳过启动检查。
- 由于文件名带版本号，更新后启动的是新文件，新版本启动后会删除旧版本文件。旧快捷方式可能需要重新指向新文件。
- 火山原生组件不随 exe 自动更新；Windows 桌面端进入 `volc`/`volc2` 房间时会提示按需安装或沿用已安装版本，见 [native-rtc.md](native-rtc.md)。

## 系统要求

- Windows 10 2004（build 19041）或更高版本，推荐 Windows 11。
- Microsoft Edge WebView2 运行时。Windows 11 和带 Edge 的 Windows 10 通常已经自带；缺失时程序会提示安装。
- 共享内存原始帧路径需要 WebView2 93 或更高版本；更旧的运行时会自动回退到 JPEG 采集。
- 程序声音和语音过滤依赖 Windows 进程回环 API；低于 19041 时只能共享系统声音。
- 网页版仍然可以使用浏览器自带选择器，不需要安装桌面端。

## 架构

```
Piik-RTC-v<版本>.exe（C# / .NET Framework 4.8 / WinForms / WebView2）
├─ WebView2 加载远程 Piik 页面
│   └─ 注入 shim.js，暴露 window.piikDesktop
├─ 原生窗口/屏幕选择器
│   ├─ EnumWindows + PrintWindow 缩略图
│   └─ Windows Graphics Capture → 缩放 → 共享内存 → VideoFrame
│       （高分辨率/高帧率或 WGC 不可用时回退 GDI + JPEG）
└─ 内嵌 PiikAudio.exe（.NET 9，自包含，压缩嵌入）
    └─ WASAPI 系统回环 / 进程回环 include/exclude
        └─ PCM → 主程序 → WebView2 消息
```

渲染端优先使用 Windows Graphics Capture 采集 GPU 画面：源帧与目标分辨率不同时，先用 D3D11 VideoProcessor 在 GPU 上等比缩放到目标尺寸，再通过 staging 纹理回读，BGRA 帧经 WebView2 共享内存传给前端，按服务商自动选择轨道路径交给 RTC SDK：两个火山应用使用隐藏 canvas + `canvas.captureStream()`，其他服务商优先使用 `MediaStreamTrackGenerator`（Insertable Streams），不支持时回退 canvas。两条路径都只编码一次，不再经过 JPEG。GPU 缩放不可用时回退 SoftwareBitmap + GDI+ 缩放；选择 1440P/原画或 WGC 不可用时，回退到 GDI+ + JPEG 桥接。音频 PCM 经过 AudioWorklet 和 `MediaStreamAudioDestinationNode`，同样交给 RTC SDK。即构房间的共享画面最高为 1080P、码率最高为 10 Mbps，选择 1440P/原画或 12/16 Mbps 时会自动按 1080P / 10 Mbps 采集。

## 原生采集

诊断报告从 `schemaVersion: 2` 起新增 `shareAttempts`：每次开始共享生成独立编号，保存启动时间、发布/结束时间、请求与实际应用的设置、传给编码器的参数、采集尺寸/路径和成功、停止或失败状态。历史采样中的 `shareId` 对应此编号；停止后记录仍保留，后续修改设置不会改写旧配置。`preferences` 仅表示导出时的当前设置。高负载模拟与对照步骤见 [共享高负载复测](共享高负载复测.md)。

`schemaVersion: 3` 统一声网、即构、火山三家编码诊断。`media.local.diagnostics` 和 `localVideoStats.diagnostics` 中，每项指标包含 `status` 与 `value`：支持且有数据为 `available`（保留真实的 0 和 false），拿不到时为 `unavailable`、`value: null` 并说明原因。当前声网提供编码耗时，即构提供硬件编码标志/编码帧率，火山提供编码输出帧率、编码帧数、编码码率和上行丢包；是否实际返回仍以 SDK 和浏览器为准。三家当前使用的公开接口均未提供完整的受限原因与编码器实现名称，报告不会根据码率、CPU 核数或显卡总占用猜测这些值。火山两个应用使用相同诊断接口。

本地与远端统计的 `observation` 记录来源、回调/轮询、观测时间、读取时间、观测距今时间和 SDK 提供的统计周期。回调超过 6 秒标记 `stale: true`；轮询只能知道读取/缓存时间，`stale: null` 表示不能判断 SDK 原始样本是否陈旧。当前三家公开统计均未提供可用的源采样时间戳，因此 `sdkSampleAt`、`sdkSampleAgeMs` 为 null，不能将刚刚读取等同于刚刚采样。没有真实数据的上行带宽、目标码率、编码耗时不再以缺省 0 导出。

共享设置已移除“桌面采集兼容模式”，以前保存的模式选择会被忽略。轨道路径按服务商自动选择：两个火山应用使用 Canvas；声网、即构在支持时使用 Generator，不支持时回退 Canvas。首次共享异常仍在排查中，不根据一次低帧率采样自动停止重建；浏览器共享继续使用浏览器原生轨道。

开始共享会分别确认“收到原生帧”和“成功写入轨道”。Generator 必须先允许 RTC 消费轨道，再等待写入成功，避免首次写入的背压阻塞初始化；首帧超时或写入失败不会当作成功发布。采集不再伪造 `getSettings()` 的分辨率/帧率；编码目标尺寸由原生采集返回值单独传递。诊断报告的 `capturePipeline` 和每两秒的媒体历史记录实际路径、目标尺寸/帧率、收到帧数、写入帧数、丢弃帧数、写入错误及首末帧时间。写入成功仅表示进入轨道，是否实际发送仍需结合 RTC 编码/发送统计判断。

火山发布流程在绑定外部轨道前一次性设置实际尺寸、帧率和码率，不在发布后延时重设编码参数；发布、停止按顺序执行，退出会取消尚未完成的发布，并在销毁引擎前等待操作收尾。发布失败或停止失败时仍尝试释放视频和音频绑定，避免下一次共享继承残留状态。声网、即构保留各自的发布流程。

两个火山应用在媒体引擎连接后的首次共享有一次发布恢复机会：仅观察发布后的前 20 秒，至少等待 8 秒，并要求连续三次有效统计中采集达到目标帧率的 60%、编码不超过目标的 25%（60fps 时为 15fps，30fps 时为 7.5fps）、编码宽高都降到目标的 75% 以下、丢包不超过 2%、RTT 不超过 200ms。条件满足后仅取消并重新发布一次屏幕流，保留原采集、外部轨道绑定和编码配置；不会重新选择窗口或停止原生采集。连续三次达到目标 70% 的正常编码帧率后结束观察。低分辨率本身、慢采集、字段缺失或明显网络异常不会触发。此机制是有界恢复措施，不代表已经确定 SDK 内部故障原因，也不保证持续 1080p60。

诊断的 `localVideoStats.startupRecovery` 与 `mediaHistory[].local.startupRecovery` 保存观察、触发、重发完成、取消或失败状态及对应时间；`republished` 只表示重发调用完成，是否恢复画质仍以之后的媒体采样为准。恢复失败会停止本地共享并提示。火山观看端保留短暂停播的当前成员选择 2 秒，以便重发后重新订阅；超时仍未发布时切换到其他来源，用户主动切换不受覆盖。声网和即构不启用该恢复流程。

火山远端停播时立即作废旧轨道和旧订阅任务，每轮发布使用独立的订阅版本，避免快速重发被误认为原订阅仍正常；旧订阅、取消订阅和音量操作的迟到结果不能覆盖新发布。网页资源更新后，共享端和观看端都需刷新或重新打开，观看端代码不会随共享端的重发自动更新。报告的 `app.mediaRevision` 为 `2026-11-02-republish-subscription-v2` 时包含此修正。


`2026-11-02-viewer-recovery-v4` 加入接收端的状态对齐：服务端确认对方仍在共享，但火山 RTC 缺失发布状态持续 6 秒，或已发布却没有有效视频输出持续 16 秒时，纯观看端会退出并重新进入媒体房间，再选择原共享者，保留页面、房间会话和个人设置。每次进房对同一共享者最多自动尝试一次；重进成功仅记为 `rejoined`，确认视频输出后才记为 `receiving`。退出媒体房间等待服务器确认，8 秒超时仍销毁旧引擎，退出失败不继续自动重进。

此接收恢复仅用于两个火山应用。本机正在共享、后台页面、主动暂停、交互进行中、监控租约失效或浏览器限制自动播放时均不触发；用户切换成员或离房会阻止迟到任务抢回旧画面。浏览器限制自动播放时，点击页面重试播放，不借此重进房间。服务端仍声明共享时，成员列表不会因暂时缺失的 RTC 状态显示为已停播。

诊断新增顶层 `viewerRecovery` 和 `mediaHistory[].viewerRecovery`，记录触发原因、重进、实际出画、取消或失败；`media.playbackElement` 与对应历史字段记录播放器挂载、首帧计数、播放错误、原始轨道状态，区分订阅缺失与播放器未出画。静态画面已有首帧时，不因低帧率重建。此机制不刷新网页、不调整发送画质，声网和即构不启用接收重进流程。

`2026-11-02-startup-guard-v5` 修正首次恢复对波动低帧率的漏判：按目标帧率的 25% 判断严重降帧，不再叠加固定的 10fps 上限，避免 60fps 共享在 2～14fps 波动时反复清空异常计数、最终观察到期。保留连续三次有效统计、至少等待 8 秒、采集正常、编码尺寸下降及网络指标条件；仍只尝试一次，低分辨率但高帧率不会因此重发。包含此前接收端恢复功能，不保证重发后立即恢复 1080p。

`2026-11-02-gentle-recovery-v6` 将接收恢复分级：SDK 已发布但没有画面持续 14 秒时，先等待正常订阅的超时窗口结束，再重试订阅并重新绑定播放器，保留媒体连接和现有音频，不先取消订阅或退房。轻量操作完成后至少再留 8 秒出画时间；持续无画面总计至少 20 秒、新发布也至少等待 16 秒后，才考虑退出并重进媒体房间。每次进房对全部共享者合计最多自动重进一次，对每位共享者最多轻量重试一次。新发布到达时从该时刻等待首帧，不把此前等待发布的时间直接算成播放失败。报告增加 `resubscribing`、`resubscribed`、`resubscribe-failed` 阶段，`receiving` 仍以有效画面判定为准。

1080p60 的自动码率上限与高帧率预设提高为 16Mbps，声网和两个火山应用使用该上限，即构仍按项目约束限制为 10Mbps；低帧率、低分辨率档位和用户手动设置保留。上限用于允许 SDK 自适应发送，不是固定流量，也不宣称是 SDK 理论最大值。火山 Web 屏幕共享的 `maxKbps` 要求大于 0，其他端或接口的 `-1` 自动码率规则不直接适用。官方参数对照表的 20Mbps 是 4K60 游戏场景的建议值，不是硬上限。

已有首次、再次共享的两端报告用于后续排查，无需重复同一轮参数对照。开发侧先运行适配器生命周期回归，覆盖配置顺序、停止与重发并发、失败清理和退出取消。原生帧未到达时检查窗口与主机采集；输入持续到达但写入不增长时检查轨道路径；写入持续增长但发送帧率低时检查 RTC 编码/发布。真实 SDK 的分辨率自适应与高负载表现仍需开发侧运行验证，不能以模拟 SDK 测试宣称问题已彻底修复。

- **画面**：优先使用 Windows Graphics Capture 捕获窗口或显示器，GPU 帧按目标分辨率等比缩放（不放大）。缩放优先使用 D3D11 VideoProcessor 在 GPU 上完成并 staging 回读，避免每帧 GDI+ 缩放；后端再以 BGRA 通过共享内存交给前端。两个火山应用画到隐藏 canvas 再 `captureStream()`；其他服务商支持 Insertable Streams 时直接写入 `MediaStreamTrackGenerator`，不支持时回退 canvas。主窗口最小化时不会真正进入 Windows 最小化状态，而是移到屏幕外并保留托盘图标，避免 WebView2 暂停页面渲染；后台/遮挡节流也已关闭。WGC 不可用或选择 1440P/原画时回退到 `PrintWindow(PW_RENDERFULLCONTENT)` / `CopyFromScreen` + JPEG（质量约 72）。最小化的窗口不会出现在列表里；个别受保护或特殊渲染的窗口可能返回黑帧。
- **最小化**：点击最小化会把窗口移到屏幕外，托盘图标保留，屏幕共享继续；双击托盘图标或点击任务栏恢复窗口。这样 WebView2 页面不会因为真实最小化被 Chromium 节流。
- **退出**：关闭窗口会先触发页面的 `pagehide`，发送离房请求并让 RTC 离开，成员通常会在 1 秒内从房间消失；Windows 关机或任务管理器强杀时无法保证即时离房。
- **音频**：与网页版相同的 WASAPI shared-mode 回环。系统模式请求 48 kHz / 16-bit / stereo，失败时回退 44.1 kHz；程序模式使用 Windows 进程回环的 include/exclude 进程树。
- **语音过滤**：一次排除一个进程树，默认选择检测到的 Oopz / KOOK 等语音软件。语音软件重启后，请停止并重新开始共享。
- **声音来源**：选择窗口时可以只共享该程序的声音；选择屏幕时可以共享整个系统声音并选择要过滤的语音软件。

## 构建

前置条件：

- Node.js 24+（构建网页资源和运行脚本）。
- .NET 9 SDK（发布自包含音频组件；首次还原 NuGet 包需要网络）。
- Windows 10/11；系统 WebView2 运行时只用于运行，不打进安装包。

```bash
npm install
npm run desktop:dev      # 复用/启动本地服务，构建并运行 release/Piik-RTC-v<版本>.exe（带 9222 调试端口）
npm run desktop:build    # 发布音频组件、压缩嵌入、构建单文件 release/Piik-RTC-v<版本>.exe
npm run desktop:helper   # 只发布 desktop/bin/PiikAudio.exe，便于单独调试音频
```

构建时内嵌服务端地址：

```bash
npm run desktop:build -- --server=https://piik.example.com
# 或使用专门的命令
npm run desktop:build:embed -- --server=https://piik.example.com
```

内嵌地址会写入 exe，首次启动直接连接该服务器，不需要用户填写。用户仍可以在窗口内右键打开菜单，选择“服务器设置…”修改；`--server` 启动参数和 `PIIK_SERVER_URL` 环境变量也会覆盖它。`desktop:build:embed` 必须通过 `--server` 或 `PIIK_DEFAULT_SERVER_URL` 指定地址；构建脚本也接受环境变量 `PIIK_DEFAULT_SERVER_URL`，便于 CI 使用。

版本号取自 `package.json`，构建时写入桌面程序集，并显示在网页帮助页和桌面服务器设置页。发布前先提升版本（例如 `npm version patch --no-git-tag-version`）；桌面端由手动触发：在 GitHub Actions 中运行 `.github/workflows/desktop.yml` 的 `Desktop` workflow，会构建 `Piik-RTC-v<版本>.exe` 和 `version.json`、上传 artifact，并按该版本创建/更新 GitHub Release。

手动运行时必填 `version`（例如 `1.1.6` 或 `v1.1.6`），运行标题显示为 `Piik-RTC-v1.1.6`。工作流先校验输入与该次检出的 `package.json` 版本一致，不一致时停止，后续测试、构建和发布均不执行。

构建流程：

1. `dotnet publish` 把 `desktop/native/PiikAudio` 发布成裁剪、自包含的 12.8 MB 单文件。
2. 用 gzip 压缩到约 5.8 MB，写入 `desktop/PiikRTC/Resources/PiikAudio.exe.gz`。
3. `dotnet build` 构建 C# 主机；Costura 把 WebView2 托管 DLL 嵌入 exe，音频组件作为资源嵌入。
4. 输出 `release/Piik-RTC-v<版本>.exe`（约 7.4 MB）和 `release/version.json`。

发布工作流会额外生成 `release/native-volc-v<版本>.zip`（约 22 MB），并把版本、大小和 SHA-256 写入 `version.json` 的 `native` 段；桌面端在火山房间内按需下载。

首次运行会把音频组件释放到 `%TEMP%\PiikRTC\audio\PiikAudio.exe`；WebView2 用户数据在 `%LOCALAPPDATA%\PiikRTC\WebView2`。

## 体积

| 项目 | 大小 |
| --- | --- |
| `release/Piik-RTC-v<版本>.exe`（单文件） | 约 7.4 MB |
| 火山原生组件 `native-volc-v<版本>.zip`（按需下载） | 约 22 MB |
| 其中压缩后的音频组件 | 约 5.8 MB |
| 主机 + WebView2 托管 DLL | 约 0.6 MB |
| WebView2 运行时 | 系统自带，不随程序分发 |

这比 Electron 方案的安装包（约 112 MB）小一个数量级。桌面端仍要通过 WebView2 中转画面，但 1080P/60fps 及以下使用 WGC 原始帧路径，不再经过 JPEG；支持 Insertable Streams 时直接写入生成器轨道，避免窗口最小化/遮挡时 canvas 渲染被节流，不支持时退回 canvas。1440P/原画会回退到 JPEG 桥接，CPU 占用更高。

## 限制与排障

| 现象 | 检查 |
| --- | --- |
| 提示无法启动 WebView2 | 安装 Microsoft Edge WebView2 运行时；Windows 11 通常已自带 |
| 列表里没有某窗口 | 最小化的窗口不会被列出，先恢复窗口再刷新 |
| 程序声音没有声音 | 确认 Windows 版本 ≥ 19041；该程序的声音可能不在窗口进程树内，改用共享屏幕 |
| 过滤后仍有回声 | 语音软件可能已重启；重新开始共享，并在选择器中确认选中的是当前语音软件 |
| 画面卡顿 | 1080P/60fps 及以下使用 WGC 路径；1440P/原画会回退 JPEG。若 60fps 仍卡，降到 30fps 或 720P |
| 关闭客户端后仍显示在房间 | 正常关闭会先发送离房请求；强制结束进程或系统关机时会等到服务端心跳超时 |
| 某窗口画面全黑 | 该窗口可能禁止 WGC/PrintWindow 捕获；改为共享整个屏幕或使用浏览器 |
| 连接时显示登录页或提示 401 | 反向代理启用了 HTTP 认证，在登录页输入代理配置的用户名和密码；保存的密码失效时会重新显示登录页并删除旧凭据，取消后回到设置页重新连接即可 |
| 想清除保存的登录密码 | 在窗口内右键选择“清除保存的登录信息…”，重启程序后生效；也可以在登录页取消勾选“记住密码”后重新登录 |
| 无法连接服务器 | 在设置页重新填写地址；生产环境使用 HTTPS，自签名证书不会被接受 |

## 安全边界

- WebView2 只允许导航到配置的服务器来源；外部链接交给系统浏览器打开。
- 原生 IPC 会校验消息来源；只有本地设置页可以修改服务器地址。
- 反向代理的 HTTP 认证密码通过 Windows DPAPI 按当前用户加密后保存在 `%LOCALAPPDATA%\PiikRTC\credentials.json`，其他 Windows 账户无法解密。
- 共享来源由用户在原生选择器中明确选择；关闭选择器会清空待共享来源。
- 音频组件只读取系统/进程音频，不采集麦克风或摄像头。
- 程序未签名，首次运行可能出现 SmartScreen 提示。
