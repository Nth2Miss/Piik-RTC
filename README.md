# Piik-sw

Piik-sw 是一个和朋友一起看屏幕的小客厅。基于声网 RTC Web SDK 的多人屏幕共享服务，前端复用 [Piik](https://github.com/TNTcraftHIM/Piik) 的客厅界面与设计系统。

输入用户名即可创建或加入房间。房间里每个人都能同时共享屏幕，点击沙发上的成员即可切换观看。没有注册、密码或客户端安装。

## 功能

- **多人同时共享**：每位成员都可以独立发布屏幕、窗口或标签页，切换观看不会中断自己的共享。
- **按需连接声网**：房间无人共享且自己未共享时不会加入频道，不产生 RTC 用量；共享结束或无人观看 1 分钟后自动断开。
- **播放器控制**：暂停/播放、静音、音量、切换来源、播放设置、画中画、完整显示 / 等比铺满 / 拉伸铺满、全屏。
- **连接详情**：实时查看本机采集分辨率、帧率、视频编码、码率和来源声音，以及当前观看对象的接收统计、RTT、上行带宽和网络质量。
- **问题排查与诊断**：内置常见问题清单，一键导出脱敏的 JSON 诊断报告。
- **房间生命周期**：最后一人离开后空置 15 分钟自动关闭；WebSocket 实时同步成员和共享状态，不可用时回退到 HTTP 心跳。
- **Piik 界面**：电视舞台、沙发成员区、亮暗主题、中英文切换和响应式布局。
- **Docker 部署**：多阶段构建，非 root 运行，SQLite 数据持久化。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite 7 |
| 后端 | Node.js 24、Express 5、`node:sqlite`、`ws` |
| 实时媒体 | 声网 RTC Web SDK 4.x（VP8、AccessToken2） |
| 界面 | Piik（原样 vendored，MIT） |

## 快速开始

### 前置条件

- Node.js 24+（使用内置 SQLite，无需另外安装数据库）
- 一个启用 Token 鉴权的声网 RTC 项目，获取 App ID 和 App Certificate

### 本地运行

```bash
npm install
cp .env.example .env
# 编辑 .env，填写 AGORA_APP_ID 和 AGORA_APP_CERTIFICATE
npm run dev
```

Windows PowerShell 使用 `Copy-Item .env.example .env`。打开 <http://localhost:3000>。

屏幕采集需要安全上下文：`localhost` 或 HTTPS。远程访问其他设备时请部署到 HTTPS。

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AGORA_APP_ID` | 是 | 声网 RTC 项目 App ID |
| `AGORA_APP_CERTIFICATE` | 是 | 声网 RTC 项目 App Certificate，仅后端使用 |
| `PORT` | 否 | 服务监听端口，默认 `3000` |
| `PUBLIC_ORIGIN` | 否 | 对外完整 HTTPS 来源，例如 `https://screen.example.com`，用于 Cookie 安全属性 |
| `SCREEN_PORT` | 否 | Docker Compose 映射到宿主机的端口，默认 `3000` |
| `VITE_AGORA_BADGE_URL` | 否 | 帮助面板中的 RTC 用量徽章 URL；会进入前端产物，留空则不显示 |

> 不要提交 `.env`。App Certificate 不需要 `VITE_` 前缀，也不会进入前端产物；`VITE_AGORA_BADGE_URL` 会进入前端产物，只应填写可公开的徽章地址。

## 使用流程

1. 首次打开输入用户名，之后自动记住；同一房间内用户名不能重复。
2. 在大厅创建房间或加入已有房间。
3. 点击“开始共享”选择屏幕、窗口或标签页；其他成员点击沙发或成员列表切换观看。
4. 画面底部控制条可暂停、调音量、切换来源、切换适配和全屏；点击“连接详情”查看实时媒体统计。
5. 点击“停止分享”只结束自己的共享；离开房间后，最后一人离开满 15 分钟房间自动关闭。

### 共享音频

共享屏幕时可在浏览器选择器中勾选音频。标签页发送标签页声音，窗口发送窗口声音，整个屏幕发送系统音频。窗口音频依赖较新的 Chromium 和操作系统支持，未返回音轨时会明确提示本次仅共享画面。应用不采集摄像头或麦克风。

## 部署

### Node.js

```bash
npm test
npm run build
npm start
```

生产环境请在 Node 服务前配置 HTTPS 反向代理，并把 `PUBLIC_ORIGIN` 设置为完整 HTTPS 来源。WebSocket 路径 `/ws` 需要转发 Upgrade：

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

### Docker Compose

```bash
cp .env.example .env
# 填写声网凭据；需要更换宿主机端口时在 .env 中添加 SCREEN_PORT=8080
docker compose up -d --build
```

默认映射 `3000` 端口。房间数据保存在具名卷 `piik-sw-data`，重建容器不会丢失。健康检查请求 `/api/config`，`docker compose ps` 显示 `healthy` 即服务正常。

`VITE_AGORA_BADGE_URL` 在构建阶段注入前端：使用 Compose 时会从 `.env` 读取；直接执行 `docker build` 时通过 `--build-arg VITE_AGORA_BADGE_URL=...` 传入，未传则帮助面板不显示徽章。

仓库内置 `.github/workflows/docker.yml`：推送到默认分支、创建 `v*` 标签或手动触发时，会构建镜像并推送到 GitHub Container Registry（`ghcr.io/<owner>/piik-sw`）。Pull Request 只构建不推送。若在仓库 Settings → Variables 中配置了 `VITE_AGORA_BADGE_URL`，构建时会注入前端。

## 项目结构

```text
src/
  app.tsx               React 页面、房间大厅与播放器控制
  room-service.ts       房间 API、成员状态、声网发布/订阅与诊断采集
  source-controller.ts  选中来源的订阅与切换
  vendor/piik/          原样保留的 Piik 组件、样式与资源
server/
  app.js                Express API、Token 签发、房间接口
  realtime.js           WebSocket 成员与共享状态推送
  room-store.js         SQLite 存储与查询
  room-lifecycle.js     空置倒计时与清理
public/                 网站图标
scripts/vendor-piik.mjs 从上游重新导入 Piik
data/                   运行时 SQLite（Git 忽略）
```

## 设计与限制

- 用户名仅用于显示，不是身份认证。Cookie 绑定成员会话和房间创建者，用于限制编辑与关闭权限；更换或清理 Cookie 会改变创建者身份。
- 所有输入过用户名的人都可以从公开大厅进入房间；邀请链接只用于快速定位房间。
- 每位成员使用 Publisher Token，最长 1 小时并自动续期。服务重启后需要重新进入房间。
- 房间无人共享且自己未共享时不会加入声网频道，因此浏览房间不产生 RTC 用量。
- 已关闭房间不再签发 Token，但此前签发的 Token 在到期前无法从客户端立即撤销。
- 每个浏览器最多创建 50 个开放房间，接口带请求限流。
- 房间和空置时间保存在 `data/rooms.sqlite`；备份时请包含整个 `data/` 目录。
- 诊断报告包含浏览器环境、房间与媒体状态、最近错误，不包含 token、邀请密钥等敏感字段。

## 测试

```bash
npm test
```

测试覆盖用户名规则、大厅与权限、多人发流、空置关闭边界、最后成员退出与重新加入、原生窗口音频选项、音轨过滤、快速切换竞态和 WebSocket 状态推送。真实多端媒体链路仍需在支持的桌面 Chrome / Edge 上验证。

## 第三方与许可

- 前端界面来自 [TNTcraftHIM/Piik](https://github.com/TNTcraftHIM/Piik)，按 MIT 许可原样保留在 `src/vendor/piik/`。版本、源文件与 SHA-256 校验值见 `src/vendor/piik/upstream.json` 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 声网 RTC Web SDK 采用 MIT 许可；使用声网服务需遵守其服务条款并自行承担相关费用。
- 本仓库尚未添加统一的 `LICENSE` 文件；如需开源发布，请根据你的需要补充许可证。Piik 衍生部分仍遵循其 MIT 许可。

## 参考

- [声网 Web 屏幕共享文档](https://docportal.shengwang.cn/cn/video-legacy/screensharing_web_ng)
- [getDisplayMedia 选项](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [Chrome 141 发版说明](https://developer.chrome.com/release-notes/141)
