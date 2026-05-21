# Khanpan Printer Host (Windows)

Open-source Chrome extension and Node.js native messaging helper that lets web apps print to USB, network, serial, and Bluetooth thermal printers from a Windows cashier PC.

Built for the [Khanpan POS](https://khanpan.app), and usable by any web application that needs browser-to-printer access on Windows without driver replacements.

## What this code does

```
Web app (browser tab)
  │
  │ window.postMessage
  ▼
Chrome extension (this repo, tools/khanpan-extension/)
  │
  │ Chrome native messaging (stdio JSON, 4-byte LE length prefix)
  ▼
khanpan-printer-host (this repo, tools/khanpan-native-host/)
  │
  │ TCP / Windows Print Spooler / serial
  ▼
Thermal printer
```

The extension is a thin bridge — it forwards typed JSON messages from the web page to the helper process and back. It does not read web-page contents, collect telemetry, or talk to any server.

The helper process listens only on its own stdio (no network ports of its own), discovers printers on the local network and the OS print spooler, and forwards ESC/POS bytes to the chosen printer.

## What it does NOT do

- ❌ No analytics, telemetry, or usage data collection.
- ❌ No network requests of its own (the helper opens TCP only to printers on `port 9100`).
- ❌ No access to browser tabs, history, cookies, downloads, or clipboard.
- ❌ No third-party SDKs, ads, or trackers.

See [tools/khanpan-extension/web-store/PRIVACY.md](./tools/khanpan-extension/web-store/PRIVACY.md) for the full privacy policy.

## Transports (Windows)

| Transport | Status | How |
|---|---|---|
| TCP / network printer (port 9100) | ✅ | Direct TCP to LAN printer. MAC-keyed stable IDs survive DHCP changes. |
| USB Printer Class via Windows Print Spooler | ✅ | Spooler raw mode via PowerShell + inline P/Invoke. Works with the standard `usbprint` driver — no driver replacement (no Zadig) required. |
| Serial / USB-Serial / Bluetooth virtual COM | ✅ | [`serialport`](https://serialport.io/) npm package. Covers CH340/PL2303/FTDI chips and OS-paired Bluetooth printers exposed as `COM*`. |
| Native Bluetooth Classic / BLE in helper | ⏳ Future | Browser-side Web Bluetooth + Android paths cover this today. |

## Build

### Native helper

```cmd
cd tools\khanpan-native-host
pnpm install
node build.mjs --target=windows
```

Output: `tools\khanpan-native-host\dist\windows\Khanpan-Printer-Host\` — a self-contained folder bundle (~110 MB; includes the official Node.js v22 LTS runtime).

### Windows installer (Inno Setup)

```cmd
:: Free download from https://jrsoftware.org/isdl.php
iscc tools\khanpan-native-host\installer-windows\khanpan-printer-host.iss
```

Output: `tools\khanpan-native-host\dist\Khanpan-Printer-Host-Setup-<version>.exe`. Per-user install, no admin prompt; postinstall script auto-registers the Chrome native messaging manifest under `HKCU`.

See [`tools/khanpan-native-host/installer-windows/README.md`](./tools/khanpan-native-host/installer-windows/README.md) for full build instructions.

### Extension

```cmd
cd tools\khanpan-extension
pnpm install
pnpm run build:icons       :: regenerate icon PNGs from icon.svg
pnpm run build:store       :: build the Web Store submission zip
```

Output: `tools\khanpan-extension\web-store\khanpan-printer-connector-<version>.zip`.

## Releases

Tagged releases trigger a GitHub Actions workflow that builds the Windows `.exe` installer and attaches it to the release. See `.github/workflows/release.yml`.

Releases are currently unsigned — Windows SmartScreen will warn on first install. Click **More info → Run anyway** to clear the dialog; Windows remembers the choice. Authenticode signing is planned via [SignPath Foundation](https://signpath.org/foundation).

## Security model

- The helper accepts only Chrome native-messaging connections from the specific extension ID listed in its manifest. No other process can launch it.
- The extension's content script is bound to the production origin (`https://app.khanpan.app/*`) via the manifest's `host_permissions`. It cannot run on arbitrary pages.
- The Chrome native messaging port uses Chrome's standard process isolation — the helper runs as a child of Chrome with the user's privileges, not as a daemon.
- The helper never accepts inbound network connections. The TCP code paths are outbound-only (to printers).

## License

[Apache-2.0](./LICENSE). Free to use, modify, and redistribute.

## Contact

Issues / questions: support@khanpan.app
