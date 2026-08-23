<#
.SYNOPSIS
    一键：打 debug 包 -> adb 连接检测 -> 安装到手机。

.DESCRIPTION
    编排脚本，复用现有构建与连接代码，**不修改任何构建/连接代码**：
      - 构建：复用 scripts/android/build-android-debug.ps1（其打印 APK= 路径，失败即 throw）
      - 连接：复用工具链 adb + 端口转发约定（等价 connect-phone-dsh.bat 的连接检测）
      - 安装：adb install -r -t

    特性：
      - 每步进度显示（[1/5] ...）
      - 构建失败自动重试（-BuildRetries，默认 2 次额外重试）
      - 设备未连接自动等待并重试（-DeviceRetries / -DeviceWaitSeconds）
      - 安装失败自动重试
      - 每步返回清晰成功/失败信息；任一失败返回非零退出码

.PARAMETER ApkName
    拷贝到 debug_apk 目录后的 APK 文件名（不含 .apk）。默认 "RP-Hub-debug"。
.PARAMETER BuildRetries
    构建失败时额外重试次数（不含首次）。默认 2。
.PARAMETER DeviceRetries
    设备检测失败时重试轮数。默认 10。
.PARAMETER DeviceWaitSeconds
    每轮设备检测的等待秒数。默认 5。
.PARAMETER SkipBuild
    跳过构建，仅连接并安装（使用 debug_apk 下已存在的 APK）。
.PARAMETER SkipInstall
    只构建并连接，不安装。
#>
[CmdletBinding()]
param(
    [string]$ApkName = 'RP-Hub-debug',
    [int]$BuildRetries = 2,
    [int]$DeviceRetries = 10,
    [int]$DeviceWaitSeconds = 5,
    [switch]$SkipBuild,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

# 目录：$PSScriptRoot = <项目根>/scripts/android ；$projectRoot = <项目根>
# .android-toolchain 位于 <工作区根>，即 projectRoot 的父目录。
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$workspaceRoot = Split-Path -Parent $projectRoot
$buildScript = Join-Path $PSScriptRoot 'build-android-debug.ps1'
$debugApkDir = Join-Path $projectRoot 'debug_apk'
function Find-Adb {
    # 不依赖 Get-Command：从 .bat 启动的 Windows PowerShell 可能拿不到
    # 用户 PATH，但 Android SDK 环境变量仍然可用。
    $localSdk = if ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    } else {
        $null
    }
    $sdkRoots = @(
        (Join-Path $workspaceRoot '.android-toolchain\android-sdk'),
        (Join-Path $projectRoot '.android-toolchain\android-sdk'),
        $env:ANDROID_HOME,
        $env:ANDROID_SDK_ROOT,
        $localSdk
    )

    foreach ($sdkRoot in ($sdkRoots | Where-Object { $_ } | Select-Object -Unique)) {
        $candidate = Join-Path $sdkRoot 'platform-tools\adb.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    # PATH 可能包含引号、空项或相对路径；逐项检查可兼容 PS 5.1。
    foreach ($pathEntry in (($env:Path -split ';') | Where-Object { $_ })) {
        $entry = $pathEntry.Trim().Trim('"')
        if (-not $entry) { continue }
        $candidate = Join-Path $entry 'adb.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    # 最后保留系统命令解析作为兜底（例如 PATHEXT/应用执行别名场景）。
    $command = Get-Command adb.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command -and $command.Source) { return $command.Source }
    return $null
}

$adb = Find-Adb
$appId = 'io.github.pq125.rphub.debug'

function Write-Step([string]$message) {
    Write-Host "`n=== $message ===" -ForegroundColor Cyan
}

function Write-Result([string]$message, [switch]$IsError) {
    if ($IsError) {
        Write-Host "[FAIL] $message" -ForegroundColor Red
    } else {
        Write-Host "[OK]   $message" -ForegroundColor Green
    }
}

function Invoke-Adb([string[]]$arguments, [switch]$AllowFail) {
    # PS5.1 treats native stderr as NativeCommandError under 'Stop'. Relax around
    # the call, then inspect $LASTEXITCODE ourselves.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $adb @arguments 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($code -ne 0 -and -not $AllowFail) {
        throw "adb $($arguments -join ' ') 失败 (exit=$code): $out"
    }
    return @{ Output = ($out -join "`n"); ExitCode = $code }
}

