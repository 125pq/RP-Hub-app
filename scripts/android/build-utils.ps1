$script:RPHubVersionPattern = '^[0-9A-Za-z][0-9A-Za-z._-]*$'

function Test-RPHubVersion([object]$Value, [string]$Source) {
    if ($Value -eq $null -or $Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
        throw "Invalid $Source version: expected a non-empty string."
    }
    if ($Value -notmatch $script:RPHubVersionPattern) {
        throw "Invalid $Source version '$Value': only letters, digits, '.', '_' and '-' are allowed."
    }
    return $Value
}

function Get-RPHubPackageVersion([string]$PackageJsonPath) {
    if (-not (Test-Path -LiteralPath $PackageJsonPath -PathType Leaf)) {
        throw "package.json was not found: $PackageJsonPath"
    }
    try {
        $package = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
    } catch {
        throw "Could not parse package.json: $($_.Exception.Message)"
    }
    if (-not ($package.PSObject.Properties.Name -contains 'version')) {
        throw "package.json version is missing: $PackageJsonPath"
    }
    return Test-RPHubVersion $package.version 'package.json'
}

function Get-RPHubBuildVersion([string]$PackageJsonPath, [object]$EnvironmentValue) {
    if ($EnvironmentValue -ne $null -and $EnvironmentValue -isnot [string]) {
        throw 'Invalid RPHUB_VERSION_NAME version: expected a string.'
    }
    if ($EnvironmentValue -is [string] -and -not [string]::IsNullOrWhiteSpace($EnvironmentValue)) {
        return Test-RPHubVersion $EnvironmentValue 'RPHUB_VERSION_NAME'
    }
    return Get-RPHubPackageVersion $PackageJsonPath
}

function Get-RPHubSha256Hex([string]$Path) {
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
