#!/usr/bin/env node
/**
 * Khanpan Printer Connector — native host installer (dev CLI).
 *
 * Thin wrapper around the install library that adds the bits a developer
 * needs but a customer doesn't:
 *   - Generates a per-OS shell wrapper that hardcodes the local node path
 *     (Chrome's launch context doesn't include nvm / Homebrew on PATH).
 *   - Runs a smoke test under Chrome's minimal env after registration.
 *
 * Customers don't run this. They double-click the .exe installer,
 * which drops the SEA-bundled binary in a fixed location and runs the
 * binary's `install` subcommand from its postinstall script.
 *
 * Usage:
 *   node install.mjs                       — install (auto-detect ID)
 *   node install.mjs --extension-id <ID>   — explicit ID
 *   node install.mjs --uninstall           — remove the registration
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runInstall, runUninstall, smokeTest } from "./lib-install.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_DIR = __dirname;
const HOST_JS = path.join(HOST_DIR, "host.mjs");
const EXTENSION_DIR = path.join(HOST_DIR, "..", "khanpan-extension");

// ── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { extensionId: null, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--extension-id" && argv[i + 1]) args.extensionId = argv[++i];
    else if (a.startsWith("--extension-id=")) args.extensionId = a.slice("--extension-id=".length);
    else if (a === "--uninstall") args.uninstall = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Khanpan native host installer (dev)

Usage:
  node install.mjs                          auto-detect extension ID, register host
  node install.mjs --extension-id <ID>      explicit ID
  node install.mjs --uninstall              remove the registration

This is the developer-flow installer. Customers install the .exe
which bundles the SEA binary and calls its built-in 'install' subcommand.`);
}

// ── Dev-only shim writer (hardcodes node path) ───────────────────────────────

function shellQuote(p) {
  return `'${p.replace(/'/g, `'"'"'`)}'`;
}

async function ensureDevHostExecutable() {
  if (process.platform === "win32") {
    const shim = path.join(HOST_DIR, "khanpan-native-host.bat");
    const script =
      ["@echo off", `node "%~dp0host.mjs" %*`].join("\r\n") + "\r\n";
    await fs.writeFile(shim, script, "utf8");
    return shim;
  }
  // Dev wrapper — hardcodes process.execPath because Chrome's
  // native-messaging launch context strips PATH.
  const shim = path.join(HOST_DIR, "khanpan-native-host.sh");
  const script =
    [
      "#!/bin/sh",
      "# Auto-generated dev wrapper. Chrome's native-messaging launch context",
      "# doesn't include nvm / Homebrew on PATH; we hardcode the node binary.",
      `exec ${shellQuote(process.execPath)} ${shellQuote(HOST_JS)} "$@"`,
    ].join("\n") + "\n";
  await fs.writeFile(shim, script, "utf8");
  await fs.chmod(shim, 0o755);
  return shim;
}

// ── Entry ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

(async () => {
  try {
    if (args.uninstall) {
      await runUninstall();
      console.log("\nNative host unregistered.");
      return;
    }

    const hostPath = await ensureDevHostExecutable();
    const result = await runInstall({
      ...(args.extensionId ? { extensionId: args.extensionId }: {}),
      extensionDir: EXTENSION_DIR,
      hostPath,
    });

    process.stdout.write("• smoke test … ");
    const probe = await smokeTest(hostPath);
    if (probe.ok) {
      console.log("ok");
    } else {
      console.log("FAILED");
      if (probe.message) console.error(`  ${probe.message}`);
      if (probe.stderr) console.error(`  stderr: ${probe.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    }

    console.log("");
    console.log(`Native host registered for extension ${result.extensionId}.`);
    console.log("Reload the extension in chrome://extensions/ if it was already running.");
  } catch (err) {
    console.error("install failed:", err?.message ?? err);
    process.exit(1);
  }
})();
