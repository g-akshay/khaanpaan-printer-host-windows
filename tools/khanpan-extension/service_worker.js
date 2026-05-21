/**
 * Khanpan Printer Connector — service worker (Manifest v3).
 *
 * Owns the persistent native-messaging port to the Khanpan native host. Acts
 * as a router between content scripts on the POS origin and the host process.
 *
 * Protocol: messages from the content script are forwarded verbatim with an
 * `id` field; the host echoes the same `id` so we can pair request/response
 * across the async port.
 *
 * Service-worker lifecycle note: MV3 SWs are terminated by Chrome after a few
 * minutes of inactivity. When that happens, `chrome.runtime.connectNative` is
 * torn down and the host process exits. The next inbound request from the
 * content script re-spawns this SW and we re-connect lazily.
 */

const NATIVE_HOST = "com.khanpan.printer";

/** Active port to the native host (or null if disconnected / not yet opened). */
let nativePort = null;

/** id → sendResponse callback. Cleared on response or onDisconnect. */
const pending = new Map();

/**
 * Lazily open the native-messaging port. Throws if Chrome cannot launch the
 * host (host not installed, manifest missing, etc.) — the caller surfaces
 * that error to the content script.
 */
function ensurePort() {
  if (nativePort) return nativePort;

  nativePort = chrome.runtime.connectNative(NATIVE_HOST);

  nativePort.onMessage.addListener((msg) => {
    if (!msg || typeof msg.id !== "string") return;
    const responder = pending.get(msg.id);
    if (!responder) return;
    pending.delete(msg.id);
    responder(msg);
  });

  nativePort.onDisconnect.addListener(() => {
    const errMsg =
      chrome.runtime.lastError?.message ?? "native host disconnected";
    // Reject every pending request with the disconnect error.
    for (const [, responder] of pending) {
      responder({
        ok: false,
        reason: "error",
        message: errMsg,
      });
    }
    pending.clear();
    nativePort = null;
  });

  return nativePort;
}

/**
 * Content scripts (and only them, since externally_connectable is not set)
 * post requests through chrome.runtime.sendMessage. Each request is forwarded
 * to the native host and the host's response is returned via sendResponse.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only accept messages from our own content scripts. The sender.url should
  // match one of the host_permissions origins.
  if (!sender || !sender.url) {
    sendResponse({ ok: false, reason: "error", message: "no sender url" });
    return false;
  }

  // Generate a per-request id so the host can pair responses.
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());

  pending.set(id, sendResponse);

  try {
    const port = ensurePort();
    port.postMessage({ id, ...request });
  } catch (err) {
    pending.delete(id);
    sendResponse({
      ok: false,
      reason: "error",
      message:
        err && err.message
          ? `Native host launch failed: ${err.message}`
          : "Native host launch failed.",
    });
    return false;
  }

  // Keep the message channel open until we call sendResponse asynchronously.
  return true;
});
