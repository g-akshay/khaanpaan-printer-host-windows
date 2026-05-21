; Khanpan Printer Connector — Inno Setup installer script.
;
; Builds a per-user Windows installer that:
;   1. Drops the Khanpan-Printer-Host bundle to %LOCALAPPDATA%\Programs\Khanpan-Printer-Host\
;      (no admin prompt; works on any cashier PC).
;   2. Registers the native messaging host with Chrome in HKCU.
;   3. Adds an uninstall entry in Settings → Apps so customers can remove
;      cleanly via the OS UI.
;
; Build (on Windows):
;   1. Run `node build.mjs --target=windows` in tools/khanpan-native-host/
;      to produce dist/windows/Khanpan-Printer-Host/.
;   2. Open this .iss in Inno Setup Compiler (iscc.exe) or run:
;        iscc tools/khanpan-native-host/installer-windows/khanpan-printer-host.iss
;   3. Output lands at: tools/khanpan-native-host/dist/Khanpan-Printer-Host-Setup-<version>.exe
;
#define MyAppName "Khanpan Printer Connector"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Khanpan"
#define MyAppURL "https://khanpan.app"
#define MyAppExeName "khanpan-printer-host.bat"
#define MyBundleDir "..\dist\windows\Khanpan-Printer-Host"

[Setup]
; Stable AppId — never change this for shipped versions; uninstall keys are
; matched against it. Generate with `[OnlineGenerateGuid]` in the Inno Setup
; IDE if you ever fork this for a different product.
AppId={{B6F0F8C1-2D31-4F1A-9E16-7D8BDF7C9F0A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/support
AppUpdatesURL={#MyAppURL}/downloads

; Per-user install — no admin prompt, can run on locked-down cashier PCs.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

DefaultDirName={localappdata}\Programs\Khanpan-Printer-Host
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes

; Installer .exe metadata
OutputDir=..\dist
OutputBaseFilename=Khanpan-Printer-Host-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern

; SmartScreen won't be happy with an unsigned installer on first run. Once we
; have an Authenticode code-signing cert, uncomment and point at it:
;   SignTool=signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /a $f

; Show a friendly "we're installing this for one user" page
UsedUserAreasWarning=no
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\node.exe

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Bundle contents. The MyBundleDir define is relative to the .iss file's
; location, so this picks up whatever `node build.mjs --target=windows` last
; produced. Re-build the bundle first if you change host.mjs.
Source: "{#MyBundleDir}\node.exe";              DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyBundleDir}\host.bundle.cjs";       DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyBundleDir}\khanpan-printer-host.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyBundleDir}\Install Khanpan Printer.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyBundleDir}\README.txt";            DestDir: "{app}"; Flags: ignoreversion

[Run]
; Postinstall: register the native host with Chrome. Runs as the installing
; user (no elevation needed) and inherits their environment so Chrome's
; per-user Secure Preferences are reachable for auto-detect.
;
; The 'install' subcommand exits 0 even if auto-detect fails (no extension
; loaded yet). We never want a failed registration to abort the .exe
; installer — the customer can re-run "Install Khanpan Printer.bat" later
; from Start Menu.
Filename: "{app}\khanpan-printer-host.bat"; Parameters: "install"; \
  Flags: runhidden waituntilterminated; \
  StatusMsg: "Registering helper with Chrome..."

[UninstallRun]
; On uninstall, ask the helper to remove its native-messaging registration
; before files are deleted (otherwise the registry entry lingers and points
; at a missing executable, confusing Chrome's later launches).
Filename: "{app}\khanpan-printer-host.bat"; Parameters: "uninstall"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "RemoveNativeHostRegistration"

[Icons]
; Start Menu shortcut to the re-register .bat — gives customers a discoverable
; "fix it if Chrome forgot me" entry point. Also gives the uninstaller a known
; place to clean up.
Name: "{group}\Re-register Khanpan Printer Host"; \
  Filename: "{app}\Install Khanpan Printer.bat"; \
  WorkingDir: "{app}"; \
  Comment: "Re-register the native helper with Chrome (e.g. after reloading the extension)."

Name: "{group}\Khanpan Printer Host README"; \
  Filename: "{app}\README.txt"

Name: "{group}\Uninstall Khanpan Printer Host"; \
  Filename: "{uninstallexe}"

[Code]
// Postinstall hook: after a successful install, surface a notification telling
// the user to reload the Chrome extension. Inno Setup's runtime UI doesn't
// support full HTML, so we just append to the standard "Finished" page text.

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    // No-op for now; the [Run] section's StatusMsg already gives feedback
    // and the .bat output is hidden. Hook is here so we can add post-install
    // diagnostics (e.g. detect Chrome path, surface a "reload extension"
    // dialog) without restructuring the .iss.
  end;
end;
