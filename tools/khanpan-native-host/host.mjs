#!/usr/bin/env node
/**
 * Khanpan Printer Connector — native messaging host (Phase 1).
 *
 * Spawned by Chrome when the extension's service worker calls
 * `chrome.runtime.connectNative("com.khanpan.printer")`. Communicates with
 * Chrome via stdin/stdout using the standard native messaging framing:
 *   - 4 bytes little-endian uint32 length prefix
 *   - then UTF-8 JSON body (≤ 1 MiB)
 *
 * IMPORTANT: never write to stdout outside the framing. All logs go to stderr
 * (Chrome captures them per the documented host-log file).
 *
 * Phase 1 surface:
 *   op = "ping"          → liveness
 *   op = "list_printers" → discovered LAN printers
 *   op = "print"         → forward ESC/POS bytes to a printer over TCP
 *   op = "test_print"    → forward a transport-supplied test payload
 *   op = "open_drawer"   → ESC p 0 25 250 (kick) — TCP only in phase 1
 *
 * Discovery: scans the local /24 subnet for TCP port 9100 every 30 s, reads
 * the OS ARP table to derive a MAC-based stable id per printer. The MAC keeps
 * routes valid across DHCP renewals — same property as the MVP bridge.
 *
 * Phase 2+ adds USB Printer Class, serial, Bluetooth — out of scope here.
 */

import { exec } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runInstall, runUninstall } from "./lib-install.mjs";
import {
  discoverSerialPorts,
  printToSerial,
} from "./transports-serial.mjs";
import {
  discoverWindowsPrinters,
  printToWindowsUsb,
} from "./transports-usb-windows.mjs";

const execAsync = promisify(exec);

// ── Argv dispatch ────────────────────────────────────────────────────────────
//
// When invoked with no args (or with a `chrome-extension://...` origin as the
// only arg — Chrome's launch convention), run as a native messaging host.
// Otherwise dispatch to install / uninstall. Same binary handles all three
// modes so the .exe installer only ships one executable.
//
// We use .then() rather than top-level await so esbuild can bundle this as
// CommonJS for the Node SEA build pipeline.

const subcommand = process.argv[2];
if (subcommand === "install" || subcommand === "uninstall") {
  runSubcommand(subcommand)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("install failed:", err?.message ?? err);
      process.exit(1);
    });
  // Suspend further module execution while the subcommand runs.
  // (process.exit() inside the .then handler unwinds the process.)
}

// ── Configuration ────────────────────────────────────────────────────────────

const VERSION = "0.1.0";
const MAX_MSG_BYTES = 1024 * 1024;
const SCAN_INTERVAL_MS = 30_000;
const CONNECT_TIMEOUT_MS = 400;
const PRINT_TIMEOUT_MS = 8_000;
const PRINTER_TTL_MS = 5 * 60_000;
const IDEMPOTENCY_TTL_MS = 60_000;

function log(...args) {
  // eslint-disable-next-line no-console
  console.error("[khanpan-host]", ...args);
}

/** Detect whether this process is running as a SEA-bundled binary by checking
 *  whether `process.execPath` is still pointing at a Node binary. When we
 *  ship, the SEA executable is renamed to `khanpan-printer-host[.exe]`. */
function isRunningAsSea() {
  return typeof process.execPath === "string" && !/\bnode(\.exe)?$/i.test(process.execPath);
}

