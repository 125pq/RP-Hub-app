param(
    [Parameter(Mandatory = $true)][string]$CandidateRun,
    [Parameter(Mandatory = $true)][string]$Apk
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-utils.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$reportPath = $Apk + '.candidate.json'
[System.IO.File]::WriteAllText($reportPath, '{"status":"failed"}', (New-Object System.Text.UTF8Encoding($false)))
$build = Get-Content -LiteralPath (Join-Path $CandidateRun 'report.json') -Raw | ConvertFrom-Json
if ($build.status -ne 'verified-candidate') { throw 'Candidate build report is not verified.' }
$expected = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::Ordinal)
foreach ($file in $build.comparison) { $expected['assets/public/' + $file.file] = $file.sha256 }
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Apk).Path)
$seen = New-Object 'System.Collections.Generic.Dictionary[string,bool]' ([System.StringComparer]::Ordinal)
try {
    foreach ($entry in $zip.Entries) {
        if (-not $entry.FullName.StartsWith('assets/public/') -or $entry.FullName.EndsWith('/')) { continue }
        if ($seen.ContainsKey($entry.FullName)) { throw "Duplicate APK asset: $($entry.FullName)" }
        $seen[$entry.FullName] = $true
        if (-not $expected.ContainsKey($entry.FullName)) {
            if ($entry.FullName -cnotin @('assets/public/cordova.js', 'assets/public/cordova_plugins.js')) {
                throw "Unexpected APK web asset: $($entry.FullName)"
            }
            continue
        }
        $stream = $entry.Open()
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $actual = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally { $stream.Dispose(); $sha.Dispose() }
        if ($actual -ne $expected[$entry.FullName]) { throw "Candidate/APK mismatch: $($entry.FullName)" }
        [void]$expected.Remove($entry.FullName)
    }
    if ($expected.Count -ne 0) { throw "Missing APK web assets: $($expected.Keys -join ', ')" }
} finally { $zip.Dispose() }
$proof = [ordered]@{
    status = 'passed'
    candidateOutputSha256 = $build.outputSha256
    apkSha256 = Get-RPHubSha256Hex $Apk
    matchedWebFiles = $build.comparison.Count
    limitations = 'Packaged web asset identity; not device behavior acceptance.'
}
[System.IO.File]::WriteAllText($reportPath, ($proof | ConvertTo-Json) + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Output "CANDIDATE_APK_PROOF=$reportPath"
