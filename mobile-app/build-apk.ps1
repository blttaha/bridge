$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AndroidDir = Join-Path $RootDir "mobile-app\android"
$WwwDir = Join-Path $RootDir "mobile-app\www"
$AssetsDir = Join-Path $AndroidDir "assets"
$BuildDir = Join-Path $AndroidDir "build"
$OutApk = Join-Path $RootDir "Bridge.apk"

$BuildTools = "C:\Android\build-tools\35.0.0"
$AndroidJar = "C:\Android\platforms\android-35\android.jar"
$JdkBin = "C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot\bin"

$Aapt2 = Join-Path $BuildTools "aapt2.exe"
$D8 = Join-Path $BuildTools "d8.bat"
$ZipAlign = Join-Path $BuildTools "zipalign.exe"
$ApkSigner = Join-Path $BuildTools "apksigner.bat"
$Javac = Join-Path $JdkBin "javac.exe"
$JarExe = Join-Path $JdkBin "jar.exe"
$Keytool = Join-Path $JdkBin "keytool.exe"

if (Test-Path $BuildDir) { Remove-Item $BuildDir -Recurse -Force }
if (Test-Path $AssetsDir) { Remove-Item $AssetsDir -Recurse -Force }

New-Item -ItemType Directory -Path $AssetsDir -Force | Out-Null
New-Item -ItemType Directory -Path "$BuildDir\gen" -Force | Out-Null
New-Item -ItemType Directory -Path "$BuildDir\classes" -Force | Out-Null
New-Item -ItemType Directory -Path "$BuildDir\dex" -Force | Out-Null

# 1. Copy web UI assets directly into Android assets/ (flat root so no Windows backslash in zip path)
Copy-Item -Path "$WwwDir\*" -Destination $AssetsDir -Force

# 2. Compile resources with aapt2
& $Aapt2 compile --dir (Join-Path $AndroidDir "res") -o "$BuildDir\resources.zip"

# 3. Link resources + manifest + assets with aapt2
& $Aapt2 link `
  -I $AndroidJar `
  --manifest (Join-Path $AndroidDir "AndroidManifest.xml") `
  -A (Join-Path $AndroidDir "assets") `
  --java "$BuildDir\gen" `
  -o "$BuildDir\unaligned.apk" `
  "$BuildDir\resources.zip"

# 4. Compile Java sources with javac (target Java 11 bytecode for d8)
$JavaFiles = @(Join-Path $BuildDir "gen\com\tahablt\bridge\R.java") +
  @(Get-ChildItem (Join-Path $AndroidDir "src\com\tahablt\bridge") -Filter *.java | ForEach-Object { $_.FullName })
& $Javac --release 11 -encoding UTF-8 -cp $AndroidJar -d "$BuildDir\classes" $JavaFiles

# 5. Package classes into JAR and convert to DEX with d8
& $JarExe cf "$BuildDir\classes.jar" -C "$BuildDir\classes" .
& $D8 --lib $AndroidJar --output "$BuildDir\dex" "$BuildDir\classes.jar"

# 6. Insert classes.dex into unaligned.apk
& $JarExe uf "$BuildDir\unaligned.apk" -C "$BuildDir\dex" classes.dex

# 7. Zipalign the APK
& $ZipAlign -f -p 4 "$BuildDir\unaligned.apk" "$BuildDir\aligned.apk"

# 8. Sign with the Bridge release key. Key and password live outside the repository (default:
#    %USERPROFILE%\.bridge-signing). The first build creates both there: back that folder up. Android only accepts
#    updates signed with the same key, and its fingerprint is what Google's developer console registers.
$SigningDir = if ($env:BRIDGE_SIGNING_DIR) { $env:BRIDGE_SIGNING_DIR } else { Join-Path $env:USERPROFILE ".bridge-signing" }
$Keystore = Join-Path $SigningDir "bridge-release.keystore"
$PassFile = Join-Path $SigningDir "keystore-password.txt"
$KeystorePass = if ($env:BRIDGE_KEYSTORE_PASS) { $env:BRIDGE_KEYSTORE_PASS } elseif (Test-Path $PassFile) { (Get-Content $PassFile -Raw).Trim() } else { "" }
if (-not (Test-Path $Keystore)) {
  if (-not $KeystorePass) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $KeystorePass = [Convert]::ToBase64String($bytes) -replace '[+/=]', 'x'
    New-Item -ItemType Directory -Force $SigningDir | Out-Null
    Set-Content -Path $PassFile -Value $KeystorePass -NoNewline -Encoding ASCII
  }
  & $Keytool -genkeypair `
    -keystore $Keystore `
    -alias bridge `
    -keyalg RSA `
    -keysize 4096 `
    -validity 10000 `
    -storepass $KeystorePass `
    -keypass $KeystorePass `
    -dname "CN=Bridge, O=Bridge, L=Istanbul, C=TR"
  if ($LASTEXITCODE -ne 0) { throw "Keystore could not be created." }
  Write-Output "New signing key created in $SigningDir - back this folder up."
}
if (-not $KeystorePass) { throw "Keystore password not found: set BRIDGE_KEYSTORE_PASS or create $PassFile." }

& $ApkSigner sign `
  --ks $Keystore `
  --ks-pass "pass:$KeystorePass" `
  --key-pass "pass:$KeystorePass" `
  --min-sdk-version 24 `
  --v1-signing-enabled true `
  --v2-signing-enabled true `
  --v3-signing-enabled true `
  --v4-signing-enabled false `
  --out $OutApk `
  "$BuildDir\aligned.apk"
# A wrong password used to leave the previous APK in place and still report success
if ($LASTEXITCODE -ne 0) { throw "APK signing failed (wrong keystore password?); $OutApk was not updated." }

& $ApkSigner verify -v $OutApk
if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed." }
Write-Output "APK_BUILD_SUCCESS: $OutApk"
