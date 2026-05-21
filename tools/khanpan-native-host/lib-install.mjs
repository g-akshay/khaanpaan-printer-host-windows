/**
 * Khanpan Printer Connector — install library.
 *
 * Pure functions for registering / unregistering the native messaging host
 * with Chrome on Windows. Imported by:
 *
 *   • `install.mjs`  — the dev CLI wrapper (`node install.mjs`)
 *   • `host.mjs`     — the SEA-bundled binary's argv dispatcher
 *                      (`khanpan-printer-host install`)
 *
 * Customer flow: the .exe installer drops the SEA binary in a
 * known location and its postinstall script runs `<binary> install`. No
 * terminal access required from the customer.
 *
 * Dev flow: `node tools/khanpan-native-host/install.mjs` calls the same
 * functions, but also generates a shell wrapper that hardcodes the
 * developer's local node path (Chrome's launch PATH doesn't include
 * nvm / Homebrew).
 */

import { exec, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const HOST_NAME = "com.khanpan.printer";
export const HOST_DESCRIPTION = "Khanpan Printer Connector native host";

// ── Per-OS native messaging manifest location ────────────────────────────────

export function chromeNativeMessagingDir() {
  const platform = process.platform;
  const home = os.homedir();
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
    );
  }
  if (platform === "linux") {
    return path.join(home, ".config", "google-chrome", "NativeMessagingHosts");
  }
  if (platform === "win32") {
    // Chrome on Windows reads the manifest path from the registry, not from a
    // fixed directory. We drop the JSON next to the host for inspection; the
    // registry value is the source of truth.
    return null; // caller decides
  }
  throw new Error(`unsupported platform: ${platform}`);
}

