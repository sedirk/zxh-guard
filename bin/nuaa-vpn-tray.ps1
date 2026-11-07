<#
  南航校内 VPN 托盘 v3
  - 单一状态机管理连接、取消、停止、重启和重试；每次只运行一个后台操作
  - 后台客户端另有跨进程互斥；主动停止不会触发自动重连
  - 代理就绪仅表示端口可用，不冒充校园 HTTP 连通性验证
#>
param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$here = $PSScriptRoot
. (Join-Path $here 'vpn-lifecycle.ps1')
. (Join-Path $here 'vpn-runtime.ps1')
$pluginRoot = Split-Path -Parent $here
$configFile = Resolve-VpnConfigFile $pluginRoot
$clientPs1 = Join-Path $here 'campus-vpn.ps1'
$pidFile = Join-Path $env:TEMP 'nuaa-campus-vpn.json'
$backupFile = Join-Path $env:TEMP 'nuaa-vpn-proxy-backup.json'
$modeFile = Join-Path $env:TEMP 'nuaa-vpn-tray-mode.txt'
$trayLog = Join-Path $env:TEMP 'nuaa-vpn-tray.log'
$regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

function Write-TrayLog([string]$m) {
  try { Add-Content -Path $trayLog -Value ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + "] " + $m) -Encoding UTF8 } catch { }
}
trap {
  Write-TrayLog ("FATAL: " + $_.Exception.Message + " @ " + $_.InvocationInfo.PositionMessage)
  if (-not $SelfTest) { try { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '校内 VPN 托盘异常') | Out-Null } catch { } }
  exit 1
}

$cfg = $null
if (Test-Path $configFile) { $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json }
$client = if ($cfg) { $cfg.campusClient } else { $null }
$httpBind = if ($client -and $client.httpBind) { [string]$client.httpBind } else { '127.0.0.1:11081' }
$socksBind = if ($client -and $client.socksBind) { [string]$client.socksBind } else { '127.0.0.1:11080' }
$gatewayPort = if ($cfg -and $cfg.gatewayPort) { [int]$cfg.gatewayPort } else { 41900 }
$pacUrl = "http://127.0.0.1:$gatewayPort/proxy.pac"
$script:domains = [string[]]@()
if ($client -and $client.domains -and $client.domains.Count -gt 0) { $script:domains = [string[]]@($client.domains) }
if ($script:domains.Count -eq 0) { $script:domains = [string[]]@('nuaa.edu.cn') }

$i = $httpBind.LastIndexOf(':')
$httpHost = if ($i -lt 0) { '127.0.0.1' } else { $httpBind.Substring(0, $i) }
$httpPort = if ($i -lt 0) { [int]$httpBind } else { [int]$httpBind.Substring($i + 1) }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try {
  Add-Type -Namespace WinInet -Name Native -MemberDefinition @"
[DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
"@
} catch { }

function Refresh-Proxy {
  try {
    [WinInet.Native]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
    [WinInet.Native]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
  } catch { }
}
function Test-Port([string]$h, [int]$p, [int]$timeoutMs = 500) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($h, $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($timeoutMs)) { $c.Close(); return $false }
    $c.EndConnect($iar); $c.Close(); return $true
  } catch { return $false }
}
function Get-ProxySnapshot {
  $p = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
  [pscustomobject]@{
    ProxyEnable   = [int]($p.ProxyEnable)
    ProxyServer   = [string]($p.ProxyServer)
    ProxyOverride = [string]($p.ProxyOverride)
    AutoConfigURL = [string]($p.AutoConfigURL)
  }
}
function Save-ProxyBackup { if (-not (Test-Path $backupFile)) { (Get-ProxySnapshot) | ConvertTo-Json | Set-Content -Path $backupFile -Encoding UTF8 } }
function Set-Mode([string]$m) { try { Set-Content -Path $modeFile -Value $m -Encoding ASCII } catch { } }
function Get-Mode { if (Test-Path $modeFile) { (Get-Content $modeFile -Raw).Trim() } else { '' } }