function Invoke-Native([scriptblock]$Script) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Script 2>&1
        return @{ Output = ($out -join "`n"); ExitCode = $LASTEXITCODE }
    } finally {
        $ErrorActionPreference = $prevEap
    }
}

# ---------------------------------------------------------------------------
# [1/5] 检查前置工具
# ---------------------------------------------------------------------------
Write-Step '1/5 检查前置工具 (adb / 构建脚本)'
if (-not (Test-Path -LiteralPath $buildScript)) {
    Write-Result "找不到构建脚本: $buildScript" -IsError
    exit 1
}
if (-not $adb) {
    Write-Result '找不到 adb.exe。请安装 Android SDK platform-tools，或将 adb 加入 PATH。' -IsError
    exit 1
}
Write-Result "adb = $adb"
Write-Result "构建脚本 = $buildScript"

# ---------------------------------------------------------------------------
# [2/5] 构建 debug APK（可选跳过，失败自动重试）
# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Step '2/5 构建 debug APK (复用 build-android-debug.ps1)'
    $builtApk = $null
    for ($attempt = 0; $attempt -le $BuildRetries; $attempt++) {
        if ($attempt -gt 0) {
            Write-Host "  构建失败，重试 $attempt/$BuildRetries ..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        }
        Write-Host "  构建中 (attempt $($attempt+1)/$($BuildRetries+1)) ..."
        try {
            $build = Invoke-Native { powershell.exe -NoProfile -ExecutionPolicy Bypass -File $buildScript }
            $code = $build.ExitCode
            $buildOutput = $build.Output
            $apkLine = ($buildOutput -split "`n" | Where-Object { $_ -match '^APK=' }) | Select-Object -Last 1
            if ($code -ne 0) { throw "构建脚本退出码非 0: $code" }
            if (-not $apkLine) { throw '构建脚本没有输出 APK= 路径' }
            $builtApk = ($apkLine -replace '^APK=', '').Trim()
            if (-not (Test-Path -LiteralPath $builtApk)) { throw "构建产物不存在: $builtApk" }
            break
        } catch {
            if ($attempt -lt $BuildRetries) { continue }
            Write-Result "构建失败: $($_.Exception.Message)" -IsError
            if ($buildOutput) {
                Write-Host "构建日志（末尾）:" -ForegroundColor DarkGray
                ($buildOutput -split "`n" | Select-Object -Last 30) | ForEach-Object {
                    Write-Host "  $_" -ForegroundColor DarkGray
                }
            }
            exit 2
        }
    }
    $targetApk = Join-Path $debugApkDir "$ApkName.apk"
    New-Item -ItemType Directory -Path $debugApkDir -Force | Out-Null
    Copy-Item -LiteralPath $builtApk -Destination $targetApk -Force
    $sizeMb = [math]::Round((Get-Item -LiteralPath $targetApk).Length / 1MB, 2)
    Write-Result "构建成功 -> $targetApk ($sizeMb MB)"
} else {
    Write-Step '2/5 跳过构建 (-SkipBuild)，使用已存在的 APK'
    $targetApk = Join-Path $debugApkDir "$ApkName.apk"
    if (-not (Test-Path -LiteralPath $targetApk) -and $ApkName -eq 'RP-Hub-debug') {
        $latestApk = Get-ChildItem -LiteralPath $debugApkDir -Filter '*-debug.apk' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latestApk) { $targetApk = $latestApk.FullName }
    }
    if (-not (Test-Path -LiteralPath $targetApk)) {
        Write-Result "找不到 APK: $targetApk (请先构建或去掉 -SkipBuild)" -IsError
        exit 2
    }
    Write-Result "使用现成 APK = $targetApk"
}

