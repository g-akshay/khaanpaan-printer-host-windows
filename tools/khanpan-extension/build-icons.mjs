#!/usr/bin/env node
/**
 * Generate Chrome extension icons from `icons/icon.svg`.
 *
 * Chrome Web Store requires 128×128 PNG for the listing; the manifest can
 * reference smaller sizes (16/32/48/128) for use in the toolbar, extension
 * page, and management UI. We generate all four from the single SVG source
 * so the artwork stays in sync.
 *
 * Re-run after editing `icons/icon.svg`:
 *
 *   pnpm --filter khanpan-printer-connector-extension build:icons
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SVG_PATH = path.join(__dirname, "icons", "icon.svg");
const SIZES = [16, 32, 48, 128];

const svg = await fs.readFile(SVG_PATH);
for (const size of SIZES) {
  const out = path.join(__dirname, "icons", `icon${size}.png`);
  await sharp(svg)
    .resize(size, size, { fit: "contain", kernel: "lanczos3" })
    .png({ compressionLevel: 9 })
    .toFile(out);
  const stat = await fs.stat(out);
  process.stdout.write(`✓ icon${size}.png  (${stat.size} bytes)\n`);
}
