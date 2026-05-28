# Last Oasis Manager Game Bridge API

This is the manager-side contract for a future Last Oasis server mod. The manager does not inject messages into the game by itself. The mod polls the local manager API, displays queued messages in-game, then acknowledges them.

Keep this API local to the dedicated server machine. Do not expose the manager port publicly.

## Base URL

```text
http://127.0.0.1:4020
```

## Poll Messages

The mod should poll every 1-3 seconds while the map/server is running.

```http
GET /api/game-bridge/messages/poll?clientId=LastOasisBridge&version=1.0.0&mapName=MAP_NAME&limit=25
```

Response:

```json
{
  "serverTime": "2026-05-05T12:00:00.000Z",
  "status": {
    "configured": true,
    "mode": "mod-bridge",
    "pollEndpoint": "/api/game-bridge/messages/poll",
    "ackEndpoint": "/api/game-bridge/messages/ack",
    "chatEndpoint": "/api/game-bridge/chat",
    "pendingCount": 1,
    "queueDepth": 4
  },
  "messages": [
    {
      "id": "msg-example",
      "type": "restart-warning",
      "severity": "warning",
      "title": "Scheduled restart",
      "message": "Server restart in 10 minutes for Primary Realm. Reason: Scheduled restart.",
      "durationSeconds": 15,
      "countdownSeconds": 600,
      "target": "all"
    }
  ]
}
```

Message types currently used:

- `admin`
- `restart-warning`
- `restart-now`
- `update-warning`
- `update-status`
- `maintenance`
- `system`

Severity values:

- `info`
- `success`
- `warning`
- `danger`

## Acknowledge Messages

After the mod displays a message, acknowledge it so the manager stops sending it.

```http
POST /api/game-bridge/messages/ack
Content-Type: application/json
```

```json
{
  "clientId": "LastOasisBridge",
  "ids": ["msg-example"]
}
```

## Send Captured Chat To Manager

If the mod can observe chat events, it can send them to the manager for logging.
If the manager has a Game Chat Discord webhook configured, non-duplicate chat entries are also posted to Discord.

```http
POST /api/game-bridge/chat
Content-Type: application/json
```

```json
{
  "clientId": "LastOasisBridge",
  "channel": "all",
  "playerName": "PlayerName",
  "message": "Hello",
  "mapName": "Canyon",
  "tileName": "Event Salt Frontier",
  "profileId": "optional-host-or-map-id",
  "externalId": "optional-stable-chat-event-id"
}
```

Allowed channel values are `all`, `map`, `clan`, `combat`, and `other`.
Send `externalId` when the mod has a stable message/event id. The manager uses it to prevent repeat Discord posts. Without it, identical chat from the same player/channel/map/tile is deduped for 15 seconds.

The manager stores a recent chat tail for the UI and appends a JSON-lines log at:

```text
<profile-root>\message-bridge\chat.jsonl
```

## Manager Admin Message Endpoint

The standalone manager uses this endpoint when you type an admin message in the Game Bridge tab.

```http
POST /api/message-bridge/admin-message
Content-Type: application/json
```

```json
{
  "title": "Admin",
  "message": "Server restart in 10 minutes.",
  "severity": "warning",
  "durationSeconds": 12
}
```

## Blueprint/VaRest Shape

Basic mod loop:

1. On server/map start, create a timer that runs every 1-3 seconds.
2. Timer calls `GET /api/game-bridge/messages/poll`.
3. For each returned message:
   - show chat/UI broadcast to all players on that map/server
   - if `countdownSeconds` is present, start/update the countdown widget
   - remember the `id`
4. POST all displayed IDs to `/api/game-bridge/messages/ack`.
5. When chat is observed, POST it to `/api/game-bridge/chat`.

The manager already queues restart warnings, update warnings, "restarting now" notices, update status messages, and manual admin messages. The mod only needs to display what it receives.
