# Khanpan Printer Connector — Chrome extension

Phase 1 vertical slice per the architecture overview in this repo's README. Manifest v3 extension that bridges the POS page to the local [`khanpan-native-host`](../khanpan-native-host/README.md) binary via Chrome native messaging.

## Architecture

```
POS page  ─postMessage─>  content_script.js  ─sendMessage─>  service_worker.js  ─stdio JSON─>  native host  ─OS APIs─>  Printer
```

- `manifest.json` — MV3; declares the native messaging permission and the POS origins (`https://app.khanpan.app`, `localhost:5173`, `localhost:5174`) it injects into.
- `service_worker.js` — owns the persistent native messaging port; routes per-`id` requests/responses.
- `content_script.js` — runs at `document_start`, injects a tiny main-world script that sets `window.__khanpanExtension = { version, ready: true }`, then bridges `postMessage` ↔ `chrome.runtime.sendMessage`.
- `popup.html` / `popup.js` — minimal toolbar popup, version readout. Cosmetic for now.
- `icons/` — placeholder 1×1 PNGs. **Replace with real artwork before Web Store submission.**

## Local development install

1. Build / install the native host first (see `tools/khanpan-native-host/README.md`).
2. Open `chrome://extensions/`. Toggle **Developer mode** on (top-right).
3. **Load unpacked** → pick this directory (`tools/khanpan-extension/`).
4. Note the extension ID Chrome assigns (it appears under the loaded extension card). The native host installer needs it on first install — see the native-host README.
5. Open the POS at `http://localhost:5173`. Settings → Printer should show the extension transport as a candidate.

## Reload after edits

For changes to `manifest.json`, `service_worker.js`, or `content_script.js`, click the **Reload** button on the extension card in `chrome://extensions/`. The content script also needs the host page to be reloaded (manifest v3 doesn't auto-re-inject).

## Production submission (later)

- Replace placeholder icons.
- Lock `host_permissions` to `https://app.khanpan.app/*` only (drop the localhost entries).
- Bump version in `manifest.json`.
- Bundle as `.zip` of this directory.
- Submit to the Chrome Web Store at https://chrome.google.com/webstore/devconsole.
