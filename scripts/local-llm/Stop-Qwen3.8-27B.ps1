[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtimeRoot = Join-Path $repoRoot '.local\qwen3.8-27b'
$serverPath = Join-Path $runtimeRoot 'bin\llama-server.exe'
$pidPath = Join-Path $runtimeRoot 'state\server.pid'
$statePath = Join-Path $runtimeRoot 'state\active.json'
$state = if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
} else {
    $null
}

if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    Write-Host 'Qwen3.8-27B is not running (no PID file).'
    exit 0
}

$serverPid = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if ($null -eq $process) {
    Remove-Item -LiteralPath $pidPath -Force
    Write-Host "Qwen3.8-27B was already stopped. Removed stale PID $serverPid."
    exit 0
}

$actualPath = $null
try { $actualPath = $process.Path } catch { }
if ($actualPath -and ([System.IO.Path]::GetFullPath($actualPath) -ne [System.IO.Path]::GetFullPath($serverPath))) {
    throw "PID $serverPid belongs to another process. Refusing to stop it."
}

Stop-Process -Id $serverPid -Force
try {
    Wait-Process -Id $serverPid -Timeout 15 -ErrorAction Stop
} catch {
    if ($null -ne (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
        throw "Qwen3.8-27B did not stop within 15 seconds (PID $serverPid)."
    }
}

if ($null -ne $state -and $null -ne $state.port) {
    $listenerPattern = ":$($state.port)\s+.*LISTENING\s+$serverPid\s*$"
    $listenerDeadline = (Get-Date).AddSeconds(15)
    do {
        $listener = netstat.exe -ano -p TCP | Select-String $listenerPattern | Select-Object -First 1
        if ($null -eq $listener) { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $listenerDeadline)

    if ($null -ne $listener) {
        throw "TCP port $($state.port) did not close within 15 seconds (PID $serverPid)."
    }
}

Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue

if ($null -ne $state) {
    $state | Add-Member -NotePropertyName stoppedAt -NotePropertyValue (Get-Date).ToString('o') -Force
    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding utf8
}

Write-Host "Qwen3.8-27B stopped (PID $serverPid)."
