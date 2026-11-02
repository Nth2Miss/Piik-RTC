# 火山原生 SDK 测试分支

接入 Windows x64 火山 RTC `3.60.107.2100`。当前已完成本地编译、DLL 加载及适配层回归；尚未完成真实 Windows 与 Pad 的跨设备推拉流验收，不能据此认定首次低帧率已解决。

## 本地运行

需要 Windows、.NET 9 SDK 和 Visual Studio 2022 C++ x64 Build Tools。

```powershell
npm ci
npm run desktop:native:build
npm run desktop:dev
```

需要可复制的完整测试包时运行 `npm run desktop:build:native`，生成 `release/Piik-RTC-native-v<版本>.zip`，包含 exe 和原生组件目录。此命令只生成本地文件，不触发线上发布。

`desktop:native:build` 从官方地址下载 SDK，校验固定 SHA-256 后编译 C ABI 桥接。第三方 SDK 和编译产物缓存在忽略目录中，不进入 Git。原生运行库复制到桌面构建目录和 `release/native-volc/`。

桌面端检测到 `native-volc/PiikVolc.dll` 时，`volc` 和 `volc2` 使用原生 RTC；没有该目录的桌面端及浏览器继续使用 Web SDK。声网、即构保持原实现。两个火山应用继续使用各自服务端返回的 AppID/Token 和独立额度，AppKey 保留在服务端。

必须同时使用本分支网页资源；仅更新 exe、仍连接旧版网页，无法启用原生适配层。开发命令打开 `http://localhost:3000`，Pad 需连接同一服务的可访问地址。

诊断报告的 `app.sdk` 为 `volc-native 3.60.107.2100`，表示实际选择了原生适配层；普通用户的连接详情保持简洁。屏幕视频直接进入 SDK 原生采集、编码和发布，不经 Canvas 或 Web SDK 视频轨。其他供应商仍使用既有采集实现。

## 验收

1. 完全退出桌面端后冷启动，进入火山房间，Pad 网页提前进入同一房间。
2. 选择持续运动的视频/游戏窗口，1080p60、自动码率（16Mbps），先选择仅画面或程序声音，观察首次出画及稳定帧率。
3. 检查停止再共享、切换来源、退出释放；分别验证 `volc`、`volc2`。
4. 导出两端诊断，确认原生标识、实际发送帧率，以及 Pad 是否仍需重进房恢复。单元测试不能代替真实推拉流验收。

## 当前边界

- 原生视频默认使用桌面端 WGC 采集（`WgcCapture`，BGRA），通过 `pushExternalVideoFrame` 送入火山 SDK 编码和发布，屏幕与窗口走同一条采集链路；WGC 不可用或启动失败时自动回退到 SDK 内部采集。设置环境变量 `PIIK_NATIVE_INTERNAL=1` 可强制回退到 SDK 内部采集，用于对比和回滚。WGC 路径不经过 SDK 的窗口采集器，因此不会把源窗口置顶。
- 回退到 SDK 内部采集时，窗口采集器仍可能置顶源窗口；桌面端会恢复原来的前台窗口和层级，并对 SDK 的 USER32 导入表做限定范围的 IAT 修补：启动窗口采集后的 3 秒内，只对当前共享源窗口拦截 `BringWindowToTop`/`ShowWindow`/`SetWindowPos` 的置顶/恢复调用。该 hook 依赖 SDK 版本，升级 SDK 后需重新回归。
- 本地预览和远端画面都通过 SDK 的 I420 视频帧回调，经 WebView2 共享缓冲区交给网页用普通 HTML video 渲染；不再创建原生视频子窗口，因此共享控制条和连接详情等弹窗可以正常覆盖画面。WGC 外部视频的 CPU 占用、首帧时间和本地预览（外部帧进入本地 sink）尚未做真实设备验收。
- 最小化窗口仍不会进入来源列表：WGC 本身采不到真正最小化的窗口，后续若要像 Oopz 一样支持，需要再实现“屏幕外恢复/隐藏缩略图 host”这一层。
- 支持系统声音、按程序采集程序声音，以及共享系统声音时排除指定语音软件。过滤模式由桌面端 WASAPI 组件采集 PCM，再通过 `pushScreenAudioFrame` 送入原生 SDK；未开启过滤时仍使用 SDK 内部采集。
- 原生统计只报告 SDK 提供的数据，不推断硬件编码状态。网页兼容新版原生 SDK 的主流发布事件，同时保留屏幕流订阅。
- 原生组件按官方“按需集成”清单只分发 `VolcEngineRTC.dll`、`RTCFFmpeg.dll`、`openh264-4.dll`、`libEGL.dll`、`libGLESv2.dll`、`pthreadVC2.dll`，约59.5MiB；主程序约7.4MiB。`effect.dll`、`bdaudioeffect-mt.dll` 及 VP8/FDK AAC/NICO/FFmpeg 音频扩展不再复制。分发时 exe 与 `native-volc` 目录必须一起复制。现有自动更新仅处理 exe，原生组件升级须手动同步；尚未接入按需下载或正式发布工作流。
- 原生进房和视频发布等待 SDK 状态确认，失败或超时会释放资源，不使用 Web 首次低帧率重发逻辑。

参考：[获取 SDK](https://docs.volcengine.com/docs/real-time-communication/rtc-get-sdk?lang=zh)、[PC 屏幕共享](https://docs.volcengine.com/docs/real-time-communication/pc-screen-sharing?lang=zh)、[Windows 升级指南](https://docs.volcengine.com/docs/real-time-communication/windows-client-upgrade?lang=zh)。