function Set-GlobalProxy {
  Save-ProxyBackup
  Set-ItemProperty -Path $regPath -Name ProxyEnable -Value 1 -Type DWord
  Set-ItemProperty -Path $regPath -Name ProxyServer -Value $httpBind -Type String
  Set-ItemProperty -Path $regPath -Name ProxyOverride -Value '<local>;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.30.*;172.31.*;192.168.*;*.local' -Type String
  Remove-ItemProperty -Path $regPath -Name AutoConfigURL -ErrorAction SilentlyContinue
  Refresh-Proxy
  Set-Mode 'global'
  Write-TrayLog 'proxy mode -> global'
}
# 本地 PAC 托管：Chrome 只接受 http(s) 的 PAC URL，file:// 会被忽略
try {
  Add-Type -TypeDefinition @"
using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
public static class ZxhPacServer {
    static TcpListener listener;
    static string payload = "";
    static Thread worker;
    public static bool Start(int port, string pac) {
        try {
            payload = pac;
            listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            worker = new Thread(Loop);
            worker.IsBackground = true;
            worker.Start();
            return true;
        } catch { return false; }
    }
    static void Loop() {
        while (true) {
            try {
                TcpClient client = listener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(delegate(object state) {
                    try {
                        TcpClient c = (TcpClient)state;
                        NetworkStream s = c.GetStream();
                        byte[] buf = new byte[2048];
                        try { s.Read(buf, 0, buf.Length); } catch { }
                        byte[] body = Encoding.UTF8.GetBytes(payload);
                        string head = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig; charset=utf-8\r\nContent-Length: " + body.Length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                        byte[] hb = Encoding.ASCII.GetBytes(head);
                        s.Write(hb, 0, hb.Length);
                        s.Write(body, 0, body.Length);
                        s.Flush();
                        c.Close();
                    } catch { }
                }, client);
            } catch { }
        }
    }
    public static int Port { get { return ((IPEndPoint)listener.LocalEndpoint).Port; } }
}
"@ -ErrorAction Stop
} catch { Write-TrayLog ("pac server type failed: " + $_.Exception.Message) }

$script:pacHttpPort = 41980
$script:pacUrlHttp = "http://127.0.0.1:$script:pacHttpPort/proxy.pac"
function New-PacText {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('// generated by nuaa-vpn-tray')
  [void]$sb.AppendLine('var PROXY = "PROXY ' + $httpBind + '; SOCKS5 ' + $socksBind + '; SOCKS ' + $socksBind + '";')
  [void]$sb.AppendLine('function FindProxyForURL(url, host) {')
  [void]$sb.AppendLine('  if (isPlainHostName(host) || host === "127.0.0.1" || host === "localhost") return "DIRECT";')
  foreach ($d in $script:domains) { [void]$sb.AppendLine('  if (host === "' + $d + '" || dnsDomainIs(host, ".' + $d + '")) return PROXY;') }
  [void]$sb.AppendLine('  return "DIRECT";')
  [void]$sb.AppendLine('}')
  return $sb.ToString()
}
function Resolve-PacUrl {
  $text = New-PacText
  $file = Join-Path $env:TEMP 'nuaa-vpn.pac'
  Set-Content -Path $file -Value $text -Encoding ASCII
  # Chrome 只认 http(s) 的 PAC URL：优先用托盘自带的本地 HTTP 服务
  try {
    if (-not $script:pacServerStarted) {
      $script:pacServerStarted = [ZxhPacServer]::Start($script:pacHttpPort, $text)
      if ($script:pacServerStarted) { Write-TrayLog ("pac http server on " + $script:pacUrlHttp) }
    } else {
      $script:pacServerStarted = [ZxhPacServer]::Start($script:pacHttpPort, $text)
    }
  } catch { Write-TrayLog ("pac server start failed: " + $_.Exception.Message) }
  if ($script:pacServerStarted) { return $script:pacUrlHttp }
  try {
    $r = Invoke-WebRequest -Uri $pacUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { return $pacUrl }
  } catch { }
  return ('file:///' + ($file -replace '\\', '/'))
}
function Set-PacProxy {
  Save-ProxyBackup
  $url = Resolve-PacUrl
  Set-ItemProperty -Path $regPath -Name ProxyEnable -Value 0 -Type DWord
  Set-ItemProperty -Path $regPath -Name AutoConfigURL -Value $url -Type String
  Refresh-Proxy
  Set-Mode 'pac'
  Write-TrayLog ("proxy mode -> pac (" + $url + ")")
}
function Clear-SystemProxy {
  Save-ProxyBackup
  Set-ItemProperty -Path $regPath -Name ProxyEnable -Value 0 -Type DWord
  Remove-ItemProperty -Path $regPath -Name AutoConfigURL -ErrorAction SilentlyContinue
  Refresh-Proxy
  Set-Mode 'clear'
  Write-TrayLog 'proxy mode -> clear'
}
function Restore-ProxyBackup {
  if (-not (Test-Path $backupFile)) { Set-Mode 'manual'; return }
  $b = Get-Content $backupFile -Raw -Encoding UTF8 | ConvertFrom-Json
  Set-ItemProperty -Path $regPath -Name ProxyEnable -Value ([int]$b.ProxyEnable) -Type DWord
  if ($b.ProxyServer) { Set-ItemProperty -Path $regPath -Name ProxyServer -Value $b.ProxyServer -Type String }
  if ($b.ProxyOverride) { Set-ItemProperty -Path $regPath -Name ProxyOverride -Value $b.ProxyOverride -Type String }
  if ($b.AutoConfigURL) { Set-ItemProperty -Path $regPath -Name AutoConfigURL -Value $b.AutoConfigURL -Type String }
  else { Remove-ItemProperty -Path $regPath -Name AutoConfigURL -ErrorAction SilentlyContinue }
  Refresh-Proxy
  Set-Mode 'manual'
  Write-TrayLog 'proxy mode -> restored'
}

