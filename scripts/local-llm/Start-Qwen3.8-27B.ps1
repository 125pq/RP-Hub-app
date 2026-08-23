[CmdletBinding()]
param(
    [ValidateRange(4096, 262144)]
    [int]$ContextSize = 32768,

    [ValidateRange(1, 65535)]
    [int]$Port = 8080,

    [switch]$EnableMtp,

    [ValidateRange(30, 900)]
    [int]$StartupTimeoutSeconds = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtimeRoot = Join-Path $repoRoot '.local\qwen3.8-27b'
$serverPath = Join-Path $runtimeRoot 'bin\llama-server.exe'
$modelPath = Join-Path $runtimeRoot 'models\Qwen3.8-27B-UD-IQ4_XS.gguf'
$logDir = Join-Path $runtimeRoot 'logs'
$stateDir = Join-Path $runtimeRoot 'state'
$pidPath = Join-Path $stateDir 'server.pid'
$statePath = Join-Path $stateDir 'active.json'
$apiBase = "http://127.0.0.1:$Port/v1"

if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    throw "llama-server was not found: $serverPath"
}

if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) {
    throw "Model was not found: $modelPath"
}

New-Item -ItemType Directory -Force -Path $logDir, $stateDir | Out-Null

if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $existingPid = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    $existingProcess = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($null -ne $existingProcess) {
        $existingPath = $null
        try { $existingPath = $existingProcess.Path } catch { }
        if ($existingPath -and ([System.IO.Path]::GetFullPath($existingPath) -ne [System.IO.Path]::GetFullPath($serverPath))) {
            throw "PID $existingPid belongs to another process. Refusing to stop or replace it."
        }

        $activeState = if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        } else {
            $null
        }
        $activeMtp = $null -ne $activeState -and
            $null -ne $activeState.PSObject.Properties['mtpEnabled'] -and
            [bool]$activeState.mtpEnabled
        if ($null -ne $activeState -and
            ($activeState.contextSize -ne $ContextSize -or
             $activeState.port -ne $Port -or
             $activeMtp -ne [bool]$EnableMtp)) {
            throw "Qwen3.8-27B is already running with context $($activeState.contextSize), port $($activeState.port), MTP=$activeMtp. Stop it before changing profiles."
        }

        Write-Host "Qwen3.8-27B is already running (PID $existingPid)."
        Write-Host "API: $apiBase"
        exit 0
    }
}

$portPattern = ":$Port\s+.*LISTENING\s+(\d+)\s*$"
$portOwner = netstat.exe -ano -p TCP | Select-String $portPattern | Select-Object -First 1
if ($null -ne $portOwner -and $portOwner.Line -match $portPattern) {
    throw "TCP port $Port is already in use by PID $($Matches[1])."
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutLog = Join-Path $logDir "server-$stamp.out.log"
$stderrLog = Join-Path $logDir "server-$stamp.err.log"

# These arguments make GPU residency explicit. --fit is disabled so llama.cpp
# cannot silently reduce GPU layers or context to fit the card.
$serverArgs = @(
    '--model', ('"{0}"' -f $modelPath),
    '--alias', 'qwen3.8-27b-ud-iq4-xs',
    '--host', '127.0.0.1',
    '--port', $Port,
    '--ctx-size', $ContextSize,
    '--n-gpu-layers', 'all',
    '--device', 'CUDA0',
    '--split-mode', 'none',
    '--main-gpu', '0',
    '--fit', 'off',
    '--kv-offload',
    '--cache-type-k', 'q4_0',
    '--cache-type-v', 'q4_0',
    '--flash-attn', 'on',
    '--parallel', '1',
    '--batch-size', '1024',
    '--ubatch-size', '256',
    '--load-mode', 'dio',
    '--no-host',
    '--no-mmproj',
    '--offline',
    '--jinja',
    '--temp', '1.0',
    '--top-k', '20',
    '--top-p', '0.95',
    '--min-p', '0.0',
    '--repeat-penalty', '1.0',
    '--cache-ram', '0',
    '--metrics',
    '--no-webui',
    '--log-verbosity', '4',
    '--log-timestamps',
    '--log-prefix'
)

if ($EnableMtp) {
    $serverArgs += @(
        '--spec-type', 'draft-mtp',
        '--spec-draft-n-max', '2',
        '--spec-draft-n-min', '0',
        '--spec-draft-p-min', '0.0',
        '--spec-draft-device', 'CUDA0',
        '--spec-draft-ngl', 'all',
        '--spec-draft-type-k', 'f16',
        '--spec-draft-type-v', 'f16'
    )
} else {
    $serverArgs += @('--spec-type', 'none')
}

$process = Start-Process `
    -FilePath $serverPath `
    -ArgumentList $serverArgs `
    -WorkingDirectory (Split-Path -Parent $serverPath) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii

$state = [ordered]@{
    pid = $process.Id
    startedAt = (Get-Date).ToString('o')
    contextSize = $ContextSize
    port = $Port
    mtpEnabled = [bool]$EnableMtp
    model = $modelPath
    apiBase = $apiBase
    stdoutLog = $stdoutLog
    stderrLog = $stderrLog
    arguments = $serverArgs
}
$state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding utf8

$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$modelsResponse = $null
while ((Get-Date) -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) {
        break
    }

    try {
        $modelsResponse = Invoke-RestMethod -Uri "$apiBase/models" -Method Get -TimeoutSec 5
        if ($modelsResponse.data.Count -gt 0) {
            break
        }
    } catch {
        Start-Sleep -Seconds 2
    }
}

$process.Refresh()
if ($process.HasExited -or $null -eq $modelsResponse) {
    $tail = if (Test-Path -LiteralPath $stderrLog) {
        (Get-Content -LiteralPath $stderrLog -Tail 80) -join [Environment]::NewLine
    } else {
        '(no server log was created)'
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    throw "Qwen3.8-27B failed to become ready.`n$tail"
}

$startupLog = (Get-Content -LiteralPath $stderrLog -Raw)
if ($startupLog -notmatch 'offloaded\s+(\d+)/\1\s+layers\s+to\s+GPU') {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    throw "The startup log does not prove that every model layer was offloaded to the GPU. Server stopped. See: $stderrLog"
}

if ($EnableMtp -and
    ($startupLog -notmatch "adding speculative implementation 'draft-mtp'" -or
     $startupLog -notmatch 'speculative decoding context initialized')) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    throw "MTP was requested but did not initialize successfully. Server stopped. See: $stderrLog"
}

Write-Host "Qwen3.8-27B is ready (PID $($process.Id), context $ContextSize)."
Write-Host "API: $apiBase"
Write-Host "Model: $modelPath"
Write-Host "Log: $stderrLog"
