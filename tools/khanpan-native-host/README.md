# Khanpan native host (Windows)

Node.js native messaging helper that the [Khanpan Printer Connector](../khanpan-extension/README.md) Chrome extension launches to drive thermal printers from Windows. Listens only on its own stdio; never accepts inbound network connections.

## Files

- `host.mjs` — Native messaging host entry point. Read by Chrome via the stdio framing in [Chrome's native messaging spec](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-protocol). Dispatches on `argv` so the same binary handles `install`, `uninstall`, and the default host mode.
- `lib-install.mjs` — Chrome native messaging registration helper. Used by both the dev CLI (`install.mjs`) and the SEA-bundled binary's `install` subcommand.
- `install.mjs` — Developer CLI for registering the host without a build step (`node install.mjs`). Customers use the `.exe` installer instead.
- `transports-usb-windows.mjs` — Windows USB Printer Class transport. Sends ESC/POS bytes through the Windows Print Spooler in RAW mode via PowerShell + inline `winspool.drv` P/Invoke. Works with the standard `usbprint` driver — no Zadig swap required.
- `transports-serial.mjs` — Serial transport ([`serialport`](https://serialport.io/) npm). Covers USB-Serial chips (CH340 / PL2303 / FTDI) and OS-paired Bluetooth-COM printers.
- `build.mjs` — Bundles the Node helper + its `serialport` deps into a self-contained folder for `dist/windows/Khanpan-Printer-Host/`.
- `installer-windows/` — [Inno Setup](https://jrsoftware.org/isdl.php) script that wraps the bundle into a per-user `.exe` installer.
- `package.json` — Runtime dep: `serialport`. Dev deps: `esbuild`, `postject`.

## Transports

| Transport | Status | Notes |
|---|---|---|
| TCP / port 9100 (network printers) | ✅ | LAN scan every 30 s; MAC-keyed printer IDs survive DHCP changes. |
| USB Printer Class via Windows Print Spooler RAW | ✅ | Uses the existing `usbprint` driver — no Zadig. PowerShell shells out to `winspool.drv` via inline P/Invoke. |
| Serial / USB-Serial / Bluetooth virtual COM | ✅ | `serialport` package handles all of these. |
| Native Bluetooth Classic / BLE | ⏳ | Browser-side Web Bluetooth + Android RawBT cover this today. |

## Build the Windows installer

```cmd
:: 1. Install dependencies (one-time).
cd tools\khanpan-native-host
pnpm install

:: 2. Build the folder bundle (downloads official Node v22 LTS on first run).
node build.mjs --target=windows

:: 3. Compile the .exe installer. Inno Setup 6+ is free from
::    https://jrsoftware.org/isdl.php — install it once, then:
iscc installer-windows\khanpan-printer-host.iss

:: Output:
::   dist\Khanpan-Printer-Host-Setup-0.1.0.exe
```

## Run the helper for development (without building the installer)

```cmd
cd tools\khanpan-native-host
pnpm install
node install.mjs
```

The installer auto-detects the unpacked Khanpan extension in your Chromium-family browser profile (Chrome, Edge, Brave, Vivaldi, etc.) and writes its native-messaging manifest. Re-run after each extension reload — Chrome assigns a new ID when you reload an unpacked extension.

## What the helper does NOT do

- ❌ Never accepts inbound network connections. The TCP code paths are outbound-only (to printers on port 9100).
- ❌ No analytics, telemetry, or usage data collection.
- ❌ No third-party SDKs beyond the runtime printing dep (`serialport`).
- ❌ No persistent state outside the Chrome native-messaging registry entry.

## Manual smoke test (no extension required)

You can stress the framing without Chrome by sending a length-prefixed JSON message on stdin:

```cmd
node -e "const id='smoke';const body=Buffer.from(JSON.stringify({id,op:'ping'}));const len=Buffer.alloc(4);len.writeUInt32LE(body.length,0);process.stdout.write(Buffer.concat([len,body]));" | node host.mjs
```

You will see a 4-byte length prefix followed by `{"id":"smoke","ok":true,"result":{...}}` on stdout.

## Logs

Chrome captures the helper's stderr at `%LOCALAPPDATA%\Google\Chrome\User Data\chrome_debug.log` when Chrome is started with `--enable-logging --v=1`. For dev, run the manual smoke test above to see logs directly.