function Get-Tunnel {
  Get-VpnSnapshot $pidFile (Join-Path $here 'zju-connect.exe') $httpBind $socksBind
}
function Clear-OwnedProxy {
  $p = Get-ProxySnapshot
  $ours = ($p.ProxyEnable -eq 1 -and $p.ProxyServer -eq $httpBind) -or
    ($p.AutoConfigURL -and $p.AutoConfigURL -in @($script:pacUrlHttp, $pacUrl))
  if ($ours) { Clear-SystemProxy }
}
function Start-VpnEffect {
  if ($script:worker -or -not $script:lifecycle.Effect) { return }
  $action = $script:lifecycle.Effect
  $script:lifecycle.Effect = ''
  $script:workerResult = Join-Path $env:TEMP ('nuaa-vpn-result-' + [guid]::NewGuid().ToString('N') + '.json')
  $script:workerTimedOut = $false
  try {
    $argsList = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden',
      '-File',$clientPs1,'-Action',$action,'-Standalone','-ResultFile',$script:workerResult)
    $script:worker = Start-Process -FilePath 'powershell.exe' -ArgumentList (($argsList | ForEach-Object { ConvertTo-VpnArgument $_ }) -join ' ') -WindowStyle Hidden -PassThru
    Write-TrayLog ("operation=$action workerPid=" + $script:worker.Id)
  } catch {
    Complete-VpnOperation $script:lifecycle $false (Get-Tunnel).state '无法启动后台连接任务，请检查脚本路径。'
  }
}
function Invoke-TrayAction([string]$Action) {
  if ($script:exitPending -and $Action -ne 'stop') { return }
  if (Request-VpnAction $script:lifecycle $Action) {
    if ($Action -in @('start','restart')) { $script:lastErrorShown = '' }
    if ($Action -eq 'stop') { Clear-OwnedProxy }
    Update-Ui | Out-Null # Reflect the accepted intent before spawning the worker.
    Start-VpnEffect
  } else { Write-TrayLog ("ignored action=$Action state=" + $script:lifecycle.State) }
}

function New-StateIcon([string]$state) {
  $color = switch ($state) {
    'ready' { [System.Drawing.Color]::FromArgb(46, 204, 113) }
    'starting' { [System.Drawing.Color]::FromArgb(241, 196, 15) }
    'stopping' { [System.Drawing.Color]::FromArgb(241, 196, 15) }
    'retry_wait' { [System.Drawing.Color]::FromArgb(230, 126, 34) }
    'external' { [System.Drawing.Color]::FromArgb(52, 152, 219) }
    'failed' { [System.Drawing.Color]::FromArgb(231, 76, 60) }
    default { [System.Drawing.Color]::FromArgb(149, 165, 166) }
  }
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $color
  $g.FillEllipse($brush, 2, 2, 28, 28)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 3
  $g.DrawLine($pen, 16, 9, 16, 23); $g.DrawLine($pen, 9, 16, 23, 16)
  $g.Dispose(); $brush.Dispose(); $pen.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}


