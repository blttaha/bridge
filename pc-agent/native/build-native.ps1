# Builds BridgeHelper.exe (agent helper) and Bridge.exe (tray) with the in-box .NET Framework 4.x compiler.
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $Here "..\..")
$Fw = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
$Csc = Join-Path $Fw "csc.exe"
$SysRuntime = Get-ChildItem "$env:WINDIR\Microsoft.NET\assembly\GAC_MSIL\System.Runtime" -Recurse -Filter System.Runtime.dll | Select-Object -First 1

& $Csc -nologo -unsafe -optimize+ -platform:x64 -target:exe "-win32icon:$Here\app.ico" `
  "-out:$Here\BridgeHelper.exe" `
  -r:System.Web.Extensions.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll -r:System.Management.dll `
  "-r:$Fw\System.Runtime.WindowsRuntime.dll" "-r:$($SysRuntime.FullName)" `
  "$Here\BridgeHelper.cs" "$Here\ScreenStreamer.cs" "$Here\VideoEncoder.cs" "$Here\TouchInjector.cs"
if ($LASTEXITCODE -ne 0) { throw "BridgeHelper build failed" }

& $Csc -nologo -optimize+ -platform:x64 -target:winexe "-win32icon:$Here\app.ico" `
  "-out:$Root\Bridge.exe" `
  -r:System.Web.Extensions.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll -r:System.ServiceProcess.dll `
  "$Here\BridgeTray.cs"
if ($LASTEXITCODE -ne 0) { throw "Bridge (tray) build failed" }

Write-Output "NATIVE_BUILD_SUCCESS"
