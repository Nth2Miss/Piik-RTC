# Piik-RTC

Piik-RTC 是一个多人屏幕共享与语音客厅。输入用户名即可创建或加入房间，支持声网、即构和火山引擎 RTC（含两个独立的火山应用），无需注册或安装客户端。

## 功能特性

- **多人同时共享**：多人可同时共享屏幕、窗口或标签页，点击成员切换观看；支持音量、画中画、画面适配和全屏。
- **多家 RTC 服务商**：支持声网、即构和火山引擎；两个火山应用分别统计用量，并各自独立执行 500 分钟额度保护。
- **开箱即用**：输入用户名即可创建或加入房间，无需注册或安装客户端。
- **按需连接**：空闲时自动断开媒体连接；空房间连续 15 分钟后自动关闭。
- **用量监控**：服务状态页展示供应商余量与本地估算，接近额度时阻止新建并关闭对应服务商的房间。
- **易用界面**：亮暗主题、中英文切换、响应式布局，提供连接统计、问题排查和脱敏诊断报告。

> **免费额度**：声网、即构各提供每月 10,000 分钟；火山引擎的两个应用各自提供每月 10,000 分钟。实际额度以服务商控制台和活动规则为准。

## 截图

| 欢迎页 | 房间内 |
| :---: | :---: |
| ![Piik-RTC 欢迎页](docs/images/welcome.png) | ![房间内](docs/images/room.png) |

| 房间大厅 | 创建房间与 RTC 服务商 |
| :---: | :---: |
| ![房间大厅](docs/images/lobby.png) | ![创建房间与 RTC 服务商选择](docs/images/create-room.png) |

| 服务状态与用量 |
| :---: |
| ![服务状态](docs/images/service-status.png) |

## 最快部署

需要 Docker 与 Docker Compose，并至少准备一家 RTC 服务商的凭据。

```bash
git clone <你的仓库地址> Piik-RTC
cd Piik-RTC
cp .env.example .env
# 编辑 .env，至少填写一家 RTC 服务商的凭据
docker compose up -d
```

打开 `http://服务器IP:3000`。屏幕共享需要 `localhost` 或 HTTPS；公网使用请配置 HTTPS 反向代理并设置 `PUBLIC_ORIGIN`。

完整的环境变量、Node.js / Docker / 反向代理 / 数据备份、双火山应用与即构 Cookie 说明见 [部署文档](docs/deployment.md)。

## 许可

Piik-RTC 以 [MIT 许可](LICENSE)发布。

界面基于 [Piik](https://github.com/TNTcraftHIM/Piik)（MIT）并保留其版权声明；vendored 部分许可见 `src/vendor/piik/LICENSE`，其他第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