# ---------------- 单实例（Local\ 命名空间，普通用户可创建） ----------------
$createdNew = $false
$mutex = $null
if (-not $SelfTest) {
  $mutex = New-Object System.Threading.Mutex($true, 'Local\NuaaVpnTrayV2', [ref]$createdNew)
  if (-not $createdNew) { Write-TrayLog 'another tray instance is running -> exit'; exit 0 }
}

[System.Windows.Forms.Application]::EnableVisualStyles()
$trayIcon = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$trayIcon.ContextMenuStrip = $menu
$trayIcon.Visible = -not $SelfTest

$miGlobal = New-Object System.Windows.Forms.ToolStripMenuItem '自动配置系统代理'
$miPac = New-Object System.Windows.Forms.ToolStripMenuItem 'PAC 模式（仅校内走隧道）'
$miClear = New-Object System.Windows.Forms.ToolStripMenuItem '清除系统代理'
$miManual = New-Object System.Windows.Forms.ToolStripMenuItem '不变更系统代理（还原）'
$sep1 = New-Object System.Windows.Forms.ToolStripSeparator
$miStart = New-Object System.Windows.Forms.ToolStripMenuItem '连接'
$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem '重启（先断开再连接）'
$miStop = New-Object System.Windows.Forms.ToolStripMenuItem '断开连接'
$miStatus = New-Object System.Windows.Forms.ToolStripMenuItem '状态：未启动'
$miStatus.Enabled = $false
$miProxy = New-Object System.Windows.Forms.ToolStripMenuItem '系统代理：未变更'
$miProxy.Enabled = $false
$sep2 = New-Object System.Windows.Forms.ToolStripSeparator
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem '退出'
$miDetail = New-Object System.Windows.Forms.ToolStripMenuItem '查看连接详情'

$miGlobal.add_Click({ if ((Get-VpnControls $script:lifecycle).CanSetProxy) { Set-GlobalProxy; Update-Ui | Out-Null } })
$miPac.add_Click({ if ((Get-VpnControls $script:lifecycle).CanSetProxy) { Set-PacProxy; Update-Ui | Out-Null } })
$miClear.add_Click({ Clear-SystemProxy; Update-Ui | Out-Null })
$miManual.add_Click({ Restore-ProxyBackup; Update-Ui | Out-Null })
$miStart.add_Click({ Invoke-TrayAction 'start' })
$miRestart.add_Click({ Invoke-TrayAction 'restart' })
$miStop.add_Click({ Invoke-TrayAction 'stop' })
$miDetail.add_Click({
  $message = $miStatus.Text + "`n" + $miProxy.Text + "`nHTTP: $httpBind`nSOCKS5: $socksBind`n"
  if ($script:lifecycle.LastError) { $message += "`n最近错误：" + $script:lifecycle.LastError }
  $message += "`n`n就绪仅表示本机端口监听。外部隧道请在持有它的插件/客户端中管理。"
  [void][System.Windows.Forms.MessageBox]::Show($message, '校内 VPN 连接详情')
})
$miExit.add_Click({
  $script:exitPending = $true
  $miExit.Enabled = $false; $miExit.Text = '正在退出…'
  Clear-OwnedProxy
  if ($script:lifecycle.Operation -eq 'stop') {
    $script:lifecycle.WantRunning = $false; $script:lifecycle.RestartPending = $false
  } else { Invoke-TrayAction 'stop' }
  Watchdog
})

foreach ($item in @($miStart, $miStop, $miRestart, $sep1, $miGlobal, $miPac, $miClear, $miManual, $miStatus, $miProxy, $miDetail, $sep2, $miExit)) { [void]$menu.Items.Add($item) }

$script:lifecycle = New-VpnLifecycle
$script:worker = $null
$script:exitPending = $false
$script:lastState = ''
$script:lastErrorShown = ''
$script:startTimeoutMs = if ($client.startTimeoutMs) { [Math]::Max(3000, [Math]::Min(180000, [double]$client.startTimeoutMs)) } else { 30000 }

