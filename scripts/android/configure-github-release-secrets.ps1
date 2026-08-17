[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Repository = '125pq/RP-Hub-app',
    [string]$PropertiesPath
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDirectory)
if ([string]::IsNullOrWhiteSpace($PropertiesPath)) {
    $PropertiesPath = Join-Path $projectRoot 'keystore.properties'
}
$requiredProperties = @('storeFile', 'storePassword', 'keyAlias', 'keyPassword')
$secretNames = @(
    'RPHUB_RELEASE_KEYSTORE_BASE64',
    'RPHUB_RELEASE_STORE_PASSWORD',
    'RPHUB_RELEASE_KEY_ALIAS',
    'RPHUB_RELEASE_KEY_PASSWORD'
)

function Find-GitHubCli {
    $command = Get-Command gh.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $candidates = @(
        'C:\Program Files\GitHub CLI\gh.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\GitHub CLI\gh.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'GitHub CLI (gh.exe) was not found. Install it and run gh auth login first.'
}

function Read-JavaProperties([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Signing properties file was not found: $Path"
    }

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#') -or $trimmed.StartsWith('!')) { continue }
        $separator = $line.IndexOf('=')
        if ($separator -lt 1) { continue }
        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        $values[$name] = $value
    }
    return $values
}

function Resolve-KeystorePath([string]$Value, [string]$PropertiesFile) {
    if ([IO.Path]::IsPathRooted($Value)) {
        if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) {
            throw "The configured release keystore does not exist: $Value"
        }
        return (Resolve-Path -LiteralPath $Value).Path
    }

    $propertiesDirectory = Split-Path -Parent (Resolve-Path -LiteralPath $PropertiesFile).Path
    $candidates = @(
        (Join-Path $propertiesDirectory $Value),
        (Join-Path (Join-Path $projectRoot 'android\app') $Value),
        (Join-Path $projectRoot $Value)
    ) | Select-Object -Unique

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw "The release keystore from storeFile could not be resolved. Checked: $($candidates -join ', ')"
}

function Set-RepositorySecretFromStdin {
    param(
        [Parameter(Mandatory = $true)][string]$GitHubCli,
        [Parameter(Mandatory = $true)][string]$RepositoryName,
        [Parameter(Mandatory = $true)][string]$SecretName,
        [Parameter(Mandatory = $true)][string]$SecretValue
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $GitHubCli
    $startInfo.Arguments = "secret set $SecretName --repo $RepositoryName --app actions"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Could not start GitHub CLI for $SecretName" }
    $process.StandardInput.Write($SecretValue)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "GitHub CLI failed while setting $SecretName. $($stderr.Trim())"
    }
    if ($stdout.Trim()) { Write-Verbose $stdout.Trim() }
}

$gh = Find-GitHubCli
$resolvedProperties = (Resolve-Path -LiteralPath $PropertiesPath).Path
$properties = Read-JavaProperties $resolvedProperties
foreach ($name in $requiredProperties) {
    if (-not $properties.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($properties[$name])) {
        throw "Required signing property is missing or empty: $name"
    }
}

$keystorePath = Resolve-KeystorePath $properties.storeFile $resolvedProperties
$keystore = Get-Item -LiteralPath $keystorePath
if ($keystore.Length -le 0) { throw 'The configured release keystore is empty.' }

& $gh auth status --hostname github.com
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI is not authenticated. Run gh auth login first.' }

Write-Output "Repository: $Repository"
Write-Output "Properties: $resolvedProperties"
Write-Output "Keystore: $($keystore.FullName) ($($keystore.Length) bytes)"
Write-Output 'Secret values will not be printed.'

$values = [ordered]@{
    RPHUB_RELEASE_KEYSTORE_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keystore.FullName))
    RPHUB_RELEASE_STORE_PASSWORD = $properties.storePassword
    RPHUB_RELEASE_KEY_ALIAS = $properties.keyAlias
    RPHUB_RELEASE_KEY_PASSWORD = $properties.keyPassword
}

try {
    foreach ($name in $secretNames) {
        if ($PSCmdlet.ShouldProcess("$Repository/$name", 'Create or update GitHub Actions repository secret')) {
            Set-RepositorySecretFromStdin -GitHubCli $gh -RepositoryName $Repository -SecretName $name -SecretValue $values[$name]
            Write-Output "${name}: configured"
        }
    }
} finally {
    foreach ($name in $secretNames) { $values[$name] = $null }
    $properties.Clear()
}

if (-not $WhatIfPreference) {
    $configured = @(& $gh secret list --repo $Repository --app actions --json name --jq '.[].name')
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the repository secret names.' }
    $missing = $secretNames | Where-Object { $_ -notin $configured }
    if ($missing) { throw "Secret verification failed. Missing: $($missing -join ', ')" }
    Write-Output 'GitHub release signing secrets: PASS'
}
