# Chrome Web Store — listing copy

Source-of-truth for what gets pasted into the Web Store dev console. Keep this file in sync with what's live; that way the listing is reviewable as part of normal PR flow.

---

## Name (max 75 chars)

```
Khanpan Printer Connector
```

## Short description (max 132 chars)

```
Lets the Khanpan POS print to USB, network, and Bluetooth thermal printers — no driver hacks, no terminal.
```

## Category

```
Productivity
```

## Language

```
English
```

---

## Detailed description (max 16,000 chars; markdown not supported, plain text only)

```
Khanpan Printer Connector is the companion extension for the Khanpan Point-of-Sale web app
(https://app.khanpan.app). It lets the browser print to your thermal receipt printer regardless
of how that printer is connected — USB, network (WiFi or ethernet), Bluetooth Classic, or BLE.

Why this exists
---------------
Browsers can't open raw TCP sockets to a LAN printer, and on Windows the system "usbprint"
driver claims USB Printer Class devices, blocking WebUSB. This extension solves both: a small
local helper (you install it once) does the actual printing on the browser's behalf.

What it does
------------
• Print receipts and Kitchen Order Tickets from Khanpan POS to any port-9100 network printer.
• Print to Windows USB Printer Class devices (TVS, Epson, Star, etc.) without Zadig driver swaps.
• Discovers printers automatically: LAN scan + ARP for stable MAC-keyed routing that survives
  DHCP changes.
• Works alongside the OS — your USB printer remains usable by Word, Notepad, and other apps.

What it does NOT do
-------------------
• It does not read or modify the contents of any web page beyond exchanging typed messages with
  the Khanpan POS at app.khanpan.app.
• It does not collect analytics, telemetry, or any usage data.
• It does not make network requests of its own.
• It does not access tabs, windows, browsing history, bookmarks, cookies, downloads, or the
  clipboard.

How it works (the technical bit, if you want it)
------------------------------------------------
The extension uses Chrome's Native Messaging API to talk to a tiny helper process called
"khanpan-printer-host" that you install separately. The helper accepts typed JSON requests from
the extension (print this payload, list printers, etc.) and forwards ESC/POS bytes to the
configured printer.

The helper:
• Listens only on stdio — it does NOT accept network connections.
• Runs as your user account — no admin privileges required.
• Is open source. You can read the entire ~30 KB bundle at
  https://github.com/khanpan/khanpan/blob/main/tools/khanpan-native-host/.

Permissions explained
---------------------
• "Communicate with cooperating native applications" (nativeMessaging) — required so the
  extension can launch and talk to the helper. The helper's name is hard-coded
  (com.khanpan.printer); no other native app can be reached.
• "Read and change your data on app.khanpan.app and localhost" — needed for a content script
  on the Khanpan POS page to bridge between the POS and the extension via postMessage. The
  content script does not read page contents; it only forwards typed messages.

Open source and privacy
-----------------------
Source code: https://github.com/khanpan/khanpan/tree/main/tools/khanpan-extension
Privacy policy: https://khanpan.app/privacy/printer-connector
Issues / support: support@khanpan.app

This extension is part of the Khanpan POS, a small-restaurant point-of-sale system built for
Indian restaurants and shops. If you're not already a Khanpan customer, this extension on its
own won't do anything — sign up at https://khanpan.app first.
```

---

## Single purpose statement (for the dev console form)

```
The single purpose of this extension is to act as a printer connector for the Khanpan
point-of-sale web app at app.khanpan.app. It lets the POS page send receipt and Kitchen Order
Ticket print jobs to a locally-installed native helper, which in turn drives the cashier's
thermal printer over USB, network, or Bluetooth. The extension performs no other function.
```

---

## Permission justifications (dev console form, per permission)

### nativeMessaging

```
Required to communicate with the "khanpan-printer-host" native helper that customers install
separately. The helper is the only program that can physically drive USB, network, or
Bluetooth thermal printers — Chrome itself cannot do this for network printers or for USB
Printer Class devices on Windows. The native messaging host name is hard-coded to
"com.khanpan.printer"; the extension cannot reach any other native program.
```

### host_permissions / activeTab (for app.khanpan.app)

```
The extension injects a content script into pages on https://app.khanpan.app/* (and
http://localhost:5173/* during development). The content script's only job is to forward
typed JSON messages between the POS page and the extension's service worker via
window.postMessage. It does not read page contents, form data, cookies, or DOM beyond this
postMessage handshake.
```

---

## Screenshots (1280×800 or 640×400; min 1, max 5)

The Chrome Web Store requires at least one. Recommended set:

1. **POS Settings → Printer panel** showing the extension's discovered printer in the candidate list with the "Extension · TCP" badge.
2. **Printer guide page (section 5)** showing the install-once flow.
3. **Test print confirmation** — the in-app success toast after a print.
4. (Optional) The Install command running in Terminal with the `✓ All set.` line.
5. (Optional) The extension popup showing the version readout.

Capture these on a clean desktop (Quicktime screen capture → crop to 1280×800).

Stored in `tools/khanpan-extension/web-store/screenshots/` once captured.

---

## Promo tile (440×280; optional but recommended)

A small marketing tile shown in store search results. Keep it text-light: the extension name in 24-32pt, the helper-process metaphor visualised (a small printer + a paired phone icon).

Stored as `tools/khanpan-extension/web-store/promo-tile.png` once designed.