function Update-Ui {
  $m = $script:lifecycle
  $controls = Get-VpnControls $m
  $snap = Get-ProxySnapshot
  if ($m.State -ne $script:lastState) {
    if ($trayIcon.Icon) { $trayIcon.Icon.Dispose() }
    $trayIcon.Icon = New-StateIcon $m.State
    Write-TrayLog ("state " + $script:lastState + ' -> ' + $m.State)
    $script:lastState = $m.State
  }
  $elapsed = if ($m.Operation) { [Math]::Max(0, [int]((Get-Date) - $m.Since).TotalSeconds) } else { 0 }
  $label = switch ($m.State) {
    'starting' { "连接中（${elapsed}s）" }
    'stopping' { if ($m.Operation -eq 'start') { "正在取消，等待当前任务结束（${elapsed}s）" } else { "正在断开（${elapsed}s），请稍候" } }
    'ready' { '代理就绪（仅端口检查）' }
    'external' { '外部代理占用，请在原客户端管理' }
    'retry_wait' { '连接失败，' + [Math]::Max(0, [int]($m.RetryAt - (Get-Date)).TotalSeconds) + ' 秒后重试（失败 ' + $m.Failures + '/3）' }
    'failed' { if ($m.Observed -in @('ready','starting')) { '操作失败，请先重试断开' } else { '连接失败，已停止自动重试' } }
    default { '未连接' }
  }
  $trayIcon.Text = ('校内 VPN · ' + $label).Substring(0, [Math]::Min(63, ('校内 VPN · ' + $label).Length))
  $miStatus.Text = '状态：' + $label
  $miDetail.ToolTipText = $m.LastError
  $miStart.Enabled = $controls.CanStart -and -not $script:exitPending
  $miStop.Enabled = $controls.CanStop -and -not $script:exitPending
  $miRestart.Enabled = $controls.CanRestart -and -not $script:exitPending
  $miGlobal.Enabled = $controls.CanSetProxy -and -not $script:exitPending
  $miPac.Enabled = $controls.CanSetProxy -and -not $script:exitPending
  $miStart.Text = if ($m.State -eq 'starting') { '连接中…' } elseif ($m.State -eq 'failed') { '重试连接' } else { '连接' }
  $miStop.Text = if ($m.State -eq 'starting') { '取消连接' } elseif ($m.State -eq 'retry_wait') { '取消自动重试' } elseif ($m.State -eq 'stopping') { '正在断开…' } elseif ($m.State -eq 'failed') { '重试断开' } else { '断开连接' }
  # Registry state, not a stale mode flag, determines which proxy is actually active.
  $isPac = [bool]($snap.AutoConfigURL -and $snap.AutoConfigURL -in @($script:pacUrlHttp,$pacUrl))
  $isGlobal = ($snap.ProxyEnable -eq 1 -and $snap.ProxyServer -eq $httpBind)
  $miPac.Checked = $isPac
  $miGlobal.Checked = $isGlobal -and -not $isPac
  $miClear.Checked = ($snap.ProxyEnable -eq 0 -and -not $snap.AutoConfigURL)
  $miManual.Checked = -not $miClear.Checked -and -not $isPac -and -not $isGlobal
  if ($isPac) { $miProxy.Text = '系统代理：校园 PAC' }
  elseif ($isGlobal) { $miProxy.Text = "系统代理：全局 → $httpBind" }
  elseif ($snap.AutoConfigURL) { $miProxy.Text = '系统代理：其他 PAC（本托盘未接管）' }
  elseif ($snap.ProxyEnable) { $miProxy.Text = '系统代理：其他程序 → ' + $snap.ProxyServer }
  else { $miProxy.Text = '系统代理：未启用' }
}

