#!/usr/bin/env node
/**
 * Build the Chrome Web Store submission zip.
 *
 * Stages the production-flavoured manifest (host_permissions locked to
 * https://app.khanpan.app/* only), copies the runtime files, and zips
 * exactly what gets uploaded to https://chrome.google.com/webstore/devconsole.
 *
 *   pnpm --filter khanpan-printer-connector-extension build:store
 *
 * The zip is placed at:
 *   tools/khanpan-extension/web-store/khanpan-printer-connector-<version>.zip
 *
 * After the listing is approved and you have the published extension ID,
 * follow SUBMISSION.md § 6 to wire it back into the native host installer.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXT_DIR = path.dirname(__dirname);
const PROD_MANIFEST = path.join(__dirname, "manifest.prod.json");
const STAGE = path.join(__dirname, ".stage");

// Files copied verbatim from the extension dir into the zip.
const RUNTIME_FILES = [
  "service_worker.js",
  "content_script.js",
  "inject.js",
  "popup.html",
  "popup.js",
];

async function main() {
  // 1. Read version from the production manifest so the zip name matches.
  const manifest = JSON.parse(await fs.readFile(PROD_MANIFEST, "utf8"));
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`bad version in manifest.prod.json: ${version}`);
  }

  // 2. Verify the dev manifest matches (we don't want skewed versions
  //    causing the toolbar to show one number and the Web Store to show another).
  const devManifest = JSON.parse(
    await fs.readFile(path.join(EXT_DIR, "manifest.json"), "utf8"),
  );
  if (devManifest.version !== version) {
    throw new Error(
      `version skew: dev manifest is ${devManifest.version}, prod manifest is ${version}. Update both before submitting.`,
    );
  }

  // 3. Refuse to ship if any production file mentions localhost — that'd be
  //    a permissions over-request that the reviewer would flag.
  await assertNoLocalhost();

  // 4. Stage the files.
  await fs.rm(STAGE, { recursive: true, force: true });
  await fs.mkdir(STAGE, { recursive: true });
  await fs.mkdir(path.join(STAGE, "icons"), { recursive: true });

  await fs.copyFile(PROD_MANIFEST, path.join(STAGE, "manifest.json"));
  for (const f of RUNTIME_FILES) {
    await fs.copyFile(path.join(EXT_DIR, f), path.join(STAGE, f));
  }
  for (const size of [16, 32, 48, 128]) {
    const name = `icon${size}.png`;
    await fs.copyFile(
      path.join(EXT_DIR, "icons", name),
      path.join(STAGE, "icons", name),
    );
  }

  // 5. Zip it.
  const zipPath = path.join(__dirname, `khanpan-printer-connector-${version}.zip`);
  await fs.rm(zipPath, { force: true });
  await execAsync(`cd "${STAGE}" && zip -r "${zipPath}" .`);

  // 6. Cleanup stage dir.
  await fs.rm(STAGE, { recursive: true, force: true });

  // 7. Print a manifest of what was packed.
  const { stdout } = await execAsync(`unzip -l "${zipPath}"`);
  console.log(stdout);
  console.log(`✓ ${zipPath}`);
  console.log("");
  console.log("Next:");
  console.log("  1. Upload at https://chrome.google.com/webstore/devconsole");
  console.log("  2. Paste listing copy from web-store/STORE_LISTING.md");
  console.log("  3. See web-store/SUBMISSION.md for the full checklist");
}

async function assertNoLocalhost() {
  // Permissions and matches in the prod manifest must be production hosts only.
  const text = await fs.readFile(PROD_MANIFEST, "utf8");
  if (/localhost|127\.0\.0\.1/i.test(text)) {
    throw new Error(
      "manifest.prod.json contains localhost references — strip them before building for the Web Store.",
    );
  }
  // Runtime JS files mustn't hardcode localhost URLs either.
  for (const f of RUNTIME_FILES) {
    const t = await fs.readFile(path.join(EXT_DIR, f), "utf8");
    // content_script.js correctly compares against window.location.origin —
    // we look only for hardcoded host strings.
    const hits = t.match(/(?:https?:)?\/\/(?:localhost|127\.0\.0\.1)/gi);
    if (hits) {
      throw new Error(
        `${f} contains hardcoded localhost (${hits.length} occurrence${hits.length === 1 ? "" : "s"}) — review before shipping.`,
      );
    }
  }
}

await main();
