# 同屏 Screen Room

基于声网 RTC Web SDK 的屏幕共享服务。Node.js + Express 后端签发 AccessToken2，React + TypeScript + Vite 前端直接复用 Piik 的生产组件与样式。

使用流程为“输入用户名 → 房间大厅 → 进入 / 创建房间”。房间页使用 Piik 原版电视舞台、沙发成员区、控制台、状态插画及设置面板，点击沙发成员或成员列表切换画面。媒体传输由声网 RTC 提供。

Piik 源码保存在 `src/vendor/piik/`，原文件未修改，版本及 SHA-256 校验值见 `upstream.json`。`src/app.tsx` 是 React 页面适配层，`src/room-service.ts` 将房间 API、在线成员、声网发布/订阅状态提供给组件；`src/style.css` 仅包含房间大厅等业务扩展及视口适配。上游许可见 `THIRD_PARTY_NOTICES.md`。

## 本地启动

需要 Node.js 24+（使用内置 SQLite，无需另外安装数据库）。

```powershell
npm install
Copy-Item .env.example .env
# 编辑 .env 填写以下两项
npm run dev
```

浏览器打开 http://localhost:3000。

## 声网凭据

登录 [声网控制台](https://console.shengwang.cn/)，在项目管理中创建或选择 **RTC 项目**，启用 App Certificate / Token 鉴权。将同一项目中的以下值写入 `.env`：

```dotenv
AGORA_APP_ID=你的32位AppID
AGORA_APP_CERTIFICATE=你的32位项目证书
PORT=3000
PUBLIC_ORIGIN=
```

不需要 Customer ID、Customer Secret、REST API 密钥，也不需要手工生成临时 Token。App Certificate 仅供后端使用，切勿添加 `VITE_` 前缀或提交至代码仓库。修改配置后需要重启服务。

## 使用方法

1. 打开网站后先输入用户名。可记住上次输入，但每次打开页面都需要确认进入；没有注册、密码或账号登录。
2. 大厅列出全站所有开放房间。点击房间加入，或创建带名称和描述的新房间。不是按浏览器收藏的个人列表。
3. 进入房间即出现在 Piik 沙发成员区，但不会立即连接声网：房间里没有共享时保持离线，不产生 RTC 用量。有人开始共享、点击成员观看或自己点击“开始共享”时才会连接媒体。
4. 媒体连接后，所有成员都可以同时共享。点击成员会按需连接并切换到其画面和声音，切换观看不会停止自己的共享。
5. 点击“停止分享”只结束自己的采集；点击“离开房间”或顶部返回按钮退出房间。最后一人离开后，连续空置 15 分钟自动关闭；倒计时内重新加入会取消关闭。

### 共享与观看设置

- 场景预设：Piik 的轻量、高清、高帧率，使用声网可配置的分辨率、帧率及码率。
- 自定义编码目标：480p / 720p / 1080p / 1440p，15 / 24 / 30 / 60 fps，1–8 Mbps 最大码率，清晰 / 流畅 / 均衡优化策略。
- 点击“开始共享”后，在浏览器选择器中选择应用窗口、浏览器标签页或整个屏幕。声音设置保留共享所选来源音频、是否允许选择本站标签页。
- 观看选项：音量、静音、完整显示或裁剪填满，即时生效。只播放当前选中成员的声音，不播放自己的共享声音以避免回声。
- 设置保存在当前浏览器。共享编码与采集参数在下次开始共享时生效；分辨率、帧率和码率是目标值，实际效果受共享来源、设备和网络限制。

### 共享音频

调用原生 `getDisplayMedia`，开启音频时传入 `windowAudio: "window"` 和 `systemAudio: "include"`，再用声网 `createCustomVideoTrack` / `createCustomAudioTrack` 发送所选轨道。标签页发送标签页声音，窗口发送窗口声音，整个屏幕发送系统声音（包含其他应用的声音）。关闭音频开关时不发送任何采集音轨。

窗口音频仍需在浏览器选择器中勾选音频，并依赖浏览器与操作系统支持。项目保守地仅对已知 Chromium 141+ 接受窗口音轨，旧版或未知引擎的窗口音轨会停止，避免忽略提示后意外传出整机声音；这些浏览器可改选标签页音频。浏览器没有返回音轨时，会明确提示本次仅分享画面。

共享来源统一在浏览器选择器中确定，无需在设置中预选。需在选择器中勾选共享音频；系统音频同样取决于浏览器与操作系统支持。无法识别来源的音轨会丢弃；窗口音频不会回退为系统音频。

不采集摄像头或麦克风。播放共享音频可能需要观看者点击页面以满足浏览器自动播放限制。

## 构建与部署

### Node.js 服务器

```powershell
npm test
npm run build
npm start
```

前后端使用同一端口。生产环境在 Node.js 服务前配置 HTTPS 反向代理，并把 `PUBLIC_ORIGIN` 设置为对外完整来源，例如 `https://screen.example.com`（无尾部斜杠）。HTTPS 代理应转发原始 Host；不需要开放跨域 API。不要公开 Vite 开发服务器。

屏幕采集要求安全上下文：本机 localhost 或 HTTPS。其他设备不能通过自己的 localhost 访问本机服务，远程测试须使用部署后的 HTTPS 域名。

房间和空置时间保存在 `data/rooms.sqlite`。服务端每 5 秒检查一次空房间，接口请求也会执行检查，所以无人打开网页时仍会自动关闭。刚创建但无人加入的房间从创建时开始计时；正常退出立即开始计时，异常断线约 45 秒判定离开后开始计时。重新加入取消计时。服务重启时根据已保存的最后活动时间恢复空置计时，已到期房间会关闭。

用户名仅用于显示，不是身份认证。Cookie 用于绑定成员会话和记录房间创建者，以限制编辑与手动关闭权限；更换或清理 Cookie 会改变创建者身份。所有输入过用户名的人都可以从公开大厅进入房间；邀请链接仅用于快速找到房间。

房间使用 RTC 模式，每位成员都持 Publisher Token。在线状态在页面可见时约每 30 秒同步一次，页面隐藏时暂停，共享开始/停止等状态变化会立即上报。Token 最长 1 小时并自动续期。声网媒体按需连接：无人共享且自己未共享时不会加入频道，共享结束或无人观看 1 分钟后自动断开，因此空房间和仅浏览房间不产生 RTC 用量。服务重启后需要重新进入房间。关闭后的房间不再签发 Token，页面在后续心跳中退出；此前已签发 Token 在到期前无法从本地立即撤销。每个浏览器最多创建 50 个开放房间，并有请求与会话限流。

数据库文件被 Git 忽略，备份时应包含整个 `data/` 目录。升级时自动添加空置计时字段；旧房间会按保存的活动时间应用新的 15 分钟关闭规则。

### Docker

仓库根目录的 `Dockerfile` 使用多阶段构建：第一阶段安装全部依赖并执行 `npm run build`，第二阶段只保留生产依赖、`dist/` 和 `server/`，以非 root 的 `node` 用户运行 `node server/index.js --production`。`docker-compose.yml` 负责端口、环境变量和数据卷。

1. 准备 `.env`（至少填写声网凭据；对外部署时填写 `PUBLIC_ORIGIN`）：

```powershell
Copy-Item .env.example .env
```

2. 构建并启动：

```powershell
docker compose up -d --build
```

宿主机默认映射 3000 端口，访问 http://localhost:3000。需要更换宿主机端口时设置 `SCREEN_PORT`，例如在 `.env` 中加入 `SCREEN_PORT=8080`；容器内始终监听 3000。对外部署仍应在前方配置 HTTPS 反向代理并转发原始 Host，同时把 `PUBLIC_ORIGIN` 设为完整的 HTTPS 域名。

3. 查看状态与日志：

```powershell
docker compose ps
docker compose logs -f screen
```

更新代码后重新构建：

```powershell
git pull
docker compose up -d --build
```

房间数据保存在具名卷 `screen-room-data`（挂载到容器内 `/app/data`）。备份：

```powershell
docker run --rm -v screen-room-data:/data -v "${PWD}:/backup" alpine tar czf /backup/screen-data.tar.gz -C /data .
```

恢复会覆盖卷内现有数据，请先停止服务：

```powershell
docker compose stop screen
docker run --rm -v screen-room-data:/data -v "${PWD}:/backup" alpine sh -c "rm -rf /data/* && tar xzf /backup/screen-data.tar.gz -C /data"
docker compose start screen
```

如果希望直接使用宿主机目录（例如沿用已有的 `data/`），把 `docker-compose.yml` 中的 `screen-data:/app/data` 改成 `./data:/app/data`。Linux 上该目录必须对容器内 uid 1000 可写：

```powershell
mkdir -p data
sudo chown -R 1000:1000 data
```

容器健康检查请求 `/api/config`，`docker compose ps` 中状态显示 `healthy` 即服务与接口正常。

## 验证范围

`npm test` 覆盖用户名门槛、公共大厅、成员与创建者权限、多人发流、15 分钟关闭边界、最后成员退出和重新加入取消关闭，以及原生窗口音频选项、音轨过滤、资源释放与快速切换竞态。时间边界使用模拟时钟验证，不需要等待 15 分钟。真实窗口音频和多端媒体链路仍需在支持的桌面 Chrome / Edge 及操作系统中验证；应用内预览浏览器可能无法完整支持 WebRTC / 屏幕采集。

参考：[声网 Web 屏幕共享文档](https://docportal.shengwang.cn/cn/video-legacy/screensharing_web_ng)。

窗口音频参考：[Chrome 141 发版说明](https://developer.chrome.com/release-notes/141)、[getDisplayMedia 选项](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)。
