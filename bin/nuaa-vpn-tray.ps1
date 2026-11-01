<#
  南航校内 VPN 托盘 v2
  - 隧道由托盘自己托管（campus-vpn.ps1 -Standalone），不依赖 PI-Desktop
  - 看门狗：每 3 秒检查；隧道掉了自动重连（15 秒节流），连续失败则自动撤销系统代理，避免浏览器卡在 ERR_PROXY_CONNECTION_FAILED
  - 右键：自动配置系统代理 / PAC 模式 / 清除系统代理 / 不变更（还原）/ 启动·重启·停止 / 状态 / 退出
#>
param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$here = $PSScriptRoot
$pluginRoot = Split-Path -Parent $here
$configFile = Join-Path $pluginRoot 'config.json'
$clientPs1 = Join-Path $here 'campus-vpn.ps1'
$pidFile = Join-Path $env:TEMP 'nuaa-campus-vpn.json'
$backupFile = Join-Path $env:TEMP 'nuaa-vpn-proxy-backup.json'
$modeFile = Join-Path $env:TEMP 'nuaa-vpn-tray-mode.txt'
$trayLog = Join-Path $env:TEMP 'nuaa-vpn-tray.log'
$regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

function Write-TrayLog([string]$m) {
  try { Add-Content -Path $trayLog -Value ("[" + (Get-Date -Format 'HH:mm:ss') + "] " + $m) -Encoding UTF8 } catch { }
}
trap {
  Write-TrayLog ("FATAL: " + $_.Exception.Message + " @ " + $_.InvocationInfo.PositionMessage)
  if (-not $SelfTest) { try { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '校内 VPN 托盘异常') | Out-Null } catch { } }
  exit 1
}

$cfg = $null
if (Test-Path $configFile) { $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json }
$client = if ($cfg) { $cfg.campusClient } else { $null }
$httpBind = if ($client -and $client.httpBind) { [string]$client.httpBind } else { '127.0.0.1:11091' }
$socksBind = if ($client -and $client.socksBind) { [string]$client.socksBind } else { '127.0.0.1:11090' }
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
  if (Test-Path $pidFile) {
    try {
      $st = Get-Content $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($st.external) {
        $upExt = Test-Port $httpHost $httpPort 400
        return [pscustomobject]@{ state = $(if ($upExt) { 'ready' } else { 'starting' }); pid = $null; http = [string]$st.http; socks = [string]$st.socks; external = $true }
      }
      if (Get-Process -Id $st.pid -ErrorAction SilentlyContinue) {
        $up = Test-Port $httpHost $httpPort 400
        return [pscustomobject]@{ state = $(if ($up) { 'ready' } else { 'starting' }); pid = $st.pid; http = [string]$st.http; socks = [string]$st.socks; external = $false }
      }
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    } catch { }
  }
  return [pscustomobject]@{ state = 'stopped'; pid = $null; http = $httpBind; socks = $socksBind }
}
function Start-Tunnel {
  Write-TrayLog 'start tunnel (standalone)'
  Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $clientPs1, '-Action', 'start', '-Standalone') -WindowStyle Hidden | Out-Null
}
function Stop-Tunnel {
  Write-TrayLog 'stop tunnel'
  Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $clientPs1, '-Action', 'stop', '-Standalone') -WindowStyle Hidden | Out-Null
}

