# Piik-sw

和朋友一起看屏幕的小客厅。支持声网、即构和火山引擎 RTC，沿用 [Piik](https://github.com/TNTcraftHIM/Piik) 的客厅界面。

输入用户名即可创建或加入房间，无需注册或安装客户端。支持多人同时共享屏幕、窗口或标签页，点击成员切换观看。

## 功能

- 多人共享与音频播放，支持音量、画中画、画面适配和全屏。
- 按需连接 RTC，空闲时自动断开；空房间 15 分钟后自动关闭。
- 实时连接统计、问题排查和脱敏诊断报告。
- 亮暗主题、中英文切换、响应式布局。

## 快速开始

需要 **Node.js 24+**，以及至少一个已开通并启用 Token 鉴权的 RTC 项目。

```bash
npm install
cp .env.example .env
# 在 .env 中填写至少一家 RTC 服务商的凭据
npm run dev
```

打开 [localhost:3000](http://localhost:3000)。PowerShell 用 `Copy-Item .env.example .env` 复制配置。

屏幕共享需要 `localhost` 或 HTTPS。音频共享取决于浏览器、操作系统和所选来源；应用不采集摄像头或麦克风。

### 服务端目录

- `server/index.js`、`server/app.js`：启动和 HTTP API 入口。
- `server/rooms/`：房间存储、生命周期、用户名和实时消息。
- `server/quota/`：服务商状态缓存、本地用量累计和额度保护。
- `server/providers/agora/`、`volc/`、`zego/`：各服务商的 Token 和用量查询实现。
- `server/shared/`：供应商查询共用的时间和请求工具。
- `server/tests/`：服务端和相关媒体行为测试，使用 `npm test` 运行。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `AGORA_APP_ID`、`AGORA_APP_CERTIFICATE` | 声网项目 App ID 和证书；使用声网时填写 |
| `ZEGO_APP_ID`、`ZEGO_SERVER_SECRET` | 即构项目 AppID 和 ServerSecret；使用即构时填写 |
| `ZEGO_COOKIE_FILE` | 可选，即构控制台登录 Cookie 文件路径，仅后端读取并保存续期状态；建议放在 `data/` 下 |
| `VOLC_RTC_APP_ID`、`VOLC_RTC_APP_KEY` | 火山 RTC AppID 和 AppKey；使用火山时填写 |
| `AGORA_PROJECT_ID`、`AGORA_CUSTOMER_KEY`、`AGORA_CUSTOMER_SECRET` | 声网用量查询所需项目 ID 和 REST 凭据，仅后端使用 |
| `RTC_USAGE_CACHE_SECONDS` | 服务状态服务端缓存秒数，默认 300，范围 1–86400；修改后重启服务 |
| `VOLC_ACCESS_KEY_ID`、`VOLC_ACCESS_KEY_SECRET` | 火山费用中心资源包查询密钥，仅后端使用 |
| `PORT` | 服务端口，默认 `3000` |
| `PUBLIC_ORIGIN` | 对外 HTTPS 来源，如 `https://screen.example.com`，用于 Cookie 安全属性 |
| `SCREEN_PORT` | Docker Compose 宿主机端口，默认 `3000` |

不要提交 `.env`。证书不要加 `VITE_` 前缀。

创建房间时选择服务商，所有成员在该房间使用同一家服务商。服务端累计每个房间的估算用量，每分钟检查一次服务商余额，结果存于 SQLite；北京时间自然月切换后重新计量。声网、火山和即构结合供应商余量和本地估算，声网 HDP 汇总字段不重复计算；火山免费资源包的音视频通话按照 1:1 估算，即构按拉流档位抵扣，共享画面最高 1080P。未取得火山或即构供应商余量时按每月 10,000 分钟估算。估算余额低于 30 分钟时不允许新建，低于 15 分钟时关闭该服务商的所有房间并通知在线成员。监控连接中断时，客户端会停止媒体连接。供应商数据在服务端缓存，刷新页面不会跳过缓存；服务状态对网站访问者可见，凭据只保存在服务端。

即构额度查询使用控制台登录 Cookie 和控制台接口，而非官方公开 OpenAPI，可能随登录状态或接口变更失效。将控制台请求中的 Cookie 单行写入 `ZEGO_COOKIE_FILE` 指向的文件，文件只能由运行服务的用户读取；该文件会随续期更新，不能提交或公开。登录失效时重新获取 Cookie 并替换文件。Docker 部署时，文件必须位于容器可读写的持久化 `data/` 目录中，`.env` 里的路径是容器内路径。多实例不能各自维护同一登录会话，应使用统一的安全会话存储。

估算依赖客户端上报的连接、订阅和分辨率，无法覆盖其他应用、监控上线前的火山和即构用量、网络延迟或客户端无法响应等情况。供应商账单和实际剩余额度可能不同；每分钟检查和既有 Token 也不能保证绝不超额，需结合供应商侧额度或停服机制控制费用。

## 部署

### Node.js

```bash
npm run build
npm start
```

### Docker Compose

配置好 `.env` 后执行：

```bash
docker compose up -d
```

Compose 会拉取 `ghcr.io/nth2miss/piik-sw:latest` 预构建镜像，默认端口为 `3000`，可用 `SCREEN_PORT` 修改。`pull_policy: always` 表示每次 `up` 都会检查并拉取最新 `latest`；需要固定版本时，把 `image` 改成 `v1.2.3` 这类标签。

私有 GHCR 包需先执行 `docker login ghcr.io`。

### 预构建镜像

GitHub Actions 在推送到默认分支或创建 `v*` 标签时发布镜像，PR 仅构建。

```bash
docker pull ghcr.io/nth2miss/piik-sw:latest
docker run -d --name piik-sw --restart unless-stopped \
  -p 3000:3000 --env-file /opt/piik-sw/.env \
  -v piik-sw-data:/app/data ghcr.io/nth2miss/piik-sw:latest
```

私有镜像需先 `docker login ghcr.io`。更新时拉取镜像并重建容器，保留数据卷。服务器配置文件单独上传，并执行 `chmod 600 /opt/piik-sw/.env`。

无法访问 GHCR 时，可本地构建后用 `docker save` / `docker load` 传输镜像；构建架构须与服务器一致。

### HTTPS 与 WebSocket

对外部署需配置 HTTPS 反向代理，并设置 `PUBLIC_ORIGIN`。除普通请求外，代理还需转发 `/ws` 的 Upgrade：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

## 使用须知

- 大厅和房间公开，用户名仅用于显示，邀请链接仅用于定位房间。成员与创建者权限绑定 Cookie，清理 Cookie 会改变身份。
- RTC Token 有效 2 分钟并自动续期；关闭房间后，已签发的 Token 仍可能有效至到期，实际断流取决于供应商。服务重启后需重新进入房间。
- 每个浏览器最多创建 50 个开放房间，接口有请求限流。
- SQLite 数据位于 `data/`，备份时保留整个目录；上述镜像部署使用 `piik-sw-data` 卷。

## 开发

前端：React 19、TypeScript、Vite 7。后端：Node.js 24、Express 5、内置 SQLite、WebSocket。

| 路径 | 内容 |
| --- | --- |
| `src/` | 页面、播放器、房间与媒体状态管理 |
| `src/vendor/piik/` | 原样保留的 Piik 组件与资源 |
| `server/` | API、Token 签发、实时同步与房间存储 |
| `scripts/vendor-piik.mjs` | 从上游重新导入 Piik |

运行 `npm test` 验证房间、权限、媒体状态和实时同步逻辑。真实多端共享需在桌面 Chrome / Edge 上验证。

## 第三方与许可

Piik 界面按 MIT 许可保留，来源与校验信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `src/vendor/piik/upstream.json`。声网 SDK 采用 MIT 许可，服务使用另受其条款与计费规则约束。

本仓库尚无统一 `LICENSE`；Piik 衍生部分仍遵循 MIT 许可。
