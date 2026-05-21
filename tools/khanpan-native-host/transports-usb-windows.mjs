/**
 * Windows USB Printer Class transport — Phase 2.
 *
 * Sends raw ESC/POS bytes to a Windows-installed printer through the OS
 * Print Spooler in RAW mode. Works WITH the standard `usbprint` driver that
 * Windows attaches automatically to USB Printer Class devices — no Zadig
 * driver swap required.
 *
 * How it works:
 *   1. Discovery — shell out to PowerShell's `Get-Printer` to enumerate the
 *      printers currently installed on the cashier's Windows account. Each
 *      becomes a candidate with a stable id derived from the printer name.
 *   2. Print — spawn a small PowerShell script that P/Invokes `winspool.drv`
 *      OpenPrinter → StartDocPrinter("RAW") → WritePrinter → EndDocPrinter
 *      → ClosePrinter. Bytes arrive on the script's stdin, the script reads
 *      them as base64 (avoids any binary mangling through PowerShell
 *      encoding) and pushes them to the printer untouched.
 *
 * Why not libusb / WebUSB? Both would require replacing the kernel driver
 * (Zadig + WinUSB) which then prevents Windows itself from printing to the
 * device. The Print Spooler path is the only way to share the printer
 * between the POS and the rest of the OS.
 */

import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ── PowerShell inline scripts ────────────────────────────────────────────────

/** Lists installed printers as JSON. Filters to printers whose driver name
 *  looks like a thermal / receipt printer. Adjust the filter as we encounter
 *  new printer makes. */
const LIST_PRINTERS_PS1 = `
$ErrorActionPreference = 'Stop'
$printers = Get-Printer -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    Name       = $_.Name
    DriverName = $_.DriverName
    PortName   = $_.PortName
    Type       = $_.Type
    Shared     = $_.Shared
  }
}
$printers | ConvertTo-Json -Compress
`;

/** Sends RAW bytes (from stdin, base64-encoded) to the named printer via
 *  the Windows Print Spooler. PowerShell here just defines a typed wrapper
 *  around winspool.drv P/Invokes. Printer name comes in via $env:PRINTER_NAME
 *  because -EncodedCommand can't take positional args. */
const PRINT_RAW_PS1 = `
$ErrorActionPreference = 'Stop'
$PrinterName = $env:PRINTER_NAME
if (-not $PrinterName) { throw "PRINTER_NAME env var not set" }

Add-Type -ErrorAction Stop @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class KhpSpooler {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DocInfo {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool OpenPrinter(string p, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DocInfo info);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h, byte[] b, int cb, out int written);

  public static void Send(string name, byte[] data) {
    IntPtr handle;
    if (!OpenPrinter(name, out handle, IntPtr.Zero))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter");
    try {
      DocInfo di = new DocInfo();
      di.pDocName = "Khanpan Receipt";
      di.pOutputFile = null;
      di.pDataType = "RAW";
      if (!StartDocPrinter(handle, 1, di))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter");
      try {
        if (!StartPagePrinter(handle))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter");
        int written;
        if (!WritePrinter(handle, data, data.Length, out written))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter");
        if (written != data.Length)
          throw new Exception("WritePrinter wrote " + written + " of " + data.Length + " bytes");
        EndPagePrinter(handle);
      } finally {
        EndDocPrinter(handle);
      }
    } finally {
      ClosePrinter(handle);
    }
  }
}
"@

# Read base64 payload from stdin so the bytes survive PowerShell's text encoding.
$b64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($b64)
[KhpSpooler]::Send($PrinterName, $bytes)
Write-Output "ok $($bytes.Length) bytes"
`;

// ── Discovery ────────────────────────────────────────────────────────────────

/** Stable id from printer name. Names are unique per Windows user account, so
 *  they double as ids. We hex-encode UTF-8 bytes so the id stays ASCII-safe
 *  regardless of locale (Hindi / Tamil printer names are real, e.g. setting a
 *  display name in the vendor utility). */
function nameToId(name) {
  const hex = Buffer.from(name, "utf8").toString("hex");
  return `winusb-${hex}`;
}

function idToName(id) {
  if (!id.startsWith("winusb-")) return null;
  try {
    return Buffer.from(id.slice("winusb-".length), "hex").toString("utf8");
  } catch {
    return null;
  }
}

/** Heuristic: does this driver look like a thermal / receipt printer?
 *  Conservative — when in doubt, include. The user can still pick from the
 *  full list in Settings → Printer. */
function looksLikeThermal(driverName) {
  if (!driverName) return false;
  const d = driverName.toLowerCase();
  return (
    d.includes("pos") ||
    d.includes("thermal") ||
    d.includes("receipt") ||
    d.includes("escpos") ||
    d.includes("esc/pos") ||
    d.includes("rongta") ||
    d.includes("epson tm") ||
    d.includes("star tsp") ||
    d.includes("bixolon") ||
    d.includes("tvs") ||
    d.includes("rp 32") ||
    d.includes("rp32") ||
    d.includes("hoin") ||
    d.includes("generic / text only")
  );
}

export async function discoverWindowsPrinters() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execAsync(
      // -NoProfile keeps PowerShell startup fast (no PSReadLine etc).
      // -OutputFormat Text returns the script's stdout as-is (we ConvertTo-Json inside).
      `powershell.exe -NoProfile -NonInteractive -Command "${LIST_PRINTERS_PS1.replace(/"/g, '\\"').replace(/\n/g, " ")}"`,
      { timeout: 5000, windowsHide: true },
    );
    if (!stdout.trim()) return [];
    const raw = JSON.parse(stdout);
    const list = Array.isArray(raw) ? raw : [raw];
    return list
      .filter((p) => p && typeof p.Name === "string")
      .map((p) => ({
        id: nameToId(p.Name),
        name: p.Name,
        transport: "usb",
        status: "ready",
        default_columns: 80,
        supports: ["cut"],
        // For UI: hint whether this looks like a receipt printer vs. a regular one
        likelyThermal: looksLikeThermal(p.DriverName),
        driverName: p.DriverName ?? null,
        portName: p.PortName ?? null,
      }));
  } catch (err) {
    // PowerShell missing, Get-Printer unsupported (Server Core?), or just nothing installed.
    return [];
  }
}

// ── Print ────────────────────────────────────────────────────────────────────

export async function printToWindowsUsb(printerId, bytes) {
  if (process.platform !== "win32") {
    throw new Error("Windows USB transport is only available on Windows");
  }
  const printerName = idToName(printerId);
  if (!printerName) throw new Error(`bad printer id: ${printerId}`);

  return new Promise((resolve, reject) => {
    // We pipe the PowerShell script via stdin to avoid escaping issues with
    // multi-line scripts on the command line. The `-Command -` form tells
    // PowerShell to read the script from stdin... BUT we also need to send
    // the payload bytes via stdin to the running script. Solution: use
    // -EncodedCommand to pass the script (base64-encoded UTF-16LE),
    // then stdin is free for the payload.
    const utf16Script = Buffer.from(PRINT_RAW_PS1, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        utf16Script,
        // PowerShell -EncodedCommand doesn't accept positional args. We pass
        // the printer name via the PRINTER_NAME env var instead.
      ],
      {
        env: { ...process.env, PRINTER_NAME: printerName },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
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

    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      if (code === 0) finish();
      else
        finish(
          new Error(
            `PowerShell exited ${code}. stderr: ${stderr.trim().slice(-400) || "(empty)"}`,
          ),
        );
    });

    // Hand the payload to PowerShell's stdin as base64 — the script decodes.
    child.stdin.write(bytes.toString("base64") + "\n");
    child.stdin.end();
  });
}

