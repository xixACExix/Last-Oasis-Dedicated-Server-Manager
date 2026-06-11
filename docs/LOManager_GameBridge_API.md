# LOManagerBridge Message Contract

LOManagerBridge is the optional Last Oasis server mod used by the manager for in-game messages.

The manager does not inject messages into the game by itself. It writes small JSON command files into the Last Oasis server folder. The mod runs inside each dedicated server process, watches those files, displays the message in-game, then clears the file back to `{}`.

## Default Inbox Root

```text
C:\LastOasisServer\Mist\Content\Mods\LOManagerBridge\Inbox
```

The inbox root can be changed in the manager under **Game Bridge** if the server is installed somewhere else.

The manager must point at the live server root/inbox used by the running dedicated server processes, not the Steam workshop folder or the ModKit folder.

## Server Identifiers

Each Last Oasis tile process should have an identifier in its launch arguments:

```text
-identifier=realm_server_1
```

The manager uses the same identifier to route tile-specific messages. It also reads live server logs to link identifiers such as `realm_server_1` to the active tile name shown in the UI and Discord slash-command choices.

## Files The Manager Writes

Global fallback with widget support:

```text
Inbox\Admin.json
```

Global fallback without widget support:

```text
Inbox\AdminNOwidget.json
```

Tile messages with widget support:

```text
Inbox\Tiles\realm_server_N.json
```

Tile messages without widget support:

```text
Inbox\TilesNW\realm_server_N.json
```

Discord-to-game replies and slash-command messages:

```text
Inbox\TilesDC\realm_server_N.json
```

## All-Server Fanout

For **All servers**, the manager now writes one command file per live tile identifier. If these servers are live:

```text
realm_server_1
realm_server_2
realm_server_3
```

then a widget-capable all-server message is written as:

```text
Inbox\Tiles\realm_server_1.json
Inbox\Tiles\realm_server_2.json
Inbox\Tiles\realm_server_3.json
```

and a no-widget all-server message is written as:

```text
Inbox\TilesNW\realm_server_1.json
Inbox\TilesNW\realm_server_2.json
Inbox\TilesNW\realm_server_3.json
```

This is the main routing path. `Inbox\Admin.json` and `Inbox\AdminNOwidget.json` are kept as configurable global fallback files. The manager only falls back to those global files when it cannot find any live tile identifiers.

Targeting one tile writes only that tile file.

## Widget Rules

`AdminMessage` shows normal in-game chat.

`RestartWarning` shows chat and can trigger the countdown widget when `seconds` is between `1` and `300`.

The manager uses `RestartWarning` only for the final 5-minute restart warning. Earlier warnings, such as 30, 15, and 10 minutes, are sent as `AdminMessage` so they appear in chat without starting the widget early.

Restart warnings can be written to the per-tile widget files under `Inbox\Tiles\realm_server_N.json`. This allows all-server restart warnings to fan out to every live tile instead of depending only on `Inbox\Admin.json`.

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
6. If an all-server message does not appear in game but tile-specific messages work, check that the manager can see live tile identifiers and that the `Tiles`/`TilesNW` folders match the mod paths.

## In-Game Restart Messages

Scheduled restart:

```text
Server restart in {first-warning} minutes for a Scheduled Restart ({schedule})
Server restart in 15 minutes for a Scheduled Restart ({schedule})  [when first warning is 30 or 15]
Server restart in 10 minutes for a Scheduled Restart ({schedule})  [when first warning is 30, 15, or 10]
Server restart in 5 minutes for a Scheduled Restart ({schedule})
Server restarting now for a Scheduled Restart ({schedule})
```

The scheduled restart first-warning dropdown only allows `30`, `15`, `10`, or `5` minutes.

Examples:

```text
30 minutes selected -> 30 / 15 / 10 / 5 / now
15 minutes selected -> 15 / 10 / 5 / now
10 minutes selected -> 10 / 5 / now
5 minutes selected  -> 5 / now
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
