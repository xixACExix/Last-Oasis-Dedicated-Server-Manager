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
- Optional in-game admin/restart messages through a compatible LOManagerBridge server mod.
- Optional local-network web panel for quick remote control.

## Requirements

- Windows dedicated server machine.
- Last Oasis Dedicated Server installed.
- SteamCMD for updates and Workshop mods.
- MyRealm customer/provider details for hosting.
- Discord webhooks if you want Discord notifications.

## Install

1. Download `LastOasisManager-Installer.exe` from the latest release.
2. Put it in the folder where you want the manager installed, for example `C:\LO Dedicated Manager`.
3. Run the installer.
4. Open `Last Oasis Dedicated Server Tool.exe`.
5. Configure your dedicated server path, SteamCMD path, MyRealm keys, Workshop mod IDs, and Discord webhooks.
6. Start the backend from the manager.
7. Create or review the tile host profiles for your realm.

## In-Game Messages

Discord and manager-side notifications work without a mod.

To show admin messages, restart warnings, or countdown popups inside Last Oasis, install a compatible LOManagerBridge server-side mod on your tiles and set the bridge path in the manager.

## Remote Web Panel

The manager can expose a small local-network web panel on the configured API port.

Example:

`http://SERVER-IP:4020`

Set a remote password in the manager before using the web panel from another device.

## Notes

This release is Windows only for now.

Keep MyRealm keys, provider keys, API keys, Discord webhooks, bot tokens, and Steam login details private.
