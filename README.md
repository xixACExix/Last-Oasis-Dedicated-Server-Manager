# Last Oasis Dedicated Server Manager

Windows desktop manager for running multiple Last Oasis dedicated server tiles for one realm.

## What it does

- Manages multiple tile host profiles for one Last Oasis realm.
- Starts, stops, and safely restarts tile server processes.
- Checks and applies dedicated server updates through SteamCMD.
- Checks and applies configured Workshop mod updates.
- Posts restart, update, player-count, event tile, and chat messages to Discord webhooks.
- Supports scheduled restarts, update restarts, and safe-stop workflows.
- Integrates with MyRealm for tile/session visibility and event tile cycles.
- Supports an optional LOManagerBridge server-side mod for in-game admin/restart messages.
- Provides a small remote web panel for basic server control from the local network.

## Windows Only

This release is built for Windows dedicated servers. Linux support is not included yet.

## Download

Use the latest GitHub Release and download:

`LastOasisManager-Installer.exe`

The installer is large, so it should be uploaded as a GitHub Release asset instead of committed directly to the repository.

## Install

1. Download `LastOasisManager-Installer.exe`.
2. Put it in the folder where you want the manager installed, for example:
   `C:\LO Dedicated Manager`
3. Run the installer.
4. Open `Last Oasis Dedicated Server Tool.exe`.
5. Configure your Last Oasis dedicated server path, SteamCMD path, MyRealm keys, Workshop mod IDs, and Discord webhooks.
6. Start the backend from the manager.
7. Create or review your tile host profiles.

## Optional In-Game Message Bridge

Discord and manager-side messages work without any mod.

In-game admin messages, restart warnings, and countdown popups require a compatible server-side Last Oasis mod that reads the manager bridge JSON files. If that mod is not installed on the server tiles, the manager will still run, but messages will not appear inside the game.

## Remote Web Panel

The backend can expose a local web panel on the configured API port. Open it from the same network using:

`http://SERVER-IP:4020`

Set a remote password in the manager before exposing this outside the local machine.

## Safety Notes

- Keep MyRealm keys, provider keys, API keys, Discord webhooks, and bot tokens private.
- Do not upload your `LO_Profiles` folder publicly.
- Do not upload manager backups or browser debug profiles publicly.
- Only share the installer and public documentation.