export function buildManifest(extensionId, hostPath) {
  return {
    name: HOST_NAME,
    description: HOST_DESCRIPTION,
    path: hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

// ── Chromium-family browser layout helpers ───────────────────────────────────

export function chromiumBrowserBases() {
  const home = os.homedir();
  const platform = process.platform;
  if (platform === "darwin") {
    const lib = path.join(home, "Library", "Application Support");
    return [
      ["Chrome",        path.join(lib, "Google", "Chrome")],
      ["Chrome Canary", path.join(lib, "Google", "Chrome Canary")],
      ["Edge",          path.join(lib, "Microsoft Edge")],
      ["Brave",         path.join(lib, "BraveSoftware", "Brave-Browser")],
      ["Chromium",      path.join(lib, "Chromium")],
      ["Arc",           path.join(lib, "Arc", "User Data")],
      ["Vivaldi",       path.join(lib, "Vivaldi")],
    ];
  }
  if (platform === "linux") {
    const cfg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    return [
      ["Chrome",   path.join(cfg, "google-chrome")],
      ["Edge",     path.join(cfg, "microsoft-edge")],
      ["Brave",    path.join(cfg, "BraveSoftware", "Brave-Browser")],
      ["Chromium", path.join(cfg, "chromium")],
      ["Vivaldi",  path.join(cfg, "vivaldi")],
    ];
  }
  if (platform === "win32") {
    const lad = process.env.LOCALAPPDATA;
    if (!lad) return [];
    return [
      ["Chrome",   path.join(lad, "Google", "Chrome", "User Data")],
      ["Edge",     path.join(lad, "Microsoft", "Edge", "User Data")],
      ["Brave",    path.join(lad, "BraveSoftware", "Brave-Browser", "User Data")],
      ["Chromium", path.join(lad, "Chromium", "User Data")],
      ["Vivaldi",  path.join(lad, "Vivaldi", "User Data")],
    ];
  }
  return [];
}

/**
 * Scans every Chromium-family browser profile for the unpacked extension and
 * returns its ID. Returns null when not found, throws when multiple profiles
 * have it loaded and we cannot pick deterministically.
 */
export async function autoDetectExtensionId({ extensionDir }) {
  const target = path.resolve(extensionDir);
  const matches = [];

  for (const [browser, base] of chromiumBrowserBases()) {
    let entries;
    try {
      entries = await fs.readdir(base);
    } catch {
      continue;
    }
    const profiles = entries.filter((e) => e === "Default" || /^Profile /.test(e));
    for (const profile of profiles) {
      for (const fname of ["Secure Preferences", "Preferences"]) {
        const p = path.join(base, profile, fname);
        let raw;
        try {
          raw = await fs.readFile(p, "utf8");
        } catch {
          continue;
        }
        let prefs;
        try {
          prefs = JSON.parse(raw);
        } catch {
          continue;
        }
        const settings = prefs?.extensions?.settings ?? {};
        for (const [id, entry] of Object.entries(settings)) {
          if (typeof entry?.path !== "string") continue;
          if (path.resolve(entry.path) !== target) continue;
          if (!/^[a-p]{32}$/i.test(id)) continue;
          matches.push({ browser, profile, file: fname, id });
        }
      }
    }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const preferred = matches.find((m) => m.browser === "Chrome" && m.profile === "Default");
  if (preferred) return preferred;
  throw new Error(
    `Found the extension in multiple browser profiles — pass --extension-id explicitly:\n  ` +
      matches.map((m) => `${m.browser} / ${m.profile}: ${m.id}`).join("\n  "),
  );
}

// ── Manifest write / delete ──────────────────────────────────────────────────

export async function writeManifest(manifest, { winDir } = {}) {
  const dir =
    process.platform === "win32" ? winDir: chromeNativeMessagingDir();
  if (!dir) throw new Error("native messaging dir not resolved");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${HOST_NAME}.json`);
  await fs.writeFile(target, JSON.stringify(manifest, null, 2), "utf8");
  return target;
}

export async function writeWindowsRegistry(manifestPath) {
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  await execAsync(
    `reg.exe ADD "${key}" /ve /t REG_SZ /d "${manifestPath}" /f`,
  );
  return key;
}

export async function deleteWindowsRegistry() {
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  await execAsync(`reg.exe DELETE "${key}" /f`).catch(() => {
    /* already absent */
  });
}

// ── Smoke test ───────────────────────────────────────────────────────────────

export async function smokeTest(hostPath, log = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(hostPath, [`chrome-extension://smoke-test/`], {
      env: { HOME: process.env.HOME ?? "/tmp", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let inbuf = Buffer.alloc(0);
    let done = false;
    const finish = (ok, message) => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* */
      }
      if (!ok) {
        log("smoke test failed", message);
        if (stderr.trim()) log("host stderr", stderr.trim().split("\n").slice(-3).join(" | "));
      }
      resolve({ ok, message: message ?? null, stderr });
    };

    child.stderr?.on("data", (c) => (stderr += c.toString()));

    child.stdout?.on("data", (chunk) => {
      inbuf = Buffer.concat([inbuf, chunk]);
      if (inbuf.length < 4) return;
      const len = inbuf.readUInt32LE(0);
      if (inbuf.length < 4 + len) return;
      const body = inbuf.subarray(4, 4 + len).toString("utf8");
      try {
        const msg = JSON.parse(body);
        if (msg.ok === true) finish(true);
        else finish(false, `host responded: ${body}`);
      } catch {
        finish(false, `host wrote unparseable JSON: ${body.slice(0, 100)}`);
      }
    });

    child.on("error", (err) => finish(false, `spawn failed: ${err.message}`));
    child.on("exit", (code, signal) => {
      if (done) return;
      finish(false, `host exited before responding (code=${code}, signal=${signal ?? "none"})`);
    });

    const body = Buffer.from(JSON.stringify({ id: "install-smoke", op: "ping" }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    child.stdin?.write(Buffer.concat([header, body]));

    setTimeout(() => finish(false, "host did not respond within 3 s"), 3000);
  });
}

// ── Main install / uninstall flows ───────────────────────────────────────────

/**
 * Register the native host with Chrome.
 *
 * @param {Object} opts
 * @param {string} [opts.extensionId] — explicit extension ID. Auto-detected if omitted.
 * @param {string} [opts.extensionDir] — path to the unpacked extension dir, for auto-detect. Required when extensionId is omitted.
 * @param {string} [opts.hostPath] — absolute path of the executable Chrome should launch. Defaults to process.execPath (which is the SEA binary when running bundled).
 * @param {Function} [opts.log] — printer (defaults to console.log).
 */
export async function runInstall({ extensionId, extensionDir, hostPath, log = console.log } = {}) {
  let resolvedId = extensionId;
  if (!resolvedId) {
    if (!extensionDir) {
      throw new Error("runInstall: extensionDir is required when extensionId is not supplied");
    }
    log("• auto-detecting extension …");
    const detected = await autoDetectExtensionId({ extensionDir });
    if (!detected) {
      throw new Error(
        `Could not find the Khanpan Printer Connector in any Chromium browser profile.
Load the unpacked extension first (chrome://extensions/ → Load unpacked → ${extensionDir}),
or pass --extension-id explicitly.`,
      );
    }
    resolvedId = detected.id;
    log(`  found ${detected.id}  (${detected.browser} / ${detected.profile})`);
  } else if (!/^[a-p]{32}$/i.test(resolvedId)) {
    throw new Error(
      `extensionId must be the 32-character ID Chrome shows in chrome://extensions/. Got: "${resolvedId}"`,
    );
  }

  const finalHostPath = hostPath ?? process.execPath;
  const manifest = buildManifest(resolvedId, finalHostPath);
  const manifestPath = await writeManifest(manifest);

  log(`✓ host:          ${finalHostPath}`);
  log(`✓ manifest JSON: ${manifestPath}`);

  if (process.platform === "win32") {
    const key = await writeWindowsRegistry(manifestPath);
    log(`✓ registry key:  ${key}`);
  }

  return { extensionId: resolvedId, manifestPath, hostPath: finalHostPath };
}

export async function runUninstall({ log = console.log } = {}) {
  const dir = chromeNativeMessagingDir();
  if (dir) {
    const manifestPath = path.join(dir, `${HOST_NAME}.json`);
    await fs.unlink(manifestPath).catch(() => {});
    log(`✓ removed ${manifestPath}`);
  }
  if (process.platform === "win32") {
    await deleteWindowsRegistry();
    log("✓ removed HKCU registry key");
  }
}
