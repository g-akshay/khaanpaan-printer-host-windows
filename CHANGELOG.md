# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-21

First public release.

### Added

- Chrome extension (`tools/khanpan-extension/`) — Manifest V3, content script,
  service worker, and popup. Bridges `window.postMessage` from a web page to
  the native helper over Chrome's native-messaging stdio channel.
- Native messaging helper (`tools/khanpan-native-host/`) — Node.js, bundled
  with the official Node v22 LTS runtime via esbuild.
  - TCP transport for network thermal printers on port 9100, with MAC-keyed
    stable IDs that survive DHCP changes.
  - Windows USB Printer Class transport — sends raw ESC/POS through the OS
    Print Spooler in RAW mode via PowerShell + inline `winspool.drv` P/Invoke.
    Works with the stock `usbprint` driver — no Zadig swap required.
  - Serial transport via [`serialport`](https://serialport.io/) — covers
    USB-Serial chips (CH340 / PL2303 / FTDI) and OS-paired Bluetooth Classic
    printers exposed as virtual COM ports.
- Inno Setup installer (`tools/khanpan-native-host/installer-windows/`) —
  per-user `.exe`, no admin prompt; postinstall registers the native messaging
  manifest in HKCU.
- GitHub Actions release workflow (`.github/workflows/release.yml`) — builds
  the bundle and the `.exe` on every `v*` tag and attaches the artifact to the
  Release.

### Security

- The helper accepts only Chrome native-messaging connections from the specific
  extension ID listed in its manifest.
- The extension is bound to `https://app.khanpan.app/*` via `host_permissions`.
- No inbound network listeners. TCP code paths are outbound-only (to printers).
- No analytics, telemetry, third-party SDKs, or cookies.

[Unreleased]: https://github.com/g-akshay/khaanpaan-printer-host-windows/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/g-akshay/khaanpaan-printer-host-windows/releases/tag/v0.1.0
