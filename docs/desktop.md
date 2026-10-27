# Piik-RTC 桌面端

桌面端是一个 **单文件、免安装** 的 Windows 程序（约 6.4 MB），不是网页套壳：

- 使用系统自带的 Microsoft Edge WebView2 加载现有 React 界面和声网、即构、火山引擎 RTC Web SDK。
- C# 主程序负责窗口枚举、缩略图、画面采集和 IPC，不引入 Electron/Chromium 运行时。
- 内置一个自包含的 .NET 9 音频组件，使用 Windows 进程回环采集声音；发行时压缩嵌入主程序，运行时释放。
- 自定义“程序 / 屏幕”选择器，支持只共享某个程序的声音，以及共享系统声音时过滤 Oopz / KOOK / Discord 等语音软件。

## 使用方式

1. 运行 `release/Piik.exe`。单文件，不需要安装。
2. 首次启动填写已部署的 Piik-RTC 服务器地址：
   - 生产环境必须使用 `https://`。
   - 本机调试可以使用 `http://localhost:3000`。
   - 如果构建时内嵌了服务端地址，首次启动会直接连接，不再显示这一步。
3. 地址保存在 `%LOCALAPPDATA%\PiikDesktop\config.json`；在窗口内右键打开菜单，选择“服务器设置…”可以修改，也支持启动参数 `--server=https://...` 或环境变量 `PIIK_SERVER_URL`。优先级：启动参数 > 环境变量 > 已保存配置 > 构建时内嵌地址。

桌面端加载服务器上的网页前端，所以服务端更新后界面也会更新；只有桌面壳或原生采集改动才需要重新发布客户端。

## 系统要求

- Windows 10 2004（build 19041）或更高版本，推荐 Windows 11。
- Microsoft Edge WebView2 运行时。Windows 11 和带 Edge 的 Windows 10 通常已经自带；缺失时程序会提示安装。
- 共享内存原始帧路径需要 WebView2 93 或更高版本；更旧的运行时会自动回退到 JPEG 采集。
- 程序声音和语音过滤依赖 Windows 进程回环 API；低于 19041 时只能共享系统声音。
- 网页版仍然可以使用浏览器自带选择器，不需要安装桌面端。

## 架构

```
Piik.exe（C# / .NET Framework 4.8 / WinForms / WebView2）
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

渲染端优先使用 Windows Graphics Capture 采集 GPU 画面：BGRA 帧通过 WebView2 共享内存传给前端，直接以 `VideoFrame` 画到隐藏 canvas，再通过 `canvas.captureStream()` 交给 RTC SDK，只编码一次，不再经过 JPEG。选择 1440P/原画或 WGC 不可用时，回退到 GDI+ + JPEG 桥接。音频 PCM 经过 AudioWorklet 和 `MediaStreamAudioDestinationNode`，同样交给 RTC SDK。即构房间的共享画面最高为 1080P、码率最高为 10 Mbps，选择 1440P/原画或 12/16 Mbps 时会自动按 1080P / 10 Mbps 采集。

## 原生采集

- **画面**：优先使用 Windows Graphics Capture 捕获窗口或显示器，GPU 帧按目标分辨率等比缩放（不放大）后以 BGRA 通过共享内存交给前端；WGC 不可用或选择 1440P/原画时回退到 `PrintWindow(PW_RENDERFULLCONTENT)` / `CopyFromScreen` + JPEG（质量约 72）。最小化的窗口不会出现在列表里；个别受保护或特殊渲染的窗口可能返回黑帧。
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
npm run desktop:dev      # 复用/启动本地服务，构建并运行 release/Piik.exe（带 9222 调试端口）
npm run desktop:build    # 发布音频组件、压缩嵌入、构建单文件 release/Piik.exe
npm run desktop:helper   # 只发布 desktop/bin/PiikAudio.exe，便于单独调试音频
```

构建时内嵌服务端地址：

```bash
npm run desktop:build -- --server=https://piik.example.com
# 或使用专门的命令
npm run desktop:build:embed -- --server=https://piik.example.com
```

内嵌地址会写入 exe，首次启动直接连接该服务器，不需要用户填写。用户仍可以在窗口内右键打开菜单，选择“服务器设置…”修改；`--server` 启动参数和 `PIIK_SERVER_URL` 环境变量也会覆盖它。`desktop:build:embed` 必须通过 `--server` 或 `PIIK_DEFAULT_SERVER_URL` 指定地址；构建脚本也接受环境变量 `PIIK_DEFAULT_SERVER_URL`，便于 CI 使用。

版本号取自 `package.json`，构建时写入桌面程序集，并显示在网页帮助页和桌面服务器设置页。发布前先提升版本（例如 `npm version patch --no-git-tag-version`），再推送匹配的 `v<version>` tag；`.github/workflows/desktop.yml` 会构建 exe、上传 artifact 并发布到 GitHub Release。

构建流程：

1. `dotnet publish` 把 `desktop/native/PiikAudio` 发布成裁剪、自包含的 12.8 MB 单文件。
2. 用 gzip 压缩到约 5.8 MB，写入 `desktop/PiikDesktop/Resources/PiikAudio.exe.gz`。
3. `dotnet build` 构建 C# 主机；Costura 把 WebView2 托管 DLL 嵌入 exe，音频组件作为资源嵌入。
4. 输出 `release/Piik.exe`，约 6.4 MB。

首次运行会把音频组件释放到 `%TEMP%\PiikDesktop\audio\PiikAudio.exe`；WebView2 用户数据在 `%LOCALAPPDATA%\PiikDesktop\WebView2`。

## 体积

| 项目 | 大小 |
| --- | --- |
| `release/Piik.exe`（单文件） | 约 6.4 MB |
| 其中压缩后的音频组件 | 约 5.8 MB |
| 主机 + WebView2 托管 DLL | 约 0.6 MB |
| WebView2 运行时 | 系统自带，不随程序分发 |

这比 Electron 方案的安装包（约 112 MB）小一个数量级。桌面端仍要通过 WebView2 和 canvas 中转画面，但 1080P/60fps 及以下使用 WGC 原始帧路径，不再经过 JPEG；1440P/原画会回退到 JPEG 桥接，CPU 占用更高。

## 限制与排障

| 现象 | 检查 |
| --- | --- |
| 提示无法启动 WebView2 | 安装 Microsoft Edge WebView2 运行时；Windows 11 通常已自带 |
| 列表里没有某窗口 | 最小化的窗口不会被列出，先恢复窗口再刷新 |
| 程序声音没有声音 | 确认 Windows 版本 ≥ 19041；该程序的声音可能不在窗口进程树内，改用共享屏幕 |
| 过滤后仍有回声 | 语音软件可能已重启；重新开始共享，并在选择器中确认选中的是当前语音软件 |
| 画面卡顿 | 1080P/60fps 及以下使用 WGC 路径；1440P/原画会回退 JPEG。若 60fps 仍卡，降到 30fps 或 720P |
| 某窗口画面全黑 | 该窗口可能禁止 WGC/PrintWindow 捕获；改为共享整个屏幕或使用浏览器 |
| 无法连接服务器 | 在设置页重新填写地址；生产环境使用 HTTPS，自签名证书不会被接受 |

## 安全边界

- WebView2 只允许导航到配置的服务器来源；外部链接交给系统浏览器打开。
- 原生 IPC 会校验消息来源；只有本地设置页可以修改服务器地址。
- 共享来源由用户在原生选择器中明确选择；关闭选择器会清空待共享来源。
- 音频组件只读取系统/进程音频，不采集麦克风或摄像头。
- 程序未签名，首次运行可能出现 SmartScreen 提示。