async function runSubcommand(name) {
  // Parse the same args that install.mjs's CLI accepts, so the binary's
  // built-in subcommand is interchangeable with `node install.mjs`.
  const rest = process.argv.slice(3);
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--extension-id" && rest[i + 1]) opts.extensionId = rest[++i];
    else if (rest[i].startsWith("--extension-id=")) opts.extensionId = rest[i].slice(15);
    else if (rest[i] === "--extension-dir" && rest[i + 1]) opts.extensionDir = rest[++i];
    else if (rest[i].startsWith("--extension-dir=")) opts.extensionDir = rest[i].slice(16);
  }
  if (name === "uninstall") {
    await runUninstall();
    return;
  }
  // Default extension-dir resolution:
  //   - Dev (`node host.mjs install`): use the script's location → repo's
  //     `tools/khanpan-extension/`.
  //   - SEA-bundled binary: the .exe postinstall passes
  //     `--extension-dir` explicitly. If it doesn't, fall back to a sibling
  //     of the binary (useful when shipping the extension alongside).
  // In the CJS-bundled SEA build `import.meta.url` is empty (esbuild strips
  // it); we never need it there because the SEA path uses process.execPath.
  // In ESM dev mode `import.meta.url` is the script's file:// URL.
  let baseDir;
  if (isRunningAsSea()) {
    baseDir = path.dirname(process.execPath);
  } else {
    const metaUrl = import.meta.url;
    baseDir = metaUrl ? path.dirname(fileURLToPath(metaUrl)): process.cwd();
  }
  const fallbackExtensionDir =
    opts.extensionDir ?? path.resolve(baseDir, "..", "khanpan-extension");
  // KHANPAN_HOST_PATH is set by the shipped wrapper script (writeWrapper in
  // build.mjs) — it tells us what path Chrome should launch. When unset we
  // are running directly under node (dev) and process.execPath is the right
  // thing to register.
  const hostPath = process.env.KHANPAN_HOST_PATH ?? process.execPath;
  await runInstall({
    ...opts,
    extensionDir: fallbackExtensionDir,
    hostPath,
  });
}

// ── stdin framing ────────────────────────────────────────────────────────────

let inbuf = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MSG_BYTES) {
    log("response too large; dropping", { id: message?.id, bytes: body.length });
    return;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  // Write atomically so partial header+body never interleave across send() calls.
  process.stdout.write(Buffer.concat([header, body]));
}

function consume() {
  while (true) {
    if (inbuf.length < 4) return;
    const len = inbuf.readUInt32LE(0);
    if (len > MAX_MSG_BYTES) {
      log("oversize inbound frame; closing", { bytes: len });
      process.exit(1);
    }
    if (inbuf.length < 4 + len) return;
    const body = inbuf.subarray(4, 4 + len);
    inbuf = inbuf.subarray(4 + len);
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch (err) {
      log("malformed JSON; ignoring", err?.message);
      continue;
    }
    handleMessage(parsed).catch((err) => {
      log("unhandled error", err);
      send({
        id: parsed?.id ?? null,
        ok: false,
        reason: "error",
        message: String(err?.message ?? err),
      });
    });
  }
}

function startNativeHost() {
  process.stdin.on("data", (chunk) => {
    inbuf = Buffer.concat([inbuf, chunk]);
    consume();
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", (err) => {
    log("stdin error", err);
    process.exit(1);
  });

  log(`Khanpan native host v${VERSION} starting on ${process.platform}`);
  // Initial discovery happens asynchronously so we don't block the first ping.
  discover().catch((err) => log("discover error", err));
  setInterval(() => {
    discover().catch((err) => log("discover error", err));
  }, SCAN_INTERVAL_MS);
}

// ── Discovery (TCP /24 scan + ARP for MAC) ───────────────────────────────────

/** id → { id, name, ip, lastSeen } */
const printers = new Map();

function listLocalSubnets() {
  // Returns array of "a.b.c" for non-internal IPv4 /24 interfaces. /16 and
  // other prefixes are out of scope — scanning 65k hosts isn't worth it for
  // small-shop networks.
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && a.netmask === "255.255.255.0") {
        const [a1, a2, a3] = a.address.split(".");
        out.push(`${a1}.${a2}.${a3}`);
      }
    }
  }
  return out;
}