function Watchdog {
  $now = Get-Date
  if ($script:worker) {
    $script:worker.Refresh()
    $limit = if ($script:lifecycle.Operation -eq 'start') { $script:startTimeoutMs + 15000 } else { 75000 }
    if (-not $script:worker.HasExited -and ($now - $script:lifecycle.Since).TotalMilliseconds -gt $limit) {
      # Kill only the worker. Its recorded VPN child is cleaned by a serialized stop.
      $script:worker.Kill()
      $script:workerTimedOut = $true
      $script:lifecycle.WantRunning = $false
      $script:lifecycle.RestartPending = $false
      return # Wait for actual worker exit; do not start another operation yet.
    }
    if ($script:worker.HasExited) {
      $script:worker.WaitForExit()
      $ok = $false; $message = '后台操作异常结束，未收到结果。'
      try {
        $r = Get-Content -LiteralPath $script:workerResult -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
        $ok = [bool]$r.ok -and $script:worker.ExitCode -eq 0
        $message = [string]$r.message
      } catch { }
      if ($script:workerTimedOut) { $ok = $false; $message = '后台操作超时，已取消；不再自动重试。' }
      Write-TrayLog ("operation=" + $script:lifecycle.Operation + " exit=" + $script:worker.ExitCode + " ok=$ok message=$message")
      $script:worker.Dispose(); $script:worker = $null
      Remove-Item -LiteralPath $script:workerResult -Force -ErrorAction SilentlyContinue
      Complete-VpnOperation $script:lifecycle $ok (Get-Tunnel).state $message $now
    }
  }
  $tunnel = Get-Tunnel
  $hint = if ($tunnel.state -in @('starting','stopped')) { Get-VpnFailureHint $tunnel.record } else { '' }
  Observe-VpnLifecycle $script:lifecycle $tunnel.state $now $hint
  Start-VpnEffect
  if ($script:lifecycle.State -eq 'failed' -and $script:lifecycle.LastError -ne $script:lastErrorShown) {
    $script:lastErrorShown = $script:lifecycle.LastError
    Clear-OwnedProxy
    Write-TrayLog ('connection failed: ' + $script:lifecycle.LastError)
    $trayIcon.BalloonTipTitle = '校内 VPN 连接失败'
    $trayIcon.BalloonTipText = $script:lifecycle.LastError
    if (-not $SelfTest) { $trayIcon.ShowBalloonTip(6000) }
  }
  Update-Ui
  if ($script:exitPending -and -not $script:worker -and -not $script:lifecycle.Operation) {
    if ($script:lifecycle.Observed -in @('ready','starting')) {
      # Do not silently abandon a live owned engine after a failed stop.
      $script:exitPending = $false; $miExit.Enabled = $true; $miExit.Text = '退出'
      Update-Ui
      return
    }
    $timer.Stop()
    $trayIcon.Visible = $false; $trayIcon.Dispose()
    Write-TrayLog 'tray exit after operation completion'
    [System.Windows.Forms.Application]::Exit()
  }
}

