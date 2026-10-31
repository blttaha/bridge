# Runs the full end-to-end test inside Windows Sandbox (Windows 10/11 Pro, "Windows Sandbox" feature enabled).
# Stages the agent, node.exe and a pre-paired config, boots the sandbox, drives every feature over the real
# WebSocket protocol from this machine (touch, input, stream, lock, screens, Wake-on-LAN) and finally shuts the
# sandbox down with the agent's own shutdown command.
#   powershell -ExecutionPolicy Bypass -File tests\windows\windows-sandbox\run-sandbox.ps1
# Run it from an interactive terminal: a sandbox started from a detached/background process opens without an
# attached display session, so screen capture and input (correctly) fail inside it.
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Agent = Resolve-Path (Join-Path $Here '..\..\..\pc-agent')
$Stage = Join-Path $env:TEMP 'tbsandbox'

if (Get-Process WindowsSandboxRemoteSession, WindowsSandboxClient -ErrorAction SilentlyContinue) {
  throw 'Windows Sandbox zaten açık; önce kapatın (aynı anda yalnızca bir sandbox çalışabilir).'
}
if (-not (Test-Path "$env:WINDIR\System32\WindowsSandbox.exe")) {
  throw 'Windows Sandbox özelliği kurulu değil (Windows Özellikleri > Windows Sandbox).'
}

Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$Stage\app\native", "$Stage\data", "$Stage\out" | Out-Null
Copy-Item "$Agent\server.js", "$Agent\package.json" "$Stage\app\"
Copy-Item -Recurse "$Agent\node_modules" "$Stage\app\"
Copy-Item "$Agent\native\BridgeHelper.exe" "$Stage\app\native\"
$cloudflared = @("$Agent\native\cloudflared.exe", 'C:\Program Files (x86)\cloudflared\cloudflared.exe', 'C:\Program Files\cloudflared\cloudflared.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($cloudflared) { Copy-Item $cloudflared "$Stage\app\native\cloudflared.exe" }
Copy-Item (Get-Command node).Source "$Stage\node.exe"
Copy-Item "$Here\touchapp.ps1", "$Here\start.ps1", "$Here\wol-listen.js" $Stage

$token = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
Set-Content "$Stage\token.txt" $token
@{ deviceId = 'sandbox-device'; deviceName = 'SANDBOX'; pin = ''; authToken = $token; port = 4850; createdAt = (Get-Date).ToString('o'); pinUpdatedAt = 0; pairedTokens = @($token) } |
  ConvertTo-Json | Set-Content "$Stage\data\config.json" -Encoding UTF8   # BOM is fine: the agent strips it

@"
<Configuration>
  <VGpu>Enable</VGpu>
  <Networking>Enable</Networking>
  <MemoryInMB>6144</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>$Stage</HostFolder><SandboxFolder>C:\tb</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\tb\start.ps1</Command></LogonCommand>
</Configuration>
"@ | Set-Content "$Stage\bridge.wsb" -Encoding UTF8

Start-Process "$Stage\bridge.wsb"
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline -and -not (Test-Path "$Stage\out\started.txt")) { Start-Sleep -Seconds 3 }
if (-not (Test-Path "$Stage\out\started.txt")) { throw 'Sandbox açılmadı.' }
Start-Sleep -Seconds 10   # agent + bridge warm-up
node (Join-Path $Here '..\sandbox-e2e-win.js') $Stage
exit $LASTEXITCODE