function probeIp(ip) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port: 9100 });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, CONNECT_TIMEOUT_MS);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function arpTable() {
  // Returns Map<ip, mac-colon-lower>. Uses the OS `arp -a` command.
  try {
    const { stdout } = await execAsync("arp -a");
    const map = new Map();
    const macRe =
      /(\d+\.\d+\.\d+\.\d+)\s+([\da-f]{2}[:-][\da-f]{2}[:-][\da-f]{2}[:-][\da-f]{2}[:-][\da-f]{2}[:-][\da-f]{2})/i;
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(macRe);
      if (m) map.set(m[1], m[2].toLowerCase().replace(/-/g, ":"));
    }
    return map;
  } catch {
    return new Map();
  }
}

async function discover() {
  // Phase 2 — Windows USB Printer Class via Print Spooler.
  const usbDiscovered = await discoverWindowsPrinters().catch((err) => {
    log("usb discover error", err?.message ?? err);
    return [];
  });
  // Phase 3 — OS-visible serial ports (USB-Serial chips + BT-paired virtual COM).
  const serialDiscovered = await discoverSerialPorts().catch((err) => {
    log("serial discover error", err?.message ?? err);
    return [];
  });
  const now0 = Date.now();
  for (const p of usbDiscovered) {
    printers.set(p.id, {
      id: p.id,
      name: p.name,
      ip: null,
      transport: "usb",
      defaultColumns: p.default_columns,
      lastSeen: now0,
    });
  }
  for (const p of serialDiscovered) {
    printers.set(p.id, {
      id: p.id,
      name: p.name,
      ip: null,
      path: p._path,
      transport: "serial",
      defaultColumns: p.default_columns,
      lastSeen: now0,
    });
  }

  const subnets = listLocalSubnets();
  if (subnets.length === 0) {
    if (usbDiscovered.length === 0) log("discover: no usable /24 interface");
    return;
  }
  const candidates = [];
  for (const sub of subnets) {
    for (let i = 1; i <= 254; i++) candidates.push(`${sub}.${i}`);
  }
  const hits = (
    await Promise.all(
      candidates.map(async (ip) => ((await probeIp(ip)) ? ip: null)),
    )
  ).filter((x) => x !== null);
  // After probe, the OS has each hit in its ARP cache.
  const arp = await arpTable();
  const now = Date.now();
  for (const ip of hits) {
    const mac = arp.get(ip);
    if (!mac) continue;
    const id = `tcp-${mac.replace(/:/g, "")}`;
    const existing = printers.get(id);
    printers.set(id, {
      id,
      name: existing?.name ?? `LAN Printer (${ip})`,
      ip,
      lastSeen: now,
    });
  }
  for (const [id, p] of printers) {
    if (now - p.lastSeen > PRINTER_TTL_MS) printers.delete(id);
  }
  log(`discover: ${printers.size} printer(s) cached`);
}

// ── Idempotency cache ────────────────────────────────────────────────────────

const idempotency = new Map(); // mutationId → { time, result }

function getCachedResult(mutationId) {
  if (!mutationId) return null;
  const entry = idempotency.get(mutationId);
  if (!entry) return null;
  if (Date.now() - entry.time > IDEMPOTENCY_TTL_MS) {
    idempotency.delete(mutationId);
    return null;
  }
  return entry.result;
}

function rememberResult(mutationId, result) {
  if (!mutationId) return;
  idempotency.set(mutationId, { time: Date.now(), result });
}

// ── TCP send ─────────────────────────────────────────────────────────────────

