$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$androidRoot = Join-Path $projectRoot 'android'
$toolchainRoot = Join-Path (Split-Path -Parent $projectRoot) '.android-toolchain'

function Test-JdkHome([string]$Path) {
    return $Path -and (Test-Path -LiteralPath (Join-Path $Path 'bin\java.exe')) -and (Test-Path -LiteralPath (Join-Path $Path 'bin\javac.exe'))
}

function Find-JdkHome {
    $candidates = @(
        $env:JAVA_HOME,
        'C:\Program Files\Android\Android Studio\jbr'
    )

    $toolchainJdks = Get-ChildItem -LiteralPath (Join-Path $toolchainRoot 'jdk') -Directory -ErrorAction SilentlyContinue
    $candidates += $toolchainJdks.FullName

    foreach ($candidate in $candidates) {
        if (Test-JdkHome $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw 'JDK 21 was not found. Set JAVA_HOME to a JDK 21 installation.'
}

function Test-AndroidSdk([string]$Path) {
    return $Path -and (Test-Path -LiteralPath (Join-Path $Path 'platforms\android-35\android.jar')) -and (Test-Path -LiteralPath (Join-Path $Path 'build-tools\35.0.0\aapt2.exe'))
}

function Find-AndroidSdk {
    $candidates = @(
        $env:ANDROID_HOME,
        $env:ANDROID_SDK_ROOT,
        (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
        (Join-Path $toolchainRoot 'android-sdk')
    )

    foreach ($candidate in $candidates) {
        if (Test-AndroidSdk $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw 'Android SDK Platform 35 and Build Tools 35.0.0 were not found. Set ANDROID_HOME.'
}

function Get-Sha256Hex([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

$jdkHome = Find-JdkHome
$androidSdk = Find-AndroidSdk
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$javaVersion = & (Join-Path $jdkHome 'bin\java.exe') -version 2>&1
$javaExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($javaExitCode -ne 0 -or ($javaVersion -join "`n") -notmatch 'version "21(?:\.|\")') {
    throw "JAVA_HOME must point to JDK 21. Detected output: $($javaVersion -join ' ')"
}

$env:JAVA_HOME = $jdkHome
$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk
$env:Path = (Join-Path $jdkHome 'bin') + ';' + (Join-Path $androidSdk 'platform-tools') + ';' + $env:Path
if ($env:JAVA_TOOL_OPTIONS -notmatch 'javax\.net\.ssl\.trustStoreType=') {
    $env:JAVA_TOOL_OPTIONS = (($env:JAVA_TOOL_OPTIONS, '-Djavax.net.ssl.trustStoreType=Windows-ROOT') | Where-Object { $_ }) -join ' '
}

Write-Output "JAVA_HOME=$jdkHome"
Write-Output "ANDROID_HOME=$androidSdk"

Push-Location $projectRoot
try {
    & npm.cmd run android:sync
    if ($LASTEXITCODE -ne 0) { throw 'Capacitor Android sync failed.' }

    & (Join-Path $androidRoot 'gradlew.bat') --project-dir $androidRoot clean assembleDebug
    if ($LASTEXITCODE -ne 0) { throw 'Android debug build failed.' }

    $sourceApk = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path -LiteralPath $sourceApk)) { throw "Debug APK was not created: $sourceApk" }

    $outputDirectory = Join-Path $projectRoot 'debug_apk'
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $versionName = if ($env:RPHUB_VERSION_NAME) { $env:RPHUB_VERSION_NAME } else { '1.8.3.6' }
    $outputApk = Join-Path $outputDirectory "RP-Hub-$versionName-debug.apk"
    Copy-Item -LiteralPath $sourceApk -Destination $outputApk -Force

    $apk = Get-Item -LiteralPath $outputApk
    $hash = Get-Sha256Hex $outputApk
    Write-Output "APK=$($apk.FullName)"
    Write-Output "APK_BYTES=$($apk.Length)"
    Write-Output "APK_SHA256=$hash"
} finally {
    Pop-Location
}
