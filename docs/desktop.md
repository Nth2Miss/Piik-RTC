# Piik-RTC 桌面端

桌面端是一个 **单文件、免安装** 的 Windows 程序（约 7.4 MB），使用系统自带的 Microsoft Edge WebView2 加载服务器上的 React 界面和 RTC Web SDK。C# 主程序负责窗口枚举、缩略图、画面采集、音频与 IPC，不引入 Electron/Chromium 运行时。

火山房间可选装原生 RTC 组件（约 22 MB），默认不随主程序分发，详见[原生测试说明](native-rtc.md)。

## 使用方式

1. 运行 `release/Piik-RTC-v<版本>.exe`。单文件，不需要安装。
2. 首次启动填写已部署的 Piik-RTC 服务器地址：
   - 生产环境必须使用 `https://`，本机调试可以使用 `http://localhost:3000`。
   - 如果服务器通过 Nginx 等反向代理启用了 HTTP 认证（如 `auth_basic`），连接后会在应用窗口内显示登录页。勾选“记住密码”后会用当前 Windows 账户加密保存；服务器地址里不用写 `user:pass@`。
   - 如果构建时内嵌了服务端地址，启动时会直接连接并锁定该地址：不读取本地配置，忽略 `--server` 启动参数和 `PIIK_SERVER_URL` 环境变量，右键菜单只显示服务器信息。内嵌地址会写入 `%LOCALAPPDATA%\PiikRTC\server.lock`；自动更新替换为未内嵌地址的正式版后，新 exe 仍会读取该文件并继续锁定该地址。
3. 未锁定服务器时，地址保存在 `%LOCALAPPDATA%\PiikRTC\config.json`；右键菜单“服务器设置…”可以修改，也支持 `--server=https://...` 或环境变量 `PIIK_SERVER_URL`。优先级：启动参数 > 环境变量 > 已保存配置。
4. 旧版本使用的 `%LOCALAPPDATA%\PiikDesktop` 不会自动迁移。
5. 桌面端加载服务器上的网页前端，服务端更新后界面会同步更新。房间会记录创建时的客户端版本；低版本客户端进入新版本创建的房间时会被拒绝并提示更新。

## 自动更新

页面启动后通过桌面桥接读取 GitHub Releases 的 `version.json`，与当前程序集版本比较；发现新版本时在应用内弹窗提示，并可直接下载安装。

- 桌面端提供 `checkUpdate` / `installUpdate` 桥接操作，通过 `update-progress`、`update-error` 事件回传进度和错误，弹窗样式与网页前端一致。
- 版本信息优先通过 `v4.gh-proxy.org` 获取，失败后回退 GitHub 直连；下载会探测多个镜像并分段加速，全部不可用时回退 `github.com`。
- 更新文件必须能从 GitHub 官方 API 取得 SHA-256 摘要并校验通过，否则不会安装。官方 API 不可用时需要到 GitHub Releases 手动下载。
- 更新文件下载到当前 exe 所在目录，程序需要放在有写权限的位置。
- 右键菜单“检查更新…”会把请求交给页面显示结果；设置环境变量 `PIIK_DISABLE_UPDATE=1` 可以跳过启动检查。
- 更新下载完成后直接启动新 exe（带上旧进程号和旧文件路径），新 exe 会等待旧进程退出、接管单实例锁并删除旧文件；只有直接启动失败时才回退到 PowerShell 辅助进程。旧快捷方式可能需要重新指向新文件。
- 火山原生组件不随 exe 自动更新；进入 `volc`/`volc2` 房间前会按需提示安装。

## 系统要求

- Windows 10 2004（build 19041）或更高版本，推荐 Windows 11。
- Microsoft Edge WebView2 运行时。Windows 11 和带 Edge 的 Windows 10 通常已经自带；缺失时程序会提示安装。
- 共享内存原始帧路径需要 WebView2 93 或更高版本；更旧的运行时会自动回退到 JPEG 采集。
- 程序声音和语音过滤依赖 Windows 进程回环 API；低于 19041 时只能共享系统声音。
- 网页版可以使用浏览器自带选择器，不需要安装桌面端。

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

渲染端优先使用 Windows Graphics Capture 采集，GPU 等比缩放到目标分辨率后经共享内存交给前端；两个火山应用使用隐藏 canvas + `captureStream()`，其他服务商优先使用 `MediaStreamTrackGenerator`，不支持时回退 canvas。WGC 不可用或选择 1440P/原画时回退到 GDI+ + JPEG。即构房间最高 1080P / 10 Mbps，其他服务商最高 16 Mbps。音频 PCM 经 AudioWorklet 和 `MediaStreamAudioDestinationNode` 交给 RTC SDK。

## 采集与音频

- **画面**：1080P/60fps 及以下使用 WGC 原始帧路径，不经过 JPEG；1440P/原画会回退到 JPEG，CPU 占用更高。主窗口最小化时移到屏幕外并保留托盘图标，避免 WebView2 被节流；其他最小化的窗口不会出现在共享列表中。
- **音频**：WASAPI shared-mode 回环。系统模式请求 48 kHz / 16-bit / stereo，失败时回退 44.1 kHz；程序模式使用 Windows 进程回环的 include/exclude 进程树。
- **语音过滤**：一次排除一个进程树，默认选择检测到的 Oopz / KOOK 等语音软件；语音软件重启后需要停止并重新开始共享。
- **退出**：关闭窗口会先触发页面的 `pagehide`，发送离房请求并让 RTC 离开；强制结束进程或系统关机时，成员会在服务端心跳超时后消失。

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

