# Piik-sw

和朋友一起看屏幕的小客厅。基于声网 RTC Web SDK，沿用 [Piik](https://github.com/TNTcraftHIM/Piik) 的客厅界面。

输入用户名即可创建或加入房间，无需注册或安装客户端。支持多人同时共享屏幕、窗口或标签页，点击成员切换观看。

## 功能

- 多人共享与音频播放，支持音量、画中画、画面适配和全屏。
- 按需连接 RTC，空闲时自动断开；空房间 15 分钟后自动关闭。
- 实时连接统计、问题排查和脱敏诊断报告。
- 亮暗主题、中英文切换、响应式布局。

## 快速开始

需要 **Node.js 24+** 和启用 Token 鉴权的声网 RTC 项目。

```bash
npm install
cp .env.example .env
# 填写 .env 中的 AGORA_APP_ID 和 AGORA_APP_CERTIFICATE
npm run dev
```

打开 [localhost:3000](http://localhost:3000)。PowerShell 用 `Copy-Item .env.example .env` 复制配置。

屏幕共享需要 `localhost` 或 HTTPS。音频共享取决于浏览器、操作系统和所选来源；应用不采集摄像头或麦克风。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `AGORA_APP_ID` | 必填，声网项目 App ID |
| `AGORA_APP_CERTIFICATE` | 必填，声网项目证书，仅后端使用 |
| `PORT` | 服务端口，默认 `3000` |
| `PUBLIC_ORIGIN` | 对外 HTTPS 来源，如 `https://screen.example.com`，用于 Cookie 安全属性 |
| `SCREEN_PORT` | Docker Compose 宿主机端口，默认 `3000` |
| `VITE_AGORA_BADGE_URL` | 可选用量徽章地址，构建时写入前端；留空隐藏 |

不要提交 `.env`。证书不要加 `VITE_` 前缀；徽章地址必须可以公开。

## 部署

### Node.js

```bash
npm run build
npm start
```

### Docker Compose

配置好 `.env` 后执行：

```bash
docker compose up -d --build
```

默认端口为 `3000`，可用 `SCREEN_PORT` 修改。徽章地址从 `.env` 读取，修改后需重新构建。

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
- Token 最长有效 1 小时并自动续期；关闭房间后，已签发的 Token 仍可能有效至到期。服务重启后需重新进入房间。
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
