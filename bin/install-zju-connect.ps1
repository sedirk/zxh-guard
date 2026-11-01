# Downloads the unmodified upstream VPN engine. No credentials or VPN login required.
# zju-connect v1.3.1 is AGPL-3.0; see THIRD_PARTY_NOTICES.md.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
$version = 'v1.3.1'
$url = "https://github.com/Mythologyli/zju-connect/releases/download/$version/zju-connect-windows-amd64.zip"
$expectedExeHash = 'AEE7D8DBBF4DB98FBFF2B36D657094D95F3F6209DC3168914C62AEA01A8732BE'
$destination = Join-Path $PSScriptRoot 'zju-connect.exe'
if (Test-Path -LiteralPath $destination) {
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -eq $expectedExeHash) {
        Write-Host "Verified existing zju-connect $version. Nothing changed."
        exit 0
    }
    throw 'An unrecognized zju-connect.exe already exists. Back it up or remove it before installing.'
}
$tempRoot = if ($env:PI_SCRATCH_DIR) { $env:PI_SCRATCH_DIR } else { [IO.Path]::GetTempPath() }
$temp = Join-Path $tempRoot ('zxh-engine-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $archive = Join-Path $temp 'engine.zip'
    Write-Host "Downloading official zju-connect $version (Windows amd64)..."
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive -TimeoutSec 180
    $unpack = Join-Path $temp 'unpacked'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpack
    $executables = @(Get-ChildItem -LiteralPath $unpack -Recurse -File -Filter 'zju-connect.exe')
    if ($executables.Count -ne 1) { throw 'Unexpected upstream archive layout.' }
    if ((Get-FileHash -LiteralPath $executables[0].FullName -Algorithm SHA256).Hash -ne $expectedExeHash) {
        throw 'SHA-256 mismatch. The downloaded executable will NOT be installed.'
    }
    # Copy without overwrite: never replace an engine installed concurrently.
    [IO.File]::Copy($executables[0].FullName, $destination, $false)
    Write-Host "Installed and verified $destination"
    Write-Host 'Next: copy config.example.json to config.json and fill your own credentials.'
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
