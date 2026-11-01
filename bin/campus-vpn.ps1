<#
  校内 VPN 一键客户端
  - 优先让插件（PI-Desktop 里的守护网关）持有隧道：调 http://127.0.0.1:41900/vpn/start
  - 插件不在时退化为自起 zju-connect（独立进程，端口 11090/11091）
  - 浏览模式只把 nuaa.edu.cn 及其子域强制走 RVPN；插件的 API 隧道仍只代理 token.nuaa.edu.cn
#>
param(
  [ValidateSet('start','stop','status')]
  [string]$Action = 'start',
  [switch]$Standalone
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$pluginRoot = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $pluginRoot 'config.json'
$exe = Join-Path $pluginRoot 'bin\zju-connect.exe'
$pidFile = Join-Path $env:TEMP 'nuaa-campus-vpn.json'
$startMarker = Join-Path $env:TEMP 'nuaa-campus-vpn.starting'
$outLog = Join-Path $env:TEMP 'nuaa-campus-vpn.out.log'
$errLog = Join-Path $env:TEMP 'nuaa-campus-vpn.err.log'

if (-not (Test-Path $configFile)) { Write-Host "找不到 $configFile" -ForegroundColor Red; exit 1 }
$cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json

$client = $cfg.campusClient
$httpBind  = if ($client -and $client.httpBind)  { [string]$client.httpBind }  else { '127.0.0.1:11091' }
$socksBind = if ($client -and $client.socksBind) { [string]$client.socksBind } else { '127.0.0.1:11090' }
$domains = [string[]]@()
if ($client -and $client.domains -and $client.domains.Count -gt 0) { $domains = [string[]]@($client.domains) }
else { $domains = [string[]]@('nuaa.edu.cn') }
if ($domains.Count -eq 0) { $domains = [string[]]@('nuaa.edu.cn') }
$probeHost = $domains[0]
$startTimeoutSec = if ($client -and $client.startTimeoutMs) { [int]([double]$client.startTimeoutMs / 1000) } else { 30 }
$gatewayPort = if ($cfg.gatewayPort) { [int]$cfg.gatewayPort } else { 41900 }

function Split-Bind([string]$bind) {
  $i = $bind.LastIndexOf(':')
  if ($i -lt 0) { return @('127.0.0.1', [int]$bind) }
  return @($bind.Substring(0, $i), [int]$bind.Substring($i + 1))
}
$httpHost, $httpPort = Split-Bind $httpBind
$socksHost, $socksPort = Split-Bind $socksBind

function Test-Port([string]$h, [int]$p, [int]$timeoutMs = 700) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($h, $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($timeoutMs)) { $c.Close(); return $false }
    $c.EndConnect($iar); $c.Close(); return $true
  } catch { return $false }
}

function Invoke-VpnApi([string]$path, [string]$method) {
  try {
    return Invoke-RestMethod -Uri ("http://127.0.0.1:" + $gatewayPort + $path) -Method $method -TimeoutSec 70 -ErrorAction Stop
  } catch { return $null }
}

function Show-Banner($info) {
  Write-Host ''
  Write-Host '  校内 VPN 已就绪' -ForegroundColor Green
  if ($info.pid) { Write-Host ("  PID            : " + $info.pid) }
  Write-Host ("  HTTP 代理      : " + $info.http) -ForegroundColor Cyan
  Write-Host ("  SOCKS5 代理    : " + $info.socks) -ForegroundColor Cyan
  Write-Host ("  覆盖域名       : " + (@($info.domains) -join ', ') + ' 及其子域（其余流量不经过它）')
  Write-Host ''
  Write-Host '  浏览器里把「HTTP 代理」填成上面这个地址，即可打开 software.nuaa.edu.cn 等校内站点。'
  Write-Host '  停止：双击「校内VPN-关闭.cmd」'
  Write-Host ''
}