function New-StateIcon([string]$state) {
  $color = switch ($state) {
    'ready' { [System.Drawing.Color]::FromArgb(46, 204, 113) }
    'starting' { [System.Drawing.Color]::FromArgb(241, 196, 15) }
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

# ---------------- SelfTest ----------------
if ($SelfTest) {
  Remove-Item $backupFile -Force -ErrorAction SilentlyContinue
  Write-Host '=== 托盘 v2 自检 ==='
  $t = Get-Tunnel
  Write-Host ("[隧道] state=" + $t.state + " pid=" + $t.pid + " http=" + $t.http)
  $before = Get-ProxySnapshot
  Write-Host ("[原始代理] enable=" + $before.ProxyEnable + " server='" + $before.ProxyServer + "' auto='" + $before.AutoConfigURL + "'")
  Set-GlobalProxy;   $g = Get-ProxySnapshot
  Write-Host ("[自动配置] enable=" + $g.ProxyEnable + " server=" + $g.ProxyServer + " → " + $(if ($g.ProxyEnable -eq 1 -and $g.ProxyServer -eq $httpBind) { 'OK' } else { 'FAILED' }))
  Set-PacProxy;      $p = Get-ProxySnapshot
  Write-Host ("[PAC 模式] enable=" + $p.ProxyEnable + " auto=" + $p.AutoConfigURL + " → " + $(if ($p.AutoConfigURL) { 'OK' } else { 'FAILED' }))
  Clear-SystemProxy; $c = Get-ProxySnapshot
  Write-Host ("[清除] enable=" + $c.ProxyEnable + " auto='" + $c.AutoConfigURL + "' → " + $(if ($c.ProxyEnable -eq 0 -and -not $c.AutoConfigURL) { 'OK' } else { 'FAILED' }))
  Restore-ProxyBackup; $a = Get-ProxySnapshot
  Write-Host ("[还原] enable=" + $a.ProxyEnable + " server='" + $a.ProxyServer + "' → " + $(if ($a.ProxyEnable -eq $before.ProxyEnable -and $a.ProxyServer -eq $before.ProxyServer -and $a.AutoConfigURL -eq $before.AutoConfigURL) { 'OK' } else { 'FAILED' }))
  Remove-Item $backupFile -Force -ErrorAction SilentlyContinue
  Write-Host '=== 结束 ==='
  exit 0
}

# ---------------- 单实例（Local\ 命名空间，普通用户可创建） ----------------
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\NuaaVpnTrayV2', [ref]$createdNew)
if (-not $createdNew) { Write-TrayLog 'another tray instance is running -> exit'; exit 0 }

[System.Windows.Forms.Application]::EnableVisualStyles()
$trayIcon = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$trayIcon.ContextMenuStrip = $menu
$trayIcon.Visible = $true

$miGlobal = New-Object System.Windows.Forms.ToolStripMenuItem '自动配置系统代理'
$miPac = New-Object System.Windows.Forms.ToolStripMenuItem 'PAC 模式（仅校内走隧道）'
$miClear = New-Object System.Windows.Forms.ToolStripMenuItem '清除系统代理'
$miManual = New-Object System.Windows.Forms.ToolStripMenuItem '不变更系统代理（还原）'
$sep1 = New-Object System.Windows.Forms.ToolStripSeparator
$miStart = New-Object System.Windows.Forms.ToolStripMenuItem '启动隧道'
$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem '重启隧道'
$miStop = New-Object System.Windows.Forms.ToolStripMenuItem '停止隧道'
$miStatus = New-Object System.Windows.Forms.ToolStripMenuItem '状态：未启动'
$miStatus.Enabled = $false
$miProxy = New-Object System.Windows.Forms.ToolStripMenuItem '系统代理：未变更'
$miProxy.Enabled = $false
$sep2 = New-Object System.Windows.Forms.ToolStripSeparator
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem '退出'

$miGlobal.add_Click({ Set-GlobalProxy })
$miPac.add_Click({ Set-PacProxy })
$miClear.add_Click({ Clear-SystemProxy })
$miManual.add_Click({ Restore-ProxyBackup })
$miStart.add_Click({ Start-Tunnel })
$miRestart.add_Click({ Stop-Tunnel; Start-Sleep -Milliseconds 800; Start-Tunnel })
$miStop.add_Click({ Stop-Tunnel })
$miExit.add_Click({
  if ((Get-Mode) -in @('global', 'pac')) { Clear-SystemProxy }
  Stop-Tunnel
  Start-Sleep -Milliseconds 300
  $trayIcon.Visible = $false; $trayIcon.Dispose()
  Write-TrayLog 'tray exit'
  [System.Windows.Forms.Application]::Exit()
})

foreach ($item in @($miGlobal, $miPac, $miClear, $miManual, $sep1, $miStart, $miRestart, $miStop, $miStatus, $miProxy, $sep2, $miExit)) { [void]$menu.Items.Add($item) }

$script:lastState = ''
$script:failStreak = 0
$script:lastAutoStart = [datetime]::MinValue

function Update-Ui {
  $t = Get-Tunnel
  $mode = Get-Mode
  $snap = Get-ProxySnapshot
  if ($t.state -ne $script:lastState) {
    $trayIcon.Icon = New-StateIcon $t.state
    $script:lastState = $t.state
  }
  $label = switch ($t.state) { 'ready' { '已连接' } 'starting' { '启动中' } default { '未启动' } }
  $trayIcon.Text = "校内 VPN · $label · $httpBind"
  $miStatus.Text = if ($t.pid) { "状态：$label（pid $($t.pid)）" } else { "状态：$label" }
  $miStart.Enabled = ($t.state -eq 'stopped')
  $miStop.Enabled = ($t.state -ne 'stopped')
  $isPac = ($snap.AutoConfigURL -and ($snap.AutoConfigURL -eq $pacUrl -or $snap.AutoConfigURL -like '*nuaa-vpn.pac' -or $snap.AutoConfigURL -like '*/proxy.pac')) -or ($mode -eq 'pac')
  $isGlobal = ($snap.ProxyEnable -eq 1 -and $snap.ProxyServer -eq $httpBind) -or ($mode -eq 'global')
  $miPac.Checked = [bool]$isPac
  $miGlobal.Checked = [bool]($isGlobal -and -not $isPac)
  $miClear.Checked = (-not $isPac -and -not $isGlobal -and $mode -eq 'clear')
  $miManual.Checked = ($mode -eq 'manual')
  if ($isPac) { $miProxy.Text = "系统代理：PAC → " + $snap.AutoConfigURL }
  elseif ($isGlobal) { $miProxy.Text = "系统代理：全局 → $httpBind" }
  elseif ($mode -eq 'clear') { $miProxy.Text = '系统代理：已清除' }
  else { $miProxy.Text = '系统代理：未变更' }
  return $t
}

function Watchdog {
  $t = Update-Ui
  $mode = Get-Mode
  if ($mode -notin @('global', 'pac')) { $script:failStreak = 0; return }
  if ($t.state -eq 'ready') { $script:failStreak = 0; return }
  # 代理开着但隧道不在：自动重连（15 秒节流）
  if (((Get-Date) - $script:lastAutoStart).TotalSeconds -gt 15) {
    $script:lastAutoStart = Get-Date
    $script:failStreak++
    Write-TrayLog ("watchdog: tunnel " + $t.state + ", auto-start attempt " + $script:failStreak)
    if ($t.state -eq 'stopped') { Start-Tunnel }
  }
  if ($script:failStreak -ge 3) {
    Write-TrayLog 'watchdog: giving up, clearing system proxy to avoid proxy errors'
    Clear-SystemProxy
    $script:failStreak = 0
    try {
      $trayIcon.BalloonTipTitle = '校内 VPN 已断开'
      $trayIcon.BalloonTipText = "隧道连续 3 次没能起来，已自动撤销系统代理（浏览器不会卡在代理错误页）。`n右键图标可重试『启动隧道』。"
      $trayIcon.ShowBalloonTip(8000)
    } catch { }
  }
}

$menu.add_Opening({ Update-Ui | Out-Null })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({ Watchdog })
$timer.Start()

Write-TrayLog '--- tray v2 starting ---'
$t0 = Update-Ui
Write-TrayLog ("ready: state=" + $t0.state + " http=" + $httpBind + " pac=" + $pacUrl)
# 托盘启动时若已选择代理模式但隧道没起，自动拉起
if ((Get-Mode) -in @('global', 'pac') -and $t0.state -eq 'stopped') { Start-Tunnel }
try {
  $trayIcon.BalloonTipTitle = '校内 VPN 托盘已启动'
  $trayIcon.BalloonTipText = "右键图标：自动配置系统代理 / PAC 模式（仅校内走隧道）/ 清除系统代理 / 启停隧道 / 退出。`n隧道由托盘自己托管，不需要打开 PI-Desktop。"
  $trayIcon.ShowBalloonTip(6000)
} catch { }
Write-TrayLog 'message loop entered'
[System.Windows.Forms.Application]::Run()