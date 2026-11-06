# Shared Windows process/lock helpers. Dot-sourcing this file has no side effects.
function Enter-VpnActionLock([string]$Name = 'Local\NuaaCampusVpnLifecycle', [int]$TimeoutMs = 0) {
  $m = New-Object System.Threading.Mutex($false, $Name)
  try {
    try { $held = $m.WaitOne($TimeoutMs) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    if ($held) { return $m }
    $m.Dispose(); return $null
  } catch { $m.Dispose(); throw }
}
function Exit-VpnActionLock($Lock) {
  if ($null -ne $Lock) { try { $Lock.ReleaseMutex() } finally { $Lock.Dispose() } }
}
function Test-VpnPort([string]$HostName, [int]$Port, [int]$TimeoutMs = 250) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $c.BeginConnect($HostName, $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $c.EndConnect($pending); return $true
  } catch { return $false } finally { $c.Close() }
}
function Get-OwnedVpnProcess($State, [string]$Exe) {
  if (-not $State -or $State.external -or [int]$State.pid -le 0 -or -not $State.processStartedAt) { return $null }
  try {
    $p = Get-Process -Id ([int]$State.pid) -ErrorAction Stop
    if ($p.ProcessName -ne 'zju-connect' -or $p.Path -ne $Exe) { return $null }
    if ($p.StartTime.ToUniversalTime().ToString('o') -ne [string]$State.processStartedAt) { return $null }
    return $p
  } catch { return $null }
}
function Get-VpnSnapshot([string]$StateFile, [string]$Exe, [string]$HttpBind, [string]$SocksBind) {
  $record = $null
  try { $record = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch { }
  $owned = Get-OwnedVpnProcess $record $Exe
  $h = $HttpBind.Split(':'); $s = $SocksBind.Split(':')
  $httpUp = Test-VpnPort $h[0] ([int]$h[1])
  $socksUp = Test-VpnPort $s[0] ([int]$s[1])
  $state = 'stopped'
  if ($owned) { $state = if ($httpUp -and $socksUp) { 'ready' } else { 'starting' } }
  elseif ($httpUp -or $socksUp) { $state = 'external' }
  [pscustomobject]@{ state = $state; pid = $(if ($owned) { $owned.Id } else { $null }); external = ($state -eq 'external'); http = $HttpBind; socks = $SocksBind; record = $record }
}
function Write-VpnJson([string]$File, $Value) {
  $temp = $File + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  try {
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $File) { [IO.File]::Replace($temp, $File, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temp, $File) }
  } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
function ConvertTo-VpnArgument([string]$Value) {
  # CommandLineToArgvW escaping for Windows PowerShell 5.1 Start-Process.
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}
function Remove-VpnStartMarker([string]$File, [string]$Token) {
  if (-not $Token) { return }
  try {
    if ((Get-Content -LiteralPath $File -Raw -ErrorAction Stop).Trim() -eq $Token) {
      Remove-Item -LiteralPath $File -Force -ErrorAction Stop
    }
  } catch { }
}