function sendToPrinter(ip, bytes) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: ip, port: 9100 });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`print timeout (${ip}:9100)`));
    }, PRINT_TIMEOUT_MS);
    sock.once("connect", () => {
      sock.end(bytes, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── ESC/POS test pattern ─────────────────────────────────────────────────────

function buildTestBytes() {
  return Buffer.from([
    0x1b, 0x40, // ESC @  init
    0x1b, 0x45, 0x01, // ESC E 1  bold on
    ...Buffer.from("Khanpan Native Host OK\n", "ascii"),
    0x1b, 0x45, 0x00, // bold off
    ...Buffer.from("Connected via Chrome extension\n\n\n", "ascii"),
    0x1d, 0x56, 0x00, // GS V 0  full cut
  ]);
}

// ── Transport dispatch ───────────────────────────────────────────────────────

/** Routes a print operation to the right transport based on the printer
 *  entry's `transport` field. Keeps the op handlers transport-agnostic. */
async function dispatchPrint(printer, bytes) {
  if (printer.transport === "usb") {
    await printToWindowsUsb(printer.id, bytes);
    return;
  }
  if (printer.transport === "serial") {
    if (!printer.path) throw new Error(`serial printer ${printer.id} has no path`);
    await printToSerial(printer.path, bytes);
    return;
  }
  // Default: TCP (preserves Phase 1 behaviour).
  if (!printer.ip) throw new Error(`TCP printer ${printer.id} has no IP`);
  await sendToPrinter(printer.ip, bytes);
}

// ── Op handlers ──────────────────────────────────────────────────────────────

function ok(id, result) {
  return { id, ok: true, ...(result === undefined ? {}: { result }) };
}

function fail(id, reason, message) {
  return { id, ok: false, reason, message };
}

async function handleMessage(msg) {
  const { id, op } = msg ?? {};
  if (typeof id !== "string" || typeof op !== "string") {
    log("missing id/op; dropping");
    return;
  }

  switch (op) {
    case "ping":
      send(
        ok(id, {
          version: VERSION,
          platform: process.platform,
          uptime_s: Math.round(process.uptime()),
          printers_detected: printers.size,
        }),
      );
      return;

    case "list_printers": {
      const list = [...printers.values()].map((p) => ({
        id: p.id,
        name: p.name,
        transport: p.transport ?? "tcp",
        status: "ready",
        default_columns: p.defaultColumns ?? 80,
        supports: ["cut"],
      }));
      send(ok(id, { printers: list }));
      return;
    }

    case "print": {
      const { printer_id, payload_b64, client_mutation_id } = msg;
      if (typeof printer_id !== "string" || typeof payload_b64 !== "string") {
        send(fail(id, "error", "missing printer_id or payload_b64"));
        return;
      }
      const cached = getCachedResult(client_mutation_id);
      if (cached) {
        send({ id, ...cached });
        return;
      }
      const printer = printers.get(printer_id);
      if (!printer) {
        const result = fail(id, "no_printer", `printer ${printer_id} not found`);
        send(result);
        return;
      }
      try {
        await dispatchPrint(printer, Buffer.from(payload_b64, "base64"));
        const result = ok(id);
        rememberResult(client_mutation_id, result);
        send(result);
      } catch (err) {
        send(fail(id, "error", err?.message ?? "print failed"));
      }
      return;
    }

    case "test_print": {
      const { printer_id, payload_b64 } = msg;
      const printer = printers.get(printer_id);
      if (!printer) {
        send(fail(id, "no_printer", `printer ${printer_id} not found`));
        return;
      }
      const bytes = payload_b64
        ? Buffer.from(payload_b64, "base64")
: buildTestBytes();
      try {
        await dispatchPrint(printer, bytes);
        send(ok(id));
      } catch (err) {
        send(fail(id, "error", err?.message ?? "test print failed"));
      }
      return;
    }

    case "open_drawer": {
      const { printer_id } = msg;
      const printer = printers.get(printer_id);
      if (!printer) {
        send(fail(id, "no_printer", `printer ${printer_id} not found`));
        return;
      }
      // Standard drawer kick: ESC p 0 25 250
      const bytes = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
      try {
        await dispatchPrint(printer, bytes);
        send(ok(id));
      } catch (err) {
        send(fail(id, "error", err?.message ?? "drawer kick failed"));
      }
      return;
    }

    default:
      send(fail(id, "error", `unknown op: ${op}`));
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
//
// Skipped when the binary was invoked as `install` / `uninstall` (the dispatch
// at the top of the file kicked off `runSubcommand` and exits on completion).

if (subcommand !== "install" && subcommand !== "uninstall") {
  startNativeHost();
}
