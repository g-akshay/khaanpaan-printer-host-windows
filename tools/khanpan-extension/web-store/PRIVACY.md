# Privacy Policy — Khanpan Printer Connector

**Effective date:** 2026-05-21

## Summary

The Khanpan Printer Connector Chrome extension exists for one purpose: to let the Khanpan POS web app (https://app.khanpan.app) print to USB, network, and Bluetooth thermal printers via a small native helper that runs on your computer. The extension does **not** collect, transmit, store, or share any personal or business data with Khanpan or any third party.

## What the extension can access

The extension declares the minimum permissions needed:

| Permission | Why we ask | What we access | Where it goes |
|---|---|---|---|
| `nativeMessaging` | Required to talk to the local helper process (`khanpan-printer-host`) that actually drives the printer. | A stdio connection to a specific named native host (`com.khanpan.printer`). No other process. | Stays on your computer; never leaves the loopback. |
| `host_permissions: https://app.khanpan.app/*` | Required so a content script on the Khanpan POS page can postMessage to the extension. The page-to-extension handshake is what makes "print this receipt" reach the helper. | Only pages on `app.khanpan.app` (plus `http://localhost:5173` / `5174` during development). | We do not read page contents; the content script only proxies typed JSON messages between the page and the native helper. |

## What the extension does NOT do

- It does **not** read or modify the content of any web page beyond exchanging typed `postMessage` requests on `app.khanpan.app`.
- It does **not** monitor browser activity, history, bookmarks, cookies, or any storage.
- It does **not** make any network requests of its own. All HTTP traffic remains in the POS web app's own session.
- It does **not** transmit anything to Khanpan servers.
- It does **not** collect analytics, telemetry, error reports, or any usage data.
- It does **not** read or modify the clipboard.
- It does **not** access the user's tabs, windows, downloads, or files.
- It does **not** use any third-party SDKs, ads, or trackers.

## Data the native helper sees (but does not send anywhere)

The native helper (`khanpan-printer-host`), installed separately as a standalone binary, processes:

- **ESC/POS byte payloads** the POS sends for printing — these are the bytes of the receipt itself (item names, prices, totals, etc.). The helper forwards them directly to the configured printer and does not retain or transmit them.
- **Printer discovery results** — the helper periodically scans the local LAN for printers on TCP port 9100 and reads the OS ARP table to derive stable per-printer IDs. Discovery results are kept in memory only.
- **A short-lived idempotency cache** of recent print operation IDs (60-second LRU, in-memory only).

The helper writes one file outside its install directory: the Chrome native-messaging manifest in your user profile's NativeMessagingHosts directory, which is required by Chrome to allow the extension to talk to the helper.

The helper does not connect to the internet, send telemetry, or share any data with Khanpan or third parties.

## Open source

Both the extension and the native helper are open source. You can audit every byte of the extension and helper:

- Extension: `tools/khanpan-extension/` in the Khanpan repository.
- Native helper: `tools/khanpan-native-host/host.bundle.cjs` in the same repository — a single bundled JavaScript file you can read.

## Children's privacy

This extension is a B2B tool used by point-of-sale operators. It is not designed for or directed at children under 13.

## Changes to this policy

If we update this policy in a way that materially changes how the extension or helper handles data, we will note the change here with a new effective date and bump the extension's version on the Chrome Web Store.

## Contact

If you have any privacy concerns, email **support@khanpan.app**.