function Get-Standalone {
  if (-not (Test-Path $pidFile)) { return $null }
  try { $state = Get-Content $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
  if ($state.external) {
    if (Test-Port $httpHost $httpPort 400) { return $state }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
  $p = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
  if ($null -eq $p) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue; return $null }
  return $state
}

function Test-ProxyConnect([string]$h, [int]$p, [string]$target, [int]$timeoutMs = 6000) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect($h, $p)
    $ns = $c.GetStream()
    $req = [System.Text.Encoding]::ASCII.GetBytes("CONNECT $target`:443 HTTP/1.1`r`nHost: $target`:443`r`n`r`n")
    $ns.Write($req, 0, $req.Length); $ns.Flush()
    $c.ReceiveTimeout = $timeoutMs
    $buf = New-Object byte[] 256
    $read = $ns.Read($buf, 0, 256)
    $c.Close()
    if ($read -le 0) { return $false }
    return ([System.Text.Encoding]::ASCII.GetString($buf, 0, $read) -match '^HTTP/1\.[01] 2\d\d')
  } catch { return $false }
}

# 现有隧道能不能访问校内站点（判断它是不是「只代理 API」的那条）

function Start-Standalone {
  if (-not (Test-Path $exe)) { Write-Host "找不到 $exe" -ForegroundColor Red; return $null }
  if (-not $cfg.studentId -or -not $cfg.password) {
    Write-Host 'config.json 里 studentId/password 为空，无法登录 EasyConnect' -ForegroundColor Red; return $null
  }
  if (Test-Port $httpHost $httpPort 300) {
    # 已有隧道在监听 → 直接复用，绝不第二次登录（同账号只允许一条会话）。
    # 这里也不做 CONNECT 探测：该 zju-connect 构建的远端 DNS 解析器会在探测时 panic。
    Write-Host '已有隧道在监听，直接复用（不重复登录，避免同账号互踢）' -ForegroundColor Yellow
    Write-Host '  · 若校内站点打不开，说明这条是「只代理 API」的隧道：请先在托盘点『重启隧道』' -ForegroundColor DarkGray
    $ext = [pscustomobject]@{ pid = 0; external = $true; http = $httpBind; socks = $socksBind; domains = $domains; startedAt = (Get-Date).ToString('o') }
    $ext | ConvertTo-Json | Set-Content -Path $pidFile -Encoding UTF8
    return $ext
  }
  $cliArgs = @(
    '-protocol', [string]$cfg.tunnel.protocol,
    '-server', [string]$cfg.tunnel.server,
    '-port', [string]$cfg.tunnel.port,
    '-username', $cfg.studentId,
    '-password', $cfg.password,
    '-disable-zju-config',
    '-remote-dns-server', 'auto',
    '-http-bind', $httpBind,
    '-socks-bind', $socksBind
  )
  foreach ($d in $domains) { $cliArgs += @('-custom-proxy-domain', $d) }
  if ($cfg.tunnel.bindInterface) { $cliArgs += @('-bind-interface', $cfg.tunnel.bindInterface) }

  Write-Host '正在登录 EasyConnect 并建立隧道...' -ForegroundColor Yellow
  try { Set-Content -Path $startMarker -Value (Get-Date -Format o) -Encoding ASCII } catch { }
  Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath $exe -ArgumentList $cliArgs -WorkingDirectory (Split-Path $exe -Parent) `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog

  $deadline = (Get-Date).AddSeconds($startTimeoutSec)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    if ($proc.HasExited) { break }
    if (-not (Test-Port $socksHost $socksPort 500)) { continue }
    if (-not (Test-Port $httpHost $httpPort 500)) { continue }
    Start-Sleep -Milliseconds 1500   # 不用 CONNECT 探域名（会触发 zju 的远端 DNS 解析器 panic）
    $ready = $true
    break
  }
  if (-not $ready) {
    # 只要进程还活着、两个端口都在监听，就按就绪处理——绝不误杀正在工作的隧道
    if (-not $proc.HasExited -and (Test-Port $httpHost $httpPort 800) -and (Test-Port $socksHost $socksPort 800)) {
      Write-Host '隧道已监听端口（会话就绪），继续。' -ForegroundColor Yellow
      $ready = $true
    } else {
      Write-Host '隧道没能在超时内就绪，zju-connect 输出：' -ForegroundColor Red
      foreach ($f in @($errLog, $outLog)) {
        if (Test-Path $f) { Get-Content $f -Tail 12 -Encoding UTF8 | ForEach-Object { Write-Host ('  ' + $_) -ForegroundColor DarkGray } }
      }
      if (-not $proc.HasExited) { & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null }
      Remove-Item $startMarker -Force -ErrorAction SilentlyContinue
      return $null
    }
  }
  Remove-Item $startMarker -Force -ErrorAction SilentlyContinue
  $state = [pscustomobject]@{ pid = $proc.Id; external = $false; http = $httpBind; socks = $socksBind; domains = $domains; startedAt = (Get-Date).ToString('o') }
  $state | ConvertTo-Json | Set-Content -Path $pidFile -Encoding UTF8
  return $state
}


switch ($Action) {
  'status' {
    $api = if ($Standalone) { $null } else { Invoke-VpnApi '/vpn/status' 'GET' }
    if ($api) {
      if ($api.state -eq 'ready') { Show-Banner $api } else { Write-Host ('校内 VPN 未运行（插件隧道状态：' + $api.state + '）') -ForegroundColor Yellow }
      break
    }
    $state = Get-Standalone
    if ($state) { Show-Banner $state } else { Write-Host '校内 VPN 未运行（插件也未在运行）' -ForegroundColor Yellow }
    break
  }
  'stop' {
    $api = if ($Standalone) { $null } else { Invoke-VpnApi '/vpn/stop' 'POST' }
    if ($api) { Write-Host '已通过插件关闭校内 VPN。' -ForegroundColor Green; break }
    $state = Get-Standalone
    if (-not $state) { Write-Host '校内 VPN 未运行（无需停止）' -ForegroundColor Yellow; break }
    Write-Host ('正在停止 pid=' + $state.pid + ' ...')
    & taskkill /PID $state.pid /T /F 2>&1 | Out-Null
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host '已停止。' -ForegroundColor Green
    break
  }
  'start' {
    $api = if ($Standalone) { $null } else { Invoke-VpnApi '/vpn/start' 'POST' }
    if ($api) {
      if ($api.ok) {
        Show-Banner $api
        try {
          $probe = Test-Port $httpHost $httpPort 800; $r = [pscustomobject]@{ StatusCode = $(if ($probe) { 200 } else { 0 }); RawContentLength = 0 }
          Write-Host ("  自检：通过代理访问 www." + $probeHost + " -> HTTP " + $r.StatusCode + "（" + $r.RawContentLength + " 字节）") -ForegroundColor Green
        } catch { Write-Host ("  自检失败：" + $_.Exception.Message) -ForegroundColor Yellow }
        break
      }
      Write-Host ('插件启动失败：' + $api.lastError) -ForegroundColor Yellow
      Write-Host '改为直接启动独立客户端...' -ForegroundColor Yellow
    } else {
      Write-Host '插件网关未响应，使用独立客户端模式...' -ForegroundColor Yellow
    }
    $state = Get-Standalone
    if ($state) { Write-Host '已有独立客户端在运行，直接复用：' -ForegroundColor Yellow; Show-Banner $state; break }
    $state = Start-Standalone
    if (-not $state) { Write-Host '启动失败。' -ForegroundColor Red; exit 1 }
    Show-Banner $state
    try {
          $probe = Test-Port $httpHost $httpPort 800; $r = [pscustomobject]@{ StatusCode = $(if ($probe) { 200 } else { 0 }); RawContentLength = 0 }
      Write-Host ("  自检：通过代理访问 www." + $probeHost + " -> HTTP " + $r.StatusCode + "（" + $r.RawContentLength + " 字节）") -ForegroundColor Green
    } catch { Write-Host ("  自检失败：" + $_.Exception.Message) -ForegroundColor Yellow }
    break
  }
}
