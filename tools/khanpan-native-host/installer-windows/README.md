# Windows .exe installer (Inno Setup)

Wraps `dist/windows/Khanpan-Printer-Host/` into a per-user, double-clickable installer with Control Panel uninstall integration. Customer never sees a terminal window.

## What the installer does

1. Drops the bundle to `%LOCALAPPDATA%\Programs\Khanpan-Printer-Host\`. No admin prompt.
2. Adds a **Re-register Khanpan Printer Host** Start-Menu shortcut → re-runs the registration (useful after Chrome reloads the extension and assigns it a new ID, in dev / unpacked).
3. Adds an **Uninstall Khanpan Printer Host** Start-Menu shortcut + a Settings → Apps entry.
4. Postinstall: runs `khanpan-printer-host.bat install` so Chrome's native-messaging manifest is written before the wizard's "Finished" page.
5. Uninstall: runs `khanpan-printer-host.bat uninstall` first so the registry entry is cleaned up cleanly, then removes the files.

## Build

Requires Windows + [Inno Setup 6+](https://jrsoftware.org/isdl.php) (free).

```cmd
:: 1. Build the bundle that the .iss will pick up.
cd tools\khanpan-native-host
node build.mjs --target=windows

:: 2. Compile the installer.
iscc installer-windows\khanpan-printer-host.iss

:: Output:
::   dist\Khanpan-Printer-Host-Setup-0.1.0.exe
```

## Versioning

Inno Setup's `MyAppVersion` is hard-coded at the top of `khanpan-printer-host.iss`. Keep it in sync with:

- `tools/khanpan-extension/manifest.json` → `version`
- `tools/khanpan-extension/web-store/manifest.prod.json` → `version`
- `tools/khanpan-native-host/host.mjs` → `VERSION` constant

A future build script can read one of these and string-replace into the .iss; for now it's manual.

## Code signing (not yet done)

The compiled `.exe` is **unsigned**. Windows SmartScreen will warn on first install ("Windows protected your PC → Don't run / More info → Run anyway"). To clear this:

1. Acquire an Authenticode code-signing certificate (standard or EV).
2. In `khanpan-printer-host.iss`, uncomment the `SignTool=…` line and configure `iscc /Ssigntool=…` with the cert thumbprint.
3. EV certs get instant SmartScreen reputation. Standard certs accumulate reputation over downloads — first 100-1000 installs still see the warning.

Free Authenticode signing for open-source projects is planned via [SignPath Foundation](https://signpath.org/foundation).

## Files

- `khanpan-printer-host.iss` — Inno Setup script. Editable by hand.
- `README.md` — this file.

## CI build

`.github/workflows/release.yml` in the repo root produces a signed `.exe` on every release tag — see that file for the exact pipeline.
