# LOManagerBridge Message Contract

LOManagerBridge is the optional Last Oasis server mod used by the manager for in-game messages.

The manager does not inject messages into the game by itself. It writes small JSON command files into the Last Oasis server folder. The mod runs inside each dedicated server process, watches those files, displays the message in-game, then clears the file back to `{}`.

## Default Inbox Root

```text
C:\LastOasisServer\Mist\Content\Mods\LOManagerBridge\Inbox
```

The inbox root can be changed in the manager under **Game Bridge** if the server is installed somewhere else.

## Server Identifiers

Each Last Oasis tile process should have an identifier in its launch arguments:

```text
-identifier=realm_server_1
```

The manager uses the same identifier to route tile-specific messages. It also reads live server logs to link identifiers such as `realm_server_1` to the active tile name shown in the UI and Discord slash-command choices.

## Files The Manager Writes

Global messages with widget support:

```text
Inbox\Admin.json
```

Global messages without widget support:

```text
Inbox\AdminNOwidget.json
```

Tile-specific admin messages with widget support:

```text
Inbox\Tiles\realm_server_N.json
```

Tile-specific admin messages without widget support:

```text
Inbox\TilesNW\realm_server_N.json
```

Discord-to-game replies and slash-command messages:

```text
Inbox\TilesDC\realm_server_N.json
```

`RestartWarning` commands are only written to the global widget file, `Inbox\Admin.json`, so every running tile can show the restart notice. Only the final 5-minute restart warning uses `RestartWarning`; earlier restart notices use normal admin chat messages.

## JSON Format

Admin message:

```json
{
  "id": "admin-unique-id",
  "type": "AdminMessage",
  "message": "Admin message text",
  "seconds": 0,
  "createdUtc": "2026-05-25T00:00:00.000Z"
}
```

Restart warning:

```json
{
  "id": "restart-unique-id",
  "type": "RestartWarning",
  "message": "Server restart in 5 minutes for a Scheduled Restart (00:00 / 12:00)",
  "seconds": 300,
  "createdUtc": "2026-05-25T00:00:00.000Z"
}
```

Rules:

1. Every send must use a fresh unique `id`.
2. Files should be UTF-8 JSON without BOM.
3. Missing folders are created by the manager.
4. After the mod reads a command, it clears that JSON file back to `{}`.
5. If the file does not clear, the mod did not read that path.

## In-Game Restart Messages

Scheduled restart:

```text
Server restart in 30 minutes for a Scheduled Restart ({schedule})
Server restart in 15 minutes for a Scheduled Restart ({schedule})
Server restart in 10 minutes for a Scheduled Restart ({schedule})
Server restart in 5 minutes for a Scheduled Restart ({schedule})
Server restarting now for a Scheduled Restart ({schedule})
```

Mod update:

```text
Server restart in 15 minutes for a Mod Update
Server restart in 10 minutes for a Mod Update
Server restart in 5 minutes for a Mod Update
Server restarting now for a Mod Update
```

Server update:

```text
Server restart in 15 minutes for a Server Update
Server restart in 10 minutes for a Server Update
Server restart in 5 minutes for a Server Update
Server restarting now for a Server Update
```

Scheduled safe stop:

```text
Restart in 10 minutes for a {custom safe-stop message}
Restart in 5 minutes for a {custom safe-stop message}
Server restarting now for a {custom safe-stop message}
```

## Discord-To-Game Messages

Discord replies and `/lo-message` slash-command sends are written to:

```text
Inbox\TilesDC\realm_server_N.json
```

The message text sent to the mod is:

```text
DiscordName - message text
```

The mod adds its own `Discord:` prefix in game, so players see:

```text
Discord: DiscordName - message text
```

## Server Chat Logging

The manager reads Last Oasis server logs to capture player chat where possible. Chat is shown in the manager/web panel, can be posted to Discord, and is written under the configured `LO_Profiles` folder.

The manager keeps a recent UI tail and writes chat logs in:

```text
<LO_Profiles>\message-bridge\chat-logs
```

Example Discord/chat line:

```text
Sleeping Giants w/ Roads - PlayerName: message text
```

## Local API Notes

The manager also exposes local API endpoints used by its desktop UI and web panel. Keep the manager API on the dedicated server or trusted LAN only. Do not expose the API port publicly without network-level protection.
