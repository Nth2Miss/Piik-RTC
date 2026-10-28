# AGENTS.md

本文件约束在本仓库工作的 AI 代理。面向用户的说明在 `README.md` 和 `docs/`，这里只写工作约定。

## 项目结构

- 网页前端：`src/`，React 19 + TypeScript + Vite。
- 服务端：`server/`，Node.js 24 + Express 5 + 内置 `node:sqlite` + WebSocket。
- Windows 桌面端：`desktop/`，C# WebView2 主机与 WASAPI 音频组件。
- 构建与开发脚本：`scripts/`。
- `src/vendor/piik/` 是上游 Piik 的原样副本，不要手工修改；需要更新时使用 `scripts/vendor-piik.mjs` 重新导入。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动开发服务，访问 `http://localhost:3000` |
| `npm run build` | 类型检查并构建到 `dist/` |
| `npm test` | 运行 `server/tests/*.test.js` 下的 `node:test` 用例 |
| `npm run desktop:dev` | 本地构建并运行桌面端（Windows） |
| `npm run desktop:build` | 构建单文件 `release/Piik-v<版本>.exe` |
| `npm run desktop:helper` | 单独发布 WASAPI 音频组件 |

屏幕共享只能在 `localhost` 或 HTTPS 下工作；网页版请用桌面版 Chrome / Edge 验证。桌面端构建需要 Windows 和 .NET 9 SDK，当前环境无法验证时必须明确说明未验证。

## 代码风格

- 沿用现有风格：2 空格缩进、单引号、紧凑写法（存在较长的单行 JSX），不要做与任务无关的格式化、重排或重命名。
- 界面文案使用中文，保持现有语气；代码注释只在需要说明约束或非显然原因时添加。
- 保持 TypeScript `strict` 通过，不用 `any`、`@ts-ignore` 或其他方式绕过类型检查。
- 不引入新的 UI 库或运行时依赖，除非任务确实需要并已与用户确认。
- `src/` 的改动应继续保持桌面端与移动端布局可用；现有样式变量（如 `--live`、`--line`）优先于硬编码颜色。

## 业务规则（不要回退）

- RTC 服务商类型固定为 `agora | zego | volc | volc2`。
- 创建房间时的服务商顺序为 `volc`、`volc2`、`agora`、`zego`；两个火山应用标注“推荐”。这是产品决定，不要改回旧顺序。
- `volc2` 复用火山 SDK 槽位，但用量和 500 分钟保护按应用独立统计。
- 预计剩余额度达到或低于 500 分钟时，禁止新建、编辑或续期对应服务商的房间。
- 即构共享画面上限为 1080P、码率上限 10 Mbps，超出时应自动降级并提示，不要放宽限制。
- 火山引擎免费资源包按 1:1 抵扣（纯音频、360P/720P/1080P/2K/4K 及小程序端均为每分钟 1 分钟），README 中的相关说明不要随意改写。

## 安全与数据

- 绝不读取、输出或提交 `.env`、`data/`、仓库根目录下的 `用量统计/` 等包含密钥、Cookie、数据库或用户数据的文件。
- 不把 AppKey、Token、Cookie、Access Key 写入代码、日志、测试快照或提交信息。
- 提交前逐项检查 `git status`，只暂存本次任务涉及的文件，不要使用不加限定的 `git add -A` 或 `git add .`。
- `dist/`、`release/`、`desktop/bin/`、`node_modules/` 等生成物不提交。

## 发版与 CI

- 推送 master/main 只会触发 Docker workflow；Desktop workflow 仅手动触发（`workflow_dispatch`），运行后按 `package.json` 版本构建并创建/更新 GitHub Release。
- 需要发布桌面版时，先执行 `npm version patch --no-git-tag-version` 提升版本，并确保 `package.json` 与 `package-lock.json` 同步。
- 如果用户明确要求本次不发布，才可跳过版本提升，并在结果中说明。
- 标签格式为 `v<版本>`，必须与 `package.json` 一致。
- 除非用户明确要求，不要执行 `git push`、创建 tag 或触发发布。

## 文档同步

- 行为、配置或部署方式变化时，同步更新受影响的部分：`README.md`、`docs/deployment.md`、`docs/desktop.md`、`.env.example`。
- 提交信息用中文，简洁描述改动，不写与改动无关的内容。
