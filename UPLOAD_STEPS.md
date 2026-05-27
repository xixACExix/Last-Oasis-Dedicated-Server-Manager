# GitHub Upload Steps

Recommended setup:

1. Create a public GitHub repository.
2. Commit only `README.md` and optionally `RELEASE_NOTES.md`.
3. Create a GitHub Release.
4. Upload `LastOasisManager-Installer.exe` as the release asset.
5. Paste the release notes from `RELEASE_NOTES.md`.

Do not upload:

- The working project folder.
- `data\`
- `tmp\`
- `node_modules\`
- `tools\`
- `LO_Profiles\`
- Browser debug profiles.
- Old backups.
- Any config files containing Discord webhooks, bot tokens, MyRealm cookies, customer keys, provider keys, IPs, or Steam login data.

If using GitHub CLI after creating a repository:

```powershell
gh release create v0.1.16 `
  "LastOasisManager-Installer.exe" `
  --title "Last Oasis Dedicated Server Manager v0.1.16" `
  --notes-file "RELEASE_NOTES.md"
```
