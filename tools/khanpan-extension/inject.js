/**
 * Khanpan Printer Connector — page-world announcement script.
 *
 * The content script appends this file to the page via
 *   <script src="chrome-extension://EXTENSION_ID/inject.js">.
 * That URL is allowed by Chrome's automatic CSP extension (it adds the
 * extension origin to `script-src`), so this works even on POS pages whose
 * own CSP forbids inline scripts.
 *
 * Sets `window.__khanpanExtension` so the POS can feature-detect synchronously
 * and fires a one-shot `khanpanExtensionReady` event for late observers.
 */
(function () {
  if (window.__khanpanExtension) return;
  // Keep this version in sync with manifest.json. Bumped together at release.
  const VERSION = "0.1.0";
  Object.defineProperty(window, "__khanpanExtension", {
    value: { version: VERSION, ready: true },
    writable: false,
    configurable: false,
  });
  window.dispatchEvent(new Event("khanpanExtensionReady"));
})();
