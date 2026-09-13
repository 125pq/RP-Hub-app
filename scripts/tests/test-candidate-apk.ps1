$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$run = Join-Path $root ('.work/compose/apk-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run -Force | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$bytes = $utf8.GetBytes('candidate')
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
$report = @{ status = 'verified-candidate'; outputSha256 = 'fixture'; comparison = @(@{ file = 'index.html'; sha256 = $digest }) }
[IO.File]::WriteAllText((Join-Path $run 'report.json'), ($report | ConvertTo-Json -Depth 5), $utf8)
$verifier = Join-Path $root 'scripts/android/verify-candidate-apk.ps1'
foreach ($case in @('exact', 'changed', 'missing', 'extra', 'duplicate', 'wrong-case')) {
    $apk = Join-Path $run ($case + '.apk')
    $archive = [IO.Compression.ZipFile]::Open($apk, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $names = @('assets/public/index.html', 'assets/public/cordova.js')
        if ($case -eq 'missing') { $names = @('assets/public/cordova.js') }
        if ($case -eq 'extra') { $names += 'assets/public/stale.js' }
        if ($case -eq 'duplicate') { $names += 'assets/public/index.html' }
        if ($case -eq 'wrong-case') { $names = @('assets/public/INDEX.html') }
        foreach ($name in $names) {
            $entry = $archive.CreateEntry($name)
            $stream = $entry.Open()
            try {
                $content = $bytes
                if ($case -eq 'changed') { $content = $utf8.GetBytes('wrong') }
                $stream.Write($content, 0, $content.Length)
            } finally { $stream.Dispose() }
        }
    } finally { $archive.Dispose() }
    # A previous success must not survive a failed recheck.
    [IO.File]::WriteAllText(($apk + '.candidate.json'), '{"status":"passed"}', $utf8)
    $failed = $false
    try { & $verifier -CandidateRun $run -Apk $apk | Out-Null }
    catch { $failed = $true }
    if ($failed -ne ($case -ne 'exact')) { throw "Wrong verification result: $case" }
    $proof = Get-Content -LiteralPath ($apk + '.candidate.json') -Raw | ConvertFrom-Json
    $expected = if ($case -eq 'exact') { 'passed' } else { 'failed' }
    if ($proof.status -ne $expected) { throw "Stale proof status: $case" }
}
Write-Output 'Candidate APK: byte identity, missing/changed/extra/duplicate rejection and stale proof invalidation PASS'
