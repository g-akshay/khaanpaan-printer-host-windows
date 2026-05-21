/**
 * Serial transport — Phase 3.
 *
 * Sends ESC/POS bytes to:
 *   - USB-Serial chips (CH340 / PL2303 / FTDI), which most cheap thermal
 *     printers from generic Chinese vendors use.
 *   - Bluetooth Classic printers exposed as virtual COM ports.
 *
 * Uses the `serialport` npm package (native bindings; the package carries
 * .node files so esbuild marks it as `external` and build.mjs copies the
 * package's runtime dir alongside the bundle).
 *
 * Stable IDs (so a saved printer route survives router restarts / OS port
 * re-numbering):
 *   - USB-Serial: `serial-${vid}-${pid}` (hex, zero-padded). Identical to
 *     the legacy WebSerial path so existing routes still resolve.
 *   - Anonymous (BT virtual COM): `serial-anon-${pathHash}` —
 *     hash of the device path so the same COM keeps the same ID across
 *     runs (e.g. COM3 → "COM3" → same hash across restarts).
 *
 * Defaults to 9600/8N1 — the de-facto baud for thermal printers built on
 * CH340 / PL2303 / SPP modules. Tracked behind the printer's `metadata` if
 * we need per-printer overrides later.
 */

import { createHash } from "node:crypto";

let serialportModule = null;
let serialportImportError = null;

/**
 * Lazy-load serialport. The package has native bindings — we import on
 * first use so the rest of the host stays functional even if the bundle
 * was built without platform-matching prebuilds (cross-compile case).
 */
async function getSerialPort() {
  if (serialportModule) return serialportModule;
  if (serialportImportError) throw serialportImportError;
  try {
    serialportModule = await import("serialport");
    return serialportModule;
  } catch (err) {
    serialportImportError = new Error(
      `serial transport unavailable: ${err?.message ?? err}. Did the bundle ship serialport for this OS/arch?`,
    );
    throw serialportImportError;
  }
}

// ── Stable ID helpers ────────────────────────────────────────────────────────

function pathHash(devicePath) {
  return createHash("sha1").update(devicePath).digest("hex").slice(0, 12);
}

function deriveId(portInfo) {
  const vid = portInfo.vendorId;
  const pid = portInfo.productId;
  if (vid && pid) {
    const v = vid.toString(16).toLowerCase().padStart(4, "0");
    const p = pid.toString(16).toLowerCase().padStart(4, "0");
    return `serial-${v}-${p}`;
  }
  return `serial-anon-${pathHash(portInfo.path)}`;
}

function deriveName(portInfo) {
  // Try to surface something useful. SerialPort.list() returns:
  //   { path, manufacturer, serialNumber, pnpId, locationId, vendorId, productId }
  if (portInfo.manufacturer) return `${portInfo.manufacturer} (${portInfo.path})`;
  if (portInfo.pnpId) return `Serial Printer (${portInfo.path})`;
  return `Serial Printer (${portInfo.path})`;
}

// ── Discovery ────────────────────────────────────────────────────────────────

export async function discoverSerialPorts() {
  let sp;
  try {
    sp = await getSerialPort();
  } catch {
    return [];
  }
  let ports = [];
  try {
    ports = await sp.SerialPort.list();
  } catch {
    return [];
  }
  return ports.map((p) => ({
    id: deriveId(p),
    name: deriveName(p),
    transport: "serial",
    status: "ready",
    default_columns: 80,
    supports: ["cut"],
    // Internal-only fields kept for the print path; not surfaced in the
    // BridgePrinter shape to the POS.
    _path: p.path,
    _vendorId: p.vendorId ?? null,
    _productId: p.productId ?? null,
  }));
}

// ── Print ────────────────────────────────────────────────────────────────────

const BAUD_RATE = 9600;

export async function printToSerial(portPath, bytes) {
  const sp = await getSerialPort();
  return new Promise((resolve, reject) => {
    const port = new sp.SerialPort(
      {
        path: portPath,
        baudRate: BAUD_RATE,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        autoOpen: false,
      },
      (err) => {
        if (err) {
          reject(new Error(`serial open failed (${portPath}): ${err.message}`));
        }
      },
    );

    const cleanup = () => {
      try {
        if (port.isOpen) port.close();
      } catch {
        /* */
      }
    };

    port.open((openErr) => {
      if (openErr) {
        reject(new Error(`serial open failed (${portPath}): ${openErr.message}`));
        return;
      }
      port.write(bytes, (writeErr) => {
        if (writeErr) {
          cleanup();
          reject(new Error(`serial write failed (${portPath}): ${writeErr.message}`));
          return;
        }
        port.drain((drainErr) => {
          cleanup();
          if (drainErr) {
            reject(new Error(`serial drain failed (${portPath}): ${drainErr.message}`));
            return;
          }
          resolve();
        });
      });
    });

    port.on("error", (err) => {
      cleanup();
      reject(new Error(`serial port error (${portPath}): ${err.message}`));
    });
  });
}