if ($SelfTest) {
  # Real menu handlers/watchdog, with process effects and proxy writes replaced.
  $script:testActions = @(); $script:testObserved = 'stopped'
  function Start-VpnEffect {
    if ($script:lifecycle.Effect) {
      $script:testActions += $script:lifecycle.Effect
      $script:lifecycle.Effect = ''
    }
  }
  function Clear-OwnedProxy { }
  function Get-Tunnel { [pscustomobject]@{ state = $script:testObserved } }
  function Assert-Ui($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
  Update-Ui
  Assert-Ui ($miStart.Enabled -and -not $miRestart.Enabled -and -not $miGlobal.Enabled) 'Initial controls'
  $miStart.PerformClick()
  Assert-Ui ($script:lifecycle.State -eq 'starting' -and -not $miStart.Enabled -and -not $miRestart.Enabled -and $miStop.Enabled) 'Connecting controls'
  1..100 | ForEach-Object { $miStart.PerformClick(); Watchdog }
  Assert-Ui (($script:testActions -join ',') -eq 'start') 'Duplicate menu/watchdog dispatch'
  $miStop.PerformClick()
  Assert-Ui (-not $script:lifecycle.WantRunning -and $script:lifecycle.State -eq 'stopping') 'Cancel intent'
  Complete-VpnOperation $script:lifecycle $true 'ready' ''
  $script:testObserved = 'ready'; Watchdog
  Assert-Ui (($script:testActions -join ',') -eq 'start,stop') 'Cancel cleanup ordering'
  Complete-VpnOperation $script:lifecycle $true 'stopped' ''
  $script:testObserved = 'stopped'; Watchdog
  Assert-Ui ($miStart.Enabled -and -not $miStop.Enabled) 'Stopped controls'
  $miStart.PerformClick(); Complete-VpnOperation $script:lifecycle $true 'ready' ''
  $script:testObserved = 'ready'; Watchdog
  Assert-Ui ($miGlobal.Enabled -and $miPac.Enabled -and $miRestart.Enabled) 'Ready controls'
  $miRestart.PerformClick(); $miRestart.PerformClick(); Watchdog
  Assert-Ui ($script:lifecycle.Operation -eq 'stop' -and $script:testActions[-1] -eq 'stop') 'Restart overlaps stop'
  Complete-VpnOperation $script:lifecycle $true 'stopped' ''
  $script:testObserved = 'stopped'; Watchdog
  Assert-Ui ($script:lifecycle.Operation -eq 'start' -and $script:testActions[-1] -eq 'start') 'Restart did not follow stop'
  Complete-VpnOperation $script:lifecycle $false 'stopped' 'simulated error'; Watchdog
  Assert-Ui ($script:lifecycle.State -eq 'retry_wait' -and -not $miStart.Enabled -and $miStop.Enabled -and $miStatus.Text.Contains('秒后重试')) 'Retry countdown controls'
  $miStop.PerformClick(); Watchdog
  Assert-Ui ($script:lifecycle.State -eq 'stopped' -and -not $script:lifecycle.WantRunning) 'Cancel retry'
  $script:testObserved = 'external'; Watchdog
  Assert-Ui (-not $miStart.Enabled -and -not $miStop.Enabled -and -not $miRestart.Enabled -and -not $miPac.Enabled) 'External controls'
  $script:testObserved = 'stopped'; Watchdog
  $miStart.PerformClick()
  $script:worker = [pscustomobject]@{ HasExited=$false; ExitCode=1; Killed=$false }
  $script:worker | Add-Member ScriptMethod Refresh { }
  $script:worker | Add-Member ScriptMethod Kill { $this.Killed=$true; $this.HasExited=$true }
  $script:worker | Add-Member ScriptMethod WaitForExit { }
  $script:worker | Add-Member ScriptMethod Dispose { }
  $mockWorker = $script:worker
  $script:workerResult = Join-Path $env:TEMP ([guid]::NewGuid().ToString('N') + '.json')
  $script:lifecycle.Since = (Get-Date).AddMilliseconds(-$script:startTimeoutMs - 20000)
  $script:testObserved = 'starting'; Watchdog; Watchdog
  Assert-Ui ($mockWorker.Killed -and $script:lifecycle.Operation -eq 'stop') 'Timed-out worker not cleaned serially'
  Complete-VpnOperation $script:lifecycle $true 'stopped' ''
  $script:testObserved = 'stopped'; Watchdog
  Assert-Ui ($script:lifecycle.State -eq 'failed' -and $script:lifecycle.LastError.Contains('超时') -and $miStart.Enabled) 'Timeout feedback erased'
  $miStart.PerformClick(); $miExit.PerformClick()
  Assert-Ui ($script:exitPending -and $script:lifecycle.Operation -eq 'start' -and -not $script:lifecycle.WantRunning) 'Exit abandoned starting worker'
  Complete-VpnOperation $script:lifecycle $true 'ready' ''
  $script:testObserved = 'ready'; Watchdog
  Complete-VpnOperation $script:lifecycle $false 'ready' 'simulated stop failure'; Watchdog
  Assert-Ui (-not $script:exitPending -and $miExit.Enabled -and $miStop.Enabled -and $script:lifecycle.State -eq 'failed') 'Exit concealed failed stop'
  $timer = New-Object System.Windows.Forms.Timer
  $miExit.PerformClick()
  Complete-VpnOperation $script:lifecycle $true 'stopped' ''
  $script:testObserved = 'stopped'; Watchdog
  Assert-Ui ($script:exitPending -and -not $script:lifecycle.Operation) 'Exit did not finish cleanup'
  $timer.Dispose()
  Write-Host 'PASS: real menu/watchdog connect, 100 clicks, cancel, restart, retry, external, timeout and exit (mock effects; no VPN/registry writes).'
  exit 0
}

$menu.add_Opening({ Update-Ui })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({ Watchdog })
$timer.Start()
Write-TrayLog '--- tray v3 lifecycle starting ---'
Observe-VpnLifecycle $script:lifecycle (Get-Tunnel).state
Update-Ui
Write-TrayLog ("initial state=" + $script:lifecycle.State + "; no automatic login from persisted proxy mode")
try { [System.Windows.Forms.Application]::Run() }
finally {
  $timer.Dispose()
  if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
}