# ---------------------------------------------------------------------------
# [3/5] 启动 adb 服务
# ---------------------------------------------------------------------------
Write-Step '3/5 启动 adb 服务'
$srv = Invoke-Native { & $adb start-server }
if ($srv.ExitCode -ne 0) { Write-Result 'adb start-server 失败' -IsError; exit 3 }
Write-Result 'adb 服务已启动'

# ---------------------------------------------------------------------------
# [4/5] 等待并检测设备（失败自动重试）
# ---------------------------------------------------------------------------
Write-Step '4/5 检测 adb 设备 (USB 或无线)'
$device = $null
for ($attempt = 1; $attempt -le $DeviceRetries; $attempt++) {
    $dev = Invoke-Adb @('devices') -AllowFail
    $deviceLine = ($dev.Output -split "`n") |
        Where-Object { $_ -match '^\S+\s+device\s*$' } |
        Select-Object -First 1
    if ($deviceLine) {
        $device = ($deviceLine -split '\s+')[0]
        Write-Result "已检测到设备: $device"
        break
    }
    if ($attempt -lt $DeviceRetries) {
        Write-Host "  等待设备... (尝试 $attempt/$DeviceRetries, 每 $DeviceWaitSeconds 秒)" -ForegroundColor Yellow
        Start-Sleep -Seconds $DeviceWaitSeconds
    } else {
        Write-Result "未检测到任何 adb 设备。请插好 USB 并允许 USB 调试（或先 adb connect <ip:port>）" -IsError
        exit 4
    }
}

# 端口转发：手机 3080 -> PC 3080（等价 connect-phone-dsh.bat 约定）
$reverse = Invoke-Adb @('-s', $device, 'reverse', 'tcp:3080', 'tcp:3080') -AllowFail
if ($reverse.ExitCode -ne 0) {
    Write-Result "端口转发失败: $($reverse.Output)" -IsError
    exit 3
}
Write-Host "  端口转发已设置 (phone 3080 -> PC 3080)" -ForegroundColor DarkGray
# ---------------------------------------------------------------------------
# [5/5] 安装到手机（失败自动重试）
# ---------------------------------------------------------------------------
if ($SkipInstall) {
    Write-Step '5/5 跳过安装 (-SkipInstall)'
    Write-Result "已完成构建与连接，未安装。APK: $targetApk"
    exit 0
}

Write-Step '5/5 安装到手机'
$installRetries = 3
$installed = $false
for ($attempt = 0; $attempt -le $installRetries; $attempt++) {
    if ($attempt -gt 0) {
        Write-Host "  安装失败，重试 $attempt/$installRetries ..." -ForegroundColor Yellow
        Start-Sleep -Seconds 3
    }
    Write-Host "  安装中 (attempt $($attempt+1)/$($installRetries+1)) ..."
    $ins = Invoke-Native { & $adb -s $device install -r -t $targetApk }
    $installCode = $ins.ExitCode
    $installOut = $ins.Output
    if ($installCode -eq 0 -and $installOut -match 'Success') {
        $installed = $true
        break
    }
    if ($attempt -ge $installRetries) {
        Write-Result "安装失败: $installOut" -IsError
        exit 5
    }
}

if ($installed) {
    Write-Result '安装成功'
    $version = Invoke-Adb @('-s', $device, 'shell', 'dumpsys', 'package', $appId) -AllowFail
    $verLine = ($version.Output | Where-Object { $_ -match 'versionName=' } | Select-Object -First 1)
    if ($verLine) {
        $verName = ($verLine -replace '.*versionName=([^\s]+).*', '$1')
        Write-Host "  已安装版本: $verName" -ForegroundColor DarkGray
    }
    Write-Host "`n=== 完成: $targetApk ===" -ForegroundColor Green
    exit 0
}
