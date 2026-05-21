/**
 * Khanpan Printer Connector — content script.
 *
 * Bridges the POS page (running in the main world) to the extension's service
 * worker (running in the extension context). The transport on the POS side
 * (packages/ui/src/print/transports/extension.ts) talks to us via
 * `window.postMessage`; we forward to the SW via `chrome.runtime.sendMessage`
 * and echo the response back through `postMessage`.
 *
 * Announcement: on document_start we inject a tiny script into the main world
 * that sets `window.__khanpanExtension = { version, ready: true }`. The POS
 * feature-detects via this global to decide whether to expose the extension
 * transport in the printer picker.
 */

const ALLOWED_ORIGIN = window.location.origin;

// ── Announcement (runs in main world) ────────────────────────────────────────
//
// Content scripts live in an isolated world — assignments to `window` here
// are NOT visible to the page. We need a <script> in the main world to set
// the announcement global.
//
// We MUST NOT use `script.textContent = ...` here: the POS pages ship a strict
// CSP that forbids inline scripts (no `unsafe-inline`, no hash, no nonce).
// Chrome automatically adds the extension's origin to the page's `script-src`
// at run-time, so an external script loaded from `chrome-extension://<ID>/...`
// IS allowed. We pull the URL via `chrome.runtime.getURL()` (works because
// `inject.js` is declared in `web_accessible_resources`).

(function announce() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.async = false;
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
})();

// ── Request bridge: page → SW ────────────────────────────────────────────────

window.addEventListener("message", (event) => {
  // postMessage delivers messages from same-origin frames too; we only accept
  // messages originating from the same window object.
  if (event.source !== window) return;
  if (event.origin !== ALLOWED_ORIGIN) return;
  const data = event.data;
  if (!data || data.kp !== "req" || typeof data.id !== "string") return;

  const replyId = data.id;
  const payload = data.payload;

  chrome.runtime.sendMessage(payload, (response) => {
    // chrome.runtime.lastError fires when the SW was killed mid-call; we surface
    // it as a plain TransportError-shaped failure.
    const lastErr = chrome.runtime.lastError;
    if (lastErr) {
      window.postMessage(
        {
          kp: "res",
          id: replyId,
          response: {
            ok: false,
            reason: "error",
            message: lastErr.message || "extension messaging failed",
          },
        },
        ALLOWED_ORIGIN,
      );
      return;
    }
    window.postMessage(
      { kp: "res", id: replyId, response },
      ALLOWED_ORIGIN,
    );
  });
});
