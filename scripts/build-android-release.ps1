$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $projectRoot 'android'
$toolchainRoot = Join-Path (Split-Path -Parent $projectRoot) '.android-toolchain'

function Test-JdkHome([string]$Path) {
    return $Path -and (Test-Path -LiteralPath (Join-Path $Path 'bin\java.exe')) -and (Test-Path -LiteralPath (Join-Path $Path 'bin\javac.exe'))
}

function Find-JdkHome {
    $candidates = @($env:JAVA_HOME, 'C:\Program Files\Android\Android Studio\jbr')
    $toolchainJdks = Get-ChildItem -LiteralPath (Join-Path $toolchainRoot 'jdk') -Directory -ErrorAction SilentlyContinue
    $candidates += $toolchainJdks.FullName
    foreach ($candidate in $candidates) {
        if (Test-JdkHome $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw 'JDK 21 was not found. Set JAVA_HOME to a JDK 21 installation.'
}

function Test-AndroidSdk([string]$Path) {
    return $Path -and (Test-Path -LiteralPath (Join-Path $Path 'platforms\android-35\android.jar')) -and (Test-Path -LiteralPath (Join-Path $Path 'build-tools\35.0.0\apksigner.bat'))
}

function Find-AndroidSdk {
    $candidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'), (Join-Path $toolchainRoot 'android-sdk'))
    foreach ($candidate in $candidates) {
        if (Test-AndroidSdk $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw 'Android SDK Platform 35 and Build Tools 35.0.0 were not found. Set ANDROID_HOME.'
}

$jdkHome = Find-JdkHome
$androidSdk = Find-AndroidSdk
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$javaOutput = & (Join-Path $jdkHome 'bin\java.exe') -version 2>&1
$javaExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorActionPreference
if ($javaExitCode -ne 0 -or ($javaOutput -join "`n") -notmatch 'version "21(?:\.|\")') {
    throw "JAVA_HOME must point to JDK 21. Detected output: $($javaOutput -join ' ')"
}

$env:JAVA_HOME = $jdkHome
$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk
$env:Path = (Join-Path $jdkHome 'bin') + ';' + (Join-Path $androidSdk 'platform-tools') + ';' + $env:Path
if ($env:JAVA_TOOL_OPTIONS -notmatch 'javax\.net\.ssl\.trustStoreType=') {
    $env:JAVA_TOOL_OPTIONS = (($env:JAVA_TOOL_OPTIONS, '-Djavax.net.ssl.trustStoreType=Windows-ROOT') | Where-Object { $_ }) -join ' '
}

Write-Output "BUILD_TARGET=production"
Write-Output "JAVA_HOME=$jdkHome"
Write-Output "ANDROID_HOME=$androidSdk"

Push-Location $projectRoot
try {
    & npm.cmd run android:sync
    if ($LASTEXITCODE -ne 0) { throw 'Capacitor Android sync failed.' }

    & (Join-Path $androidRoot 'gradlew.bat') --project-dir $androidRoot clean assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Android production release build failed.' }

    $sourceApk = Join-Path $androidRoot 'app\build\outputs\apk\release\app-release.apk'
    if (-not (Test-Path -LiteralPath $sourceApk)) { throw "Release APK was not created: $sourceApk" }

    $outputDirectory = Join-Path $projectRoot 'release_apk'
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $versionName = if ($env:RPHUB_VERSION_NAME) { $env:RPHUB_VERSION_NAME } else { '1.8.3.6' }
    $outputApk = Join-Path $outputDirectory "RP-Hub-$versionName-release.apk"
    Copy-Item -LiteralPath $sourceApk -Destination $outputApk -Force

    $apksigner = Join-Path $androidSdk 'build-tools\35.0.0\apksigner.bat'
    & $apksigner verify --verbose --print-certs $outputApk
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }

    $apk = Get-Item -LiteralPath $outputApk
    $hash = Get-FileHash -LiteralPath $outputApk -Algorithm SHA256
    Write-Output "APK=$($apk.FullName)"
    Write-Output "APK_BYTES=$($apk.Length)"
    Write-Output "APK_SHA256=$($hash.Hash.ToLowerInvariant())"
} finally {
    Pop-Location
}
