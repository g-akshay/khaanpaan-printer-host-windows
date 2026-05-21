#!/usr/bin/env node
/**
 * Khanpan Printer Connector — native host builder.
 *
 * Builds a self-contained bundle at:
 *
 *   dist/windows/Khanpan-Printer-Host/
 *     ├── node.exe                       (~77 MB; official Node v22 LTS)
 *     ├── host.bundle.cjs                (esbuild output, ~50 KB)
 *     ├── khanpan-printer-host.bat       (shell wrapper Chrome launches)
 *     ├── Install Khanpan Printer.bat    (double-clickable installer)
 *     ├── README.txt
 *     └── node_modules/                  (serialport runtime deps)
 *
 * The bundle is then wrapped into a Windows .exe installer via Inno Setup
 * (see installer-windows/). Customer flow:
 *
 *   1. Download the .exe installer.
 *   2. Double-click. Inno Setup wizard runs, no admin prompt needed.
 *   3. Postinstall registers the Chrome native messaging manifest in HKCU.
 *   4. Reload the Khanpan Printer Connector extension in chrome://extensions/.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE = path.join(__dirname, "host.mjs");
const DIST = path.join(__dirname, "dist");
const CACHE = path.join(__dirname, ".node-cache");
const NODE_VERSION = "v22.11.0";

// Build target. Pass --target=windows (the default on Windows) or omit to
// auto-detect. Cross-compiling from another OS is supported but not documented.
function parseTarget(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target" && argv[i + 1]) return argv[++i];
    if (a.startsWith("--target=")) return a.slice("--target=".length);
  }
  return process.platform === "darwin" ? "macos"
    : process.platform === "linux" ? "linux"
    : process.platform === "win32" ? "windows"
    : null;
}

const PLATFORM = parseTarget(process.argv);
if (!["macos", "windows", "linux"].includes(PLATFORM)) {
  console.error(`unsupported build target: ${PLATFORM}`);
  process.exit(1);
}

const IS_WIN = PLATFORM === "windows";

const OUT_DIR = path.join(DIST, PLATFORM, "Khanpan-Printer-Host");
const BUNDLE = path.join(OUT_DIR, "host.bundle.cjs");
const NODE_BINARY = path.join(OUT_DIR, IS_WIN ? "node.exe" : "node");
const WRAPPER =
  IS_WIN
    ? path.join(OUT_DIR, "khanpan-printer-host.bat")
    : path.join(OUT_DIR, "khanpan-printer-host");
// Install-trigger filename: .bat is double-clickable from Explorer.
const COMMAND =
  PLATFORM === "macos"
    ? path.join(OUT_DIR, "Install Khanpan Printer.command")
    : PLATFORM === "windows"
      ? path.join(OUT_DIR, "Install Khanpan Printer.bat")
      : path.join(OUT_DIR, "install.sh");
const README = path.join(OUT_DIR, "README.txt");

// ── Steps ────────────────────────────────────────────────────────────────────

async function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  const t0 = Date.now();
  try {
    const result = await fn();
    process.stdout.write(`ok (${Date.now() - t0}ms)\n`);
    return result;
  } catch (err) {
    process.stdout.write(`FAILED\n`);
    console.error(`  ${err?.message ?? err}`);
    if (err?.stderr) console.error(`  stderr: ${err.stderr.toString().slice(-400)}`);
    process.exit(1);
  }
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function freshOutDir() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function bundle() {
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [SOURCE],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: BUNDLE,
    minify: false,
    sourcemap: false,
    logLevel: "warning",
    // serialport has native .node bindings that esbuild can't inline. We
    // emit a runtime `require("serialport")` that resolves to the package
    // shipped alongside the bundle in node_modules/ (copied by
    // copySerialPortDeps below). Same for its transitive @serialport/* deps.
    external: ["serialport", "@serialport/*"],
  });
  // Strip the leading shebang esbuild copies from the entry file.
  const contents = await fs.readFile(BUNDLE, "utf8");
  if (contents.startsWith("#!")) {
    await fs.writeFile(BUNDLE, contents.replace(/^#![^\n]*\n/, ""), "utf8");
  }
}

async function copySerialPortDeps() {
  // serialport + every @serialport/* subdep needs to live next to the bundle
  // so `require("serialport")` at runtime resolves through Node's normal
  // module lookup. pnpm's symlinked layout doesn't survive a flat copy,
  // so we shell out to npm — universally available, produces a flat
  // node_modules tree we can copy verbatim.
  //
  // Cross-compile caveat: serialport's `@serialport/bindings-cpp` has native
  // .node prebuilds per (OS × arch × Node version). `npm install` on the host
  // grabs the *host's* prebuild. When cross-compiling, the bundle may include
  // prebuilds that don't match the target — serial will report "unavailable"
  // rather than crashing. For native serial on Windows, build on Windows
  // (CI handles this; see installer-windows/README.md).
  const stagingDir = path.join(CACHE, "serialport-deploy");
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  // Read the pinned serialport version from the host's package.json so the
  // bundle version stays in sync with what we developed against.
  const hostPkg = JSON.parse(
    await fs.readFile(path.join(__dirname, "package.json"), "utf8"),
  );
  const serialPortVersion =
    hostPkg.dependencies?.serialport ?? hostPkg.dependencies?.["serialport"] ?? "13";

  // Use npm (not pnpm) so the install layout is the classic flat
  // node_modules tree that Node's resolver expects. --omit=dev skips devDeps.
  // --no-audit --no-fund keeps the output quiet and reproducible.
  // --legacy-peer-deps avoids unnecessary peer warnings.
  try {
    await execAsync(
      `cd "${stagingDir}" && npm init -y >/dev/null && ` +
        `npm install --omit=dev --no-audit --no-fund --legacy-peer-deps "serialport@${serialPortVersion}"`,
      // serialport's postinstall downloads prebuilds; takes ~10-15s.
      { maxBuffer: 50 * 1024 * 1024 },
    );
  } catch (err) {
    // If npm isn't on PATH (unlikely — it ships with Node), surface a
    // helpful message and continue without serial support.
    process.stdout.write(
      `\n  skipped (npm install failed: ${err?.message?.slice(0, 120)})`,
    );
    return;
  }

  // Mirror the produced node_modules into the bundle. We dereference symlinks
  // (-L) so the bundle is self-contained even if npm used file: links.
  const srcModules = path.join(stagingDir, "node_modules");
  const destModules = path.join(OUT_DIR, "node_modules");
  await execAsync(`cp -RL "${srcModules}" "${destModules}"`);
}

async function fetchNodeForBundle() {
  // Node distribution maps target → archive name + binary path inside it.
  // - Windows ships a .zip with node.exe at the root
  // Cross-compile: pass --target=windows from any dev box to fetch the
  // Windows archive and extract node.exe into the bundle.
  let dist;
  if (PLATFORM === "macos") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    dist = {
      archive: `node-${NODE_VERSION}-darwin-${arch}.tar.gz`,
      innerPath: `node-${NODE_VERSION}-darwin-${arch}/bin/node`,
      extract: "tar",
    };
  } else if (PLATFORM === "linux") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    dist = {
      archive: `node-${NODE_VERSION}-linux-${arch}.tar.gz`,
      innerPath: `node-${NODE_VERSION}-linux-${arch}/bin/node`,
      extract: "tar",
    };
  } else if (PLATFORM === "windows") {
    // Most cashier PCs are x64. ARM64 Windows is rare; revisit if customers ask.
    dist = {
      archive: `node-${NODE_VERSION}-win-x64.zip`,
      innerPath: `node-${NODE_VERSION}-win-x64/node.exe`,
      extract: "unzip",
    };
  } else {
    throw new Error(`fetchNodeForBundle: unsupported target ${PLATFORM}`);
  }

  const cachedNode = path.join(CACHE, dist.innerPath);
  if (!(await fileExists(cachedNode))) {
    await fs.mkdir(CACHE, { recursive: true });
    const url = `https://nodejs.org/dist/${NODE_VERSION}/${dist.archive}`;
    const archivePath = path.join(CACHE, dist.archive);
    process.stdout.write(`\n  fetching ${NODE_VERSION} for ${PLATFORM}… `);
    await execAsync(`curl -fsSL "${url}" -o "${archivePath}"`);
    if (dist.extract === "tar") {
      await execAsync(`tar -xzf "${archivePath}" -C "${CACHE}"`);
    } else {
      // We only need to extract node.exe; -j junks paths but we keep the
      // dir structure so re-runs don't re-download.
      await execAsync(`unzip -oq "${archivePath}" -d "${CACHE}"`);
    }
  }
  await fs.copyFile(cachedNode, NODE_BINARY);
  if (!IS_WIN) await fs.chmod(NODE_BINARY, 0o755);
}

async function writeWrapper() {
  if (IS_WIN) {
    const script =
      [
        "@echo off",
        // %~dp0 = directory of the .bat file with trailing backslash.
        // KHANPAN_HOST_PATH tells the bundled JS what to register with Chrome
        // (the bundle sees process.execPath = node.exe, which Chrome can't
        // launch on its own).
        `set "KHANPAN_HOST_PATH=%~f0"`,
        `"%~dp0node.exe" "%~dp0host.bundle.cjs" %*`,
      ].join("\r\n") + "\r\n";
    await fs.writeFile(WRAPPER, script, "utf8");
    return;
  }
  const script =
    [
      "#!/bin/sh",
      "# Khanpan Printer Connector native messaging host wrapper.",
      "# Chrome launches this; it forwards to the bundled Node + script.",
      "# KHANPAN_HOST_PATH tells the bundled JS what to register with Chrome",
      "# (the bundle sees process.execPath = node, which Chrome can't launch).",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'KHANPAN_HOST_PATH="$DIR/$(basename "$0")" exec "$DIR/node" "$DIR/host.bundle.cjs" "$@"',
    ].join("\n") + "\n";
  await fs.writeFile(WRAPPER, script, "utf8");
  await fs.chmod(WRAPPER, 0o755);
}

async function writeInstallCommand() {
  if (IS_WIN) {
    // Windows batch file: try auto-detect first, fall back to a prompt for the extension ID.
    const script =
      [
        "@echo off",
        "setlocal enabledelayedexpansion",
        "echo Registering Khanpan Printer Connector native helper...",
        'call "%~dp0khanpan-printer-host.bat" install >nul 2>"%TEMP%\\khanpan-install.err"',
        "if %ERRORLEVEL%==0 (",
        "  echo.",
        "  echo [OK] All set. Reload the Khanpan Printer Connector extension in chrome://extensions/.",
        "  goto :end",
        ")",
        "echo.",
        "echo Auto-detect failed. Paste the extension ID from chrome://extensions/:",
        "echo (32 lowercase letters; the line under the extension name)",
        "set /p EXT_ID=Extension ID: ",
        'if "!EXT_ID!"=="" goto :fail',
        'call "%~dp0khanpan-printer-host.bat" install --extension-id !EXT_ID!',
        "if %ERRORLEVEL%==0 (",
        "  echo.",
        "  echo [OK] All set. Reload the Khanpan Printer Connector extension in chrome://extensions/.",
        "  goto :end",
        ")",
        ":fail",
        "echo.",
        "echo [FAIL] Install failed. Details:",
        'type "%TEMP%\\khanpan-install.err"',
        "echo.",
        "echo Make sure the Khanpan Printer Connector extension is loaded in Chrome first.",
        ":end",
        "echo.",
        "pause",
      ].join("\r\n") + "\r\n";
    await fs.writeFile(COMMAND, script, "utf8");
    return;
  }
  // Non-Windows: shell .command file. Auto-detect works only when the
  // extension's stored path matches our build-time extension dir — true for
  // dev installs and after publishing to the Web Store. Fall back to a prompt.
  const script =
    [
      "#!/bin/sh",
      "# Double-click to register the Khanpan Printer Connector native",
      "# helper with Chrome. Writes the manifest to",
      "# ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/.",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      "echo \"Registering Khanpan Printer Connector native helper…\"",
      'if "$DIR/khanpan-printer-host" install 2>/tmp/khanpan-install.err; then',
      '  echo ""',
      '  echo "✓ All set. Reload the Khanpan Printer Connector extension in chrome://extensions/."',
      "else",
      '  echo ""',
      '  echo "Auto-detect failed. Paste the extension ID from chrome://extensions/:"',
      '  echo "(32 lowercase letters; the line under the extension name on chrome://extensions/)"',
      '  printf "Extension ID: "',
      "  read EXT_ID",
      '  if [ -n "$EXT_ID" ] && "$DIR/khanpan-printer-host" install --extension-id "$EXT_ID"; then',
      '    echo ""',
      '    echo "✓ All set. Reload the Khanpan Printer Connector extension in chrome://extensions/."',
      "  else",
      '    echo ""',
      '    echo "✗ Install failed. Details:"',
      "    cat /tmp/khanpan-install.err",
      '    echo ""',
      '    echo "Make sure the Khanpan Printer Connector extension is loaded in Chrome first."',
      "  fi",
      "fi",
      'echo ""',
      'echo "(this window will close in 15 seconds)"',
      "sleep 15",
    ].join("\n") + "\n";
  await fs.writeFile(COMMAND, script, "utf8");
  await fs.chmod(COMMAND, 0o755);
}

async function writeReadme() {
  const isWin = IS_WIN;
  const nodeName = isWin ? "node.exe" : "node";
  const wrapperName = isWin ? "khanpan-printer-host.bat" : "khanpan-printer-host";
  const commandName = isWin ? "Install Khanpan Printer.bat" : "Install Khanpan Printer.command";
  const commandHint = isWin
    ? "double-click in Explorer to register the helper"
    : "double-click in Finder to register the helper";

  const lines = [
    "Khanpan Printer Connector — native helper",
    "",
    "What's in this folder",
    `  • ${nodeName.padEnd(26)}bundled Node.js runtime (the helper needs this)`,
    `  • ${"host.bundle.cjs".padEnd(26)}the helper itself (printer discovery + ESC/POS forwarding)`,
    `  • ${wrapperName.padEnd(26)}shell wrapper Chrome launches (do NOT rename)`,
    `  • ${commandName.padEnd(26)}${commandHint}`,
    "",
    "First-time setup",
    "  1. Install the 'Khanpan Printer Connector' Chrome extension (chrome://extensions/).",
    `  2. Double-click '${commandName}'. A ${isWin ? "console" : "Terminal"} window opens,`,
    "     prints '✓ All set.', and closes after 10 seconds.",
    "  3. Reload the extension in chrome://extensions/.",
    "  4. Open Khanpan POS → Settings → Printer. Your printer appears in the list.",
    "",
    ...(isWin
      ? [
          "If Windows SmartScreen blocks the .bat file ('Windows protected your PC'),",
          "click 'More info' → 'Run anyway'. SmartScreen will remember the choice.",
        ]
      : [
          "If the OS blocks the install script, allow it via your OS security settings.",
        ]),
    "",
    "To uninstall:",
    isWin
      ? `  ${wrapperName} uninstall`
      : `  ./${wrapperName} uninstall`,
  ];
  await fs.writeFile(README, lines.join("\n") + "\n", "utf8");
}

async function smokeTest() {
  // Cross-compile target can't run on the host — skip.
  if (
    (IS_WIN && process.platform !== "win32") ||
    (PLATFORM === "linux" && process.platform !== "linux") ||
    (PLATFORM === "macos" && process.platform !== "darwin")
  ) {
    process.stdout.write(`skipped (cross-compile ${PLATFORM} ← ${process.platform})`);
    return;
  }
  // CI: skip — the test sets a Unix-style PATH and spawns the .bat directly,
  // both of which fail with EINVAL on the Windows GitHub runner. The
  // installer step downstream is the real CI-side smoke test for the bundle.
  if (process.env.CI) {
    process.stdout.write(`skipped (CI=${process.env.CI})`);
    return;
  }
  // Run wrapper with no args (native host mode), send a ping, expect ok response.
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(WRAPPER, [`chrome-extension://build-smoke/`], {
      env: { HOME: process.env.HOME ?? "/tmp", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let inbuf = Buffer.alloc(0);
    let stderr = "";
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* */
      }
      err ? reject(err) : resolve();
    };
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.stdout.on("data", (chunk) => {
      inbuf = Buffer.concat([inbuf, chunk]);
      if (inbuf.length < 4) return;
      const len = inbuf.readUInt32LE(0);
      if (inbuf.length < 4 + len) return;
      const body = inbuf.subarray(4, 4 + len).toString("utf8");
      try {
        const msg = JSON.parse(body);
        msg.ok === true ? finish() : finish(new Error(`bad response: ${body}`));
      } catch {
        finish(new Error(`unparseable response: ${body.slice(0, 100)}`));
      }
    });
    child.on("error", finish);
    child.on("exit", (code) => {
      if (done) return;
      finish(
        new Error(`wrapper exited ${code} before responding. stderr: ${stderr.trim().slice(-300)}`),
      );
    });
    const body = Buffer.from(JSON.stringify({ id: "build-smoke", op: "ping" }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    child.stdin.write(Buffer.concat([header, body]));
    setTimeout(() => finish(new Error("wrapper did not respond within 4 s")), 4000);
  });
}

// ── Run ──────────────────────────────────────────────────────────────────────

console.log(`Building Khanpan Printer Host bundle for ${PLATFORM}…`);
await step("clean output dir", freshOutDir);
await step("esbuild bundle", bundle);
await step(`fetch Node ${NODE_VERSION}`, fetchNodeForBundle);
await step("copy serialport deps", copySerialPortDeps);
await step("write Chrome launcher (khanpan-printer-host)", writeWrapper);
await step("write install command (Install Khanpan Printer)", writeInstallCommand);
await step("write README", writeReadme);
await step("smoke test", smokeTest);

const stat = await fs.stat(NODE_BINARY);
console.log("");
console.log(`✓ built ${OUT_DIR}`);
console.log(`  node binary: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
console.log("");
console.log("Distribute (Windows):");
console.log(`  iscc installer-windows\\khanpan-printer-host.iss`);
console.log(`  Output: dist\\Khanpan-Printer-Host-Setup-*.exe`);