内嵌地址会写入 exe 并在每次启动时强制生效：锁定启动时以 exe 内嵌地址为准，忽略 `config.json` 中已有的 `serverUrl`、`--server` 启动参数和 `PIIK_SERVER_URL` 环境变量，右键菜单只显示服务器信息，设置页也无法修改。同时会把地址写入 `%LOCALAPPDATA%\PiikRTC\server.lock`，因此自动更新替换为未内嵌地址的正式版后，新 exe 仍会读取该文件并继续锁定同一服务器。适合分发只连接自己服务器的客户端。`desktop:build:embed` 必须通过 `--server` 或 `PIIK_DEFAULT_SERVER_URL` 指定地址。

版本号取自 `package.json`，构建时写入桌面程序集，并显示在网页帮助页和桌面服务器设置页。发布前先提升版本（例如 `npm version patch --no-git-tag-version`）。桌面端由手动触发的 `.github/workflows/desktop.yml` 构建：运行 `Desktop` workflow，输入必须与 `package.json` 版本一致，随后构建 `Piik-RTC-v<版本>.exe` 和 `version.json`、上传 artifact，并创建/更新 GitHub Release。

构建流程：

1. `dotnet publish` 把 `desktop/native/PiikAudio` 发布成裁剪、自包含的 12.8 MB 单文件。
2. 用 gzip 压缩到约 5.8 MB，写入 `desktop/PiikRTC/Resources/PiikAudio.exe.gz`。
3. `dotnet build` 构建 C# 主机；Costura 把 WebView2 托管 DLL 嵌入 exe，音频组件作为资源嵌入。
4. 输出 `release/Piik-RTC-v<版本>.exe`（约 7.4 MB）和 `release/version.json`。

发布工作流会额外生成 `release/native-volc-v<版本>.zip`（约 22 MB），并把版本、大小和 SHA-256 写入 `version.json` 的 `native` 段；桌面端进入火山房间前按需下载。

首次运行会把音频组件释放到 `%TEMP%\PiikRTC\audio\PiikAudio.exe`；WebView2 用户数据在 `%LOCALAPPDATA%\PiikRTC\WebView2`。

## 体积

| 项目 | 大小 |
| --- | --- |
| `release/Piik-RTC-v<版本>.exe`（单文件） | 约 7.4 MB |
| 火山原生组件 `native-volc-v<版本>.zip`（按需下载） | 约 22 MB |
| 其中压缩后的音频组件 | 约 5.8 MB |
| 主机 + WebView2 托管 DLL | 约 0.6 MB |
| WebView2 运行时 | 系统自带，不随程序分发 |

1080P/60fps 及以下使用 WGC 原始帧路径，不经过 JPEG；1440P/原画会回退到 JPEG 桥接，CPU 占用更高。

## 限制与排障

帮助菜单中的“诊断”可以导出脱敏报告，包含环境、房间、媒体统计和最近错误；报告不包含访问令牌。

| 现象 | 检查 |
| --- | --- |
| 提示无法启动 WebView2 | 安装 Microsoft Edge WebView2 运行时；Windows 11 通常已自带 |
| 列表里没有某窗口 | 最小化的窗口不会被列出，先恢复窗口再刷新 |
| 程序声音没有声音 | 确认 Windows 版本 ≥ 19041；该程序的声音可能不在窗口进程树内，改用共享屏幕 |
| 过滤后仍有回声 | 语音软件可能已重启；重新开始共享，并在选择器中确认选中的是当前语音软件 |
| 画面卡顿 | 1080P/60fps 及以下使用 WGC 路径；1440P/原画会回退 JPEG。若 60fps 仍卡，降到 30fps 或 720P |
| 关闭客户端后仍显示在房间 | 正常关闭会先发送离房请求；强制结束进程或系统关机时会等到服务端心跳超时 |
| 某窗口画面全黑 | 该窗口可能禁止 WGC/PrintWindow 捕获；改为共享整个屏幕或使用浏览器 |
| 连接时显示登录页或提示 401 | 反向代理启用了 HTTP 认证，在登录页输入代理配置的用户名和密码；取消后可重新连接 |
| 想清除保存的登录密码 | 在窗口内右键选择“清除保存的登录信息…”，重启程序后生效；也可以在登录页取消勾选“记住密码”后重新登录 |
| 无法连接服务器 | 未内嵌地址时在设置页重新填写；内嵌地址的客户端只能检查网络或联系发布者。生产环境使用 HTTPS，自签名证书不会被接受 |

## 安全边界

- WebView2 只允许导航到配置的服务器来源；外部链接交给系统浏览器打开。
- 原生 IPC 会校验消息来源；只有未锁定服务器时，本地设置页才能修改服务器地址。
- `server.lock` 用于分发策略，不是防篡改机制；能访问本机文件的用户仍可删除或修改它来解除锁定。
- 反向代理的 HTTP 认证密码通过 Windows DPAPI 按当前用户加密后保存在 `%LOCALAPPDATA%\PiikRTC\credentials.json`，其他 Windows 账户无法解密。
- 共享来源由用户在原生选择器中明确选择；关闭选择器会清空待共享来源。
- 音频组件只读取系统/进程音频，不采集麦克风或摄像头。
- 程序未签名，首次运行可能出现 SmartScreen 提示。
