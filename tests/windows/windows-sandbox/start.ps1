# Logon script of the Windows Sandbox test machine: open the firewall, start the touch test window and the agent.
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force C:\tb\out | Out-Null
netsh advfirewall set allprofiles state off | Out-Null
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } | Select-Object -First 1).IPAddress
Set-Content C:\tb\out\ip.txt $ip
Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=true' | Select-Object -First 1 -ExpandProperty MACAddress | Set-Content C:\tb\out\mac.txt
Start-Process powershell.exe -ArgumentList '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', 'C:\tb\touchapp.ps1'
$env:TAHABLT_DATA_DIR = 'C:\tb\data'
Start-Process -FilePath 'C:\tb\node.exe' -ArgumentList 'C:\tb\app\server.js' -RedirectStandardOutput 'C:\tb\out\agent.log' -RedirectStandardError 'C:\tb\out\agent.err' -WindowStyle Hidden
Set-Content C:\tb\out\started.txt (Get-Date -Format o)
