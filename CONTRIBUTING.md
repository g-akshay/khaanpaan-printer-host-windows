# Contributing

Thanks for your interest in the Khanpan Printer Host. Contributions are
welcome — bug reports, fixes, new printer compatibility, and documentation
improvements all help.

## Reporting bugs

Open an issue with:

- A short description of what you tried.
- Your Windows version (`winver`) and Chrome version (`chrome://version`).
- Printer make + model and the transport you're using (USB Printer Class via
  spooler, USB-Serial, Bluetooth virtual COM, or network/9100).
- Relevant logs:
  - Helper stderr: start Chrome with `--enable-logging --v=1` and inspect
    `%LOCALAPPDATA%\Google\Chrome\User Data\chrome_debug.log`.
  - Inno Setup install log: re-run the installer with `/LOG="setup.log"`.

## Development setup

```cmd
:: 1. Clone and install deps.
git clone https://github.com/g-akshay/khaanpaan-printer-host-windows.git
cd khaanpaan-printer-host-windows\tools\khanpan-native-host
pnpm install

:: 2. Run the helper in dev mode (no .exe build).
node install.mjs

:: 3. Reload the Khanpan Printer Connector extension in chrome://extensions/
::    and exercise the connection from a test web page.
```

To rebuild the installer end-to-end you also need
[Inno Setup 6+](https://jrsoftware.org/isdl.php) — it's free and Windows-only.

```cmd
node build.mjs --target=windows
iscc installer-windows\khanpan-printer-host.iss
```

Output: `tools\khanpan-native-host\dist\Khanpan-Printer-Host-Setup-<version>.exe`.

## Pull requests

- One concern per PR. Small, focused changes get reviewed faster.
- Match the existing code style — TypeScript-flavoured JSDoc, no semicolon
  surprises, comments only when the *why* isn't obvious from the code.
- New printer-model support? Add a row to the compatibility table in
  `tools/khanpan-native-host/README.md` and note which transport you tested.
- Security-sensitive changes (touching the native-messaging boundary, the
  manifest's `allowed_origins`, or the spooler P/Invoke) — please flag in the
  PR description so we can review carefully.

## Security disclosures

Do **not** open public issues for vulnerabilities. Email
**support@khanpan.app** with a short description and reproduction steps.
We'll acknowledge within 72 hours and coordinate a fix + disclosure timeline.

## License

By contributing you agree that your changes are licensed under
[Apache-2.0](./LICENSE), the same as the rest of the project.
