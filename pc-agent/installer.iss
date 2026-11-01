#define MyAppName "Bridge"
#define MyAppVersion "2.20.0"
#define MyAppPublisher "Bridge"
#define MyAppExeName "Bridge.exe"
; The product was called "TahaBLT Connect" before; the AppId is unchanged so this setup upgrades that install.
#define OldAppName "TahaBLT Connect"

[Setup]
AppId={{8D4E9C2A-7B3F-4E19-9A61-5C8F2E410B9D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
; Do not reuse the old "TahaBLT Connect" folder: the old one is removed below
UsePreviousAppDir=no
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..
OutputBaseFilename=Bridge-Setup
SetupIconFile=native\app.ico
WizardImageFile=native\wizard-large.bmp
WizardSmallImageFile=native\wizard-small.bmp
WizardImageStretch=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startup"; Description: "Windows açılışında görev çubuğunda otomatik başlat"; GroupDescription: "Sistem Entegrasyonu:"

; Runtime state (tokens, scenes, admin key) lives in C:\ProgramData\Bridge\data; the agent and the tray migrate it
; from the old "TahaBLT Connect" folders on first start, so phones stay paired across the rename.

[InstallDelete]
Type: filesandordirs; Name: "{autopf}\{#OldAppName}"
Type: files; Name: "{autoprograms}\{#OldAppName}.lnk"
Type: files; Name: "{autodesktop}\{#OldAppName}.lnk"

[Files]
Source: "..\Bridge.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "server.js"; DestDir: "{app}\pc-agent"; Flags: ignoreversion
Source: "package.json"; DestDir: "{app}\pc-agent"; Flags: ignoreversion
Source: "native\BridgeHelper.exe"; DestDir: "{app}\pc-agent\native"; Flags: ignoreversion
Source: "native\app.ico"; DestDir: "{app}\pc-agent\native"; Flags: ignoreversion
Source: "C:\Program Files (x86)\cloudflared\cloudflared.exe"; DestDir: "{app}\pc-agent\native"; Flags: ignoreversion
Source: "C:\Program Files\nodejs\node.exe"; DestDir: "{app}\pc-agent\native"; Flags: ignoreversion
Source: "node_modules\*"; DestDir: "{app}\pc-agent\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "TahaBLTConnect"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Bridge"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#OldAppName}"""; Flags: runhidden
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#MyAppName}"""; Flags: runhidden
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#MyAppName}"" dir=in action=allow protocol=TCP localport=4850"; Flags: runhidden
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#MyAppName}"" dir=in action=allow protocol=UDP localport=4851"; Flags: runhidden
Filename: "{app}\{#MyAppExeName}"; Parameters: "--setup-system"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--uninstall-system"; Flags: runhidden; RunOnceId: "RemoveService"
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Get-Process Bridge,BridgeHelper -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '{app}\*' } | Stop-Process -Force"""; Flags: runhidden; RunOnceId: "KillBridge"
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#MyAppName}"""; Flags: runhidden; RunOnceId: "RemoveFirewall"

[Code]
// Stops the running agent before files are replaced: the old "TahaBLT Connect" names and this install's Bridge
// processes ("Bridge" is a common name, so only the ones under Program Files\Bridge are stopped).
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Exec('sc.exe', 'stop TahaBLTConnectService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('sc.exe', 'stop BridgeService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /IM TahaBLT-Connect.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /IM TahaBLTBridge.exe /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('powershell.exe', '-NoProfile -Command "Get-Process Bridge,BridgeHelper -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''' + ExpandConstant('{autopf}') + '\Bridge\*'' } | Stop-Process -Force"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
end;
