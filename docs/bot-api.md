# Bot 接口

`/api/bot/*` 供 Oopz bot 等外部程序调用，用 Bearer Token 鉴权，不依赖浏览器 Cookie，也不需要先设置用户名。

## 启用

在 `.env` 中配置：

```ini
BOT_API_TOKEN=换成一个足够长的随机字符串
BOT_IDENTITY=oopz-bot
BOT_NAME=OopzBot
```

`BOT_API_TOKEN` 留空时整个 `/api/bot/*` 返回 503。修改后需要重启服务。

所有请求都带：

```http
Authorization: Bearer <BOT_API_TOKEN>
```

鉴权失败返回 401。bot 创建的房间统一归 `BOT_IDENTITY` 所有，房间名由调用方传入，通常用 Oopz 发起者的显示名。

## 接口

### `GET /api/bot/status`

服务状态、可用服务商和房间数量。`providers` 按推荐顺序 `volc → volc2 → agora → zego` 返回，`available` 表示服务端凭据是否配置。

```json
{
  "configured": true,
  "providers": [
    { "name": "volc", "label": "火山引擎 1", "available": true, "status": "ok", "remaining": 9800, "unit": "标准分钟" }
  ],
  "rooms": { "total": 3, "active": 1 },
  "quota": { "volc": { "status": "ok", "remaining": 9800, "total": 10000 } }
}
```

### `GET /api/bot/rooms`

房间列表，包含在线成员和共享状态。

| 参数 | 说明 |
| --- | --- |
| `active=1` | 只返回有人的房间 |
| `sharing=1` | 只返回当前有人共享的房间 |
| `initiator=<uid>` | 只返回该发起者创建的房间 |

房间按「有人 → 正在共享 → 创建时间倒序」排列。

```json
{
  "total": 1,
  "rooms": [
    {
      "id": "6af6b3eeadb0",
      "name": "小明",
      "description": "",
      "provider": "agora",
      "providerLabel": "声网",
      "initiator": "Oopz 用户 uid",
      "onlineCount": 2,
      "sharingCount": 1,
      "participants": [
        { "uid": 123456, "name": "小明", "sharing": true, "isOwner": false }
      ],
      "webUrl": "https://piik.example.com/#room=6af6b3eeadb0",
      "closesAt": null
    }
  ]
}
```

`closesAt` 为空表示房间内有人；否则是空房间自动关闭的时间戳。

### `GET /api/bot/rooms/:id`

单个房间详情，结构同上。房间不存在或已关闭返回 404。

### `POST /api/bot/rooms`

创建房间。`provider` 必填，缺失时返回 400 和当前可用的服务商列表。名称最多 40 字，描述最多 160 字。

```json
{ "name": "小明", "provider": "volc", "description": "", "initiatorId": "Oopz 用户 uid" }
```

传入 `initiatorId` 时，如果该发起者已经有开放中的房间，直接返回已有房间并带上 `"reused": true`（HTTP 200），不会重复创建；新建成功返回 201 和 `"reused": false`。房间关闭或空置 15 分钟自动归档后，可以重新创建。

创建沿用浏览器的规则：服务商余量达到 500 分钟保护线时返回 403，同一归属身份最多 50 个房间。

### `POST /api/bot/rooms/:id/enter`

返回房间信息和邀请链接。bot 本身没有 RTC 能力，不会加入房间，也不占 RTC 额度；这一步只是把 `webUrl` 交给用户打开。

### `DELETE /api/bot/rooms/:id`

关闭房间并踢掉现有会话，返回 `{ "ok": true }`。

带发起者 uid 时会校验归属：`DELETE /api/bot/rooms/<id>?initiatorId=<uid>`。房间不是该发起者创建的返回 403；没有 `initiator` 的旧房间视为无主房间，允许清理。

## curl 示例

```bash
TOKEN=你的 BOT_API_TOKEN
BASE=https://piik.example.com

curl -H "Authorization: Bearer $TOKEN" "$BASE/api/bot/status"
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/bot/rooms?sharing=1"

curl -X POST "$BASE/api/bot/rooms" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"小明","provider":"volc"}'

curl -X POST "$BASE/api/bot/rooms/6af6b3eeadb0/enter" \
  -H "Authorization: Bearer $TOKEN"
```

## 桌面端

桌面端目前只支持 `--server=` 启动参数，尚未注册自定义协议。`piik-rtc://` 深链（拉起桌面端并直接进入指定房间）需要后续在 `desktop/PiikRTC` 增加协议注册和单实例参数转发，本轮未实现。目前请使用返回的网页邀请链接。
