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
function Resolve-VpnConfigFile([string]$PluginRoot) {
  # The package installer replaces the plugin directory and removes config.json.
  # PI-Desktop keeps a surviving copy in plugins\data\<plugin-id>\config.json.
  $rootConfig = Join-Path $PluginRoot 'config.json'
  if (Test-Path -LiteralPath $rootConfig) { return $rootConfig }
  $pluginsRoot = Split-Path -Parent (Split-Path -Parent $PluginRoot)
  $dataConfig = Join-Path (Join-Path $pluginsRoot 'data') (Join-Path (Split-Path -Leaf $PluginRoot) 'config.json')
  if (Test-Path -LiteralPath $dataConfig) { return $dataConfig }
  return $rootConfig
}
function Get-VpnFailureHint([object]$Record) {
  # Read only the tail of the engine logs. Never expose command-line credentials.
  if (-not $Record) { return '' }
  $text = ''
  foreach ($path in @($Record.stdout, $Record.stderr)) {
    $file = [string]$path
    if ([string]::IsNullOrWhiteSpace($file)) { continue }
    try {
      if (-not (Test-Path -LiteralPath $file)) { continue }
      $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      try {
        $length = [int][Math]::Min(8192, $stream.Length)
        if ($length -gt 0) {
          [void]$stream.Seek(-$length, [IO.SeekOrigin]::End)
          $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
          $text += $reader.ReadToEnd()
          $reader.Dispose()
        }
      } finally { $stream.Dispose() }
    } catch { }
  }
  if ($text -match 'server returned SHUTDOWN|SHUTDOWN \(cmd 0x08\)|服务端.*SHUTDOWN') {
    return '服务端主动关闭了 VPN 会话（SHUTDOWN）。请确认账号未在手机或另一台电脑登录；不要使用全局代理，改用 PAC 模式后重试。'
  }
  if ($text -match 'panic:') {
    return 'VPN 引擎异常退出（panic）。请查看临时目录中的 nuaa-campus-vpn-*.err.log，并重新连接。'
  }
  return ''
}
