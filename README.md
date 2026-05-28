# Last Oasis Dedicated Server Manager

Windows desktop manager for running multiple Last Oasis dedicated server tiles for one realm.

## Features

- Start, stop, and safely restart Last Oasis tile servers.
- Manage multiple tile host profiles for one realm.
- Check and apply dedicated server updates through SteamCMD.
- Check and apply configured Workshop mod updates.
- Configure scheduled restarts and safe-stop workflows.
- Send Discord notifications for restarts, updates, player counts, event tiles, and server chat.
- View MyRealm tile/session information from the manager.
- Create and manage timed event tile cycles.
- Optional in-game admin/restart messages through the LOManagerBridge server mod.
- Optional local-network web panel for quick remote control.

## Requirements

- Windows dedicated server machine.
- Last Oasis Dedicated Server installed.
- SteamCMD for updates and Workshop mods.
- MyRealm customer/provider details for hosting.
- Discord webhooks if you want Discord notifications.
- Optional: [LOManagerBridge](https://steamcommunity.com/sharedfiles/filedetails/?id=3727189852) if you want in-game admin messages, restart warnings, countdown popups, or Discord-to-game replies.

## Install

1. Download `LastOasisManager-Installer.exe` from the latest release.
2. Put it in the folder where you want the manager installed, for example `C:\LO Dedicated Manager`.
3. Run the installer.
4. Open `Last Oasis Dedicated Server Tool.exe`.
5. Configure your dedicated server path, SteamCMD path, MyRealm keys, Workshop mod IDs, and Discord webhooks.
6. Start the backend from the manager.
7. Create or review the tile host profiles for your realm.

## LOManagerBridge

[LOManagerBridge](https://steamcommunity.com/sharedfiles/filedetails/?id=3727189852) is an optional server-side mod that lets the manager send messages into the game.

The manager itself can still run servers, update mods, update the dedicated server, manage event tiles, and post Discord notifications without the bridge mod. The bridge is only needed for messages that should appear inside Last Oasis.

When installed on the server tiles, the mod watches a small inbox folder inside the Last Oasis server files. The manager writes tiny JSON command files into that folder. The mod reads the command, shows the message in-game, then clears the file so it will not repeat.

The bridge supports:

- Admin messages to all servers.
- Admin messages to one live tile.
- Restart warnings in game chat.
- A 5-minute restart countdown popup.
- Discord replies or slash-command messages sent back to a specific live tile.

The manager links live tile names to server identifiers such as `realm_server_1`, `realm_server_2`, and so on. This lets Discord replies and targeted admin messages go to the correct tile instead of every server.

For the bridge file layout and message format, see `docs/LOManager_GameBridge_API.md`.

## Remote Web Panel

The manager can expose a small local-network web panel on the configured API port.

Example:

`http://SERVER-IP:4020`

Set a remote password in the manager before using the web panel from another device.

## Notes

This release is Windows only for now.

Keep MyRealm keys, provider keys, API keys, Discord webhooks, bot tokens, and Steam login details private.
