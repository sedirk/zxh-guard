# 校内 VPN 客户端：所有 CLI/托盘操作由同一个跨进程互斥锁串行化。
param(
  [ValidateSet('start','stop','status')][string]$Action = 'start',
  [switch]$Standalone,
  [string]$ResultFile = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'vpn-runtime.ps1')
$pluginRoot = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $pluginRoot 'config.json'
$exe = Join-Path $PSScriptRoot 'zju-connect.exe'
$pidFile = Join-Path $env:TEMP 'nuaa-campus-vpn.json'
$startMarker = Join-Path $env:TEMP 'nuaa-campus-vpn.starting'
$lock = $null; $proc = $null; $createdMarker = $false; $keepProcess = $false
$result = [ordered]@{ action = $Action; ok = $false; code = 1; message = ''; state = 'stopped'; pid = 0 }
function Snapshot { Get-VpnSnapshot $pidFile $exe $httpBind $socksBind }
function Show-Result($snapshot) {
  $result.state = $snapshot.state
  $result.pid = if ($snapshot.pid) { $snapshot.pid } else { 0 }
  $result.ok = $true; $result.code = 0
}
try {
  if (-not (Test-Path -LiteralPath $configFile)) { throw '找不到 config.json，请先复制并填写配置模板。' }
  $cfg = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $client = $cfg.campusClient
  $httpBind = if ($client.httpBind) { [string]$client.httpBind } else { '127.0.0.1:11081' }
  $socksBind = if ($client.socksBind) { [string]$client.socksBind } else { '127.0.0.1:11080' }
  foreach ($bind in @($httpBind,$socksBind)) { if ($bind -notmatch '^127\.0\.0\.1:\d+$') { throw '代理监听地址必须为 127.0.0.1:端口。' } }
  $gatewayPort = if ($cfg.gatewayPort) { [int]$cfg.gatewayPort } else { 41900 }
  $timeoutSec = if ($client.startTimeoutMs) { [Math]::Max(3, [Math]::Min(180, [double]$client.startTimeoutMs / 1000)) } else { 30 }
  if ($Action -eq 'status') {
    $snapshot = Snapshot; Show-Result $snapshot
    $result.message = '本机状态：' + $snapshot.state + '（端口状态不代表校内 HTTP 已验证）'
  } else {
    $wait = if ($Action -eq 'stop') { 60000 } else { 0 }
    $lock = Enter-VpnActionLock -TimeoutMs $wait
    if (-not $lock) { $result.code = 75; throw '已有连接操作正在进行，请等待完成，不要重复启动。' }
    # Never fall back to a second login after a gateway operation times out.
    if (-not $Standalone -and (Test-VpnPort '127.0.0.1' $gatewayPort)) {
      try {
        $api = Invoke-RestMethod -Uri ("http://127.0.0.1:$gatewayPort/vpn/$Action") -Method Post -TimeoutSec 45
        if (-not $api.ok) { throw '网关操作未成功' }
        $result.ok = $true; $result.code = 0; $result.state = $api.state
        $result.message = '已完成插件网关操作。'
      } catch { throw '插件网关操作失败或超时；为避免重复登录，不再自行启动第二条隧道。' }
    } else {
      $snapshot = Snapshot
      if ($Action -eq 'stop') {
        if ($snapshot.state -eq 'external') {
          Show-Result $snapshot
          $result.message = '代理由外部进程持有，未终止它；请在持有它的插件/客户端中停止。'
        } else {
          $owned = Get-OwnedVpnProcess $snapshot.record $exe
          if ($owned) {
            # Identity includes executable path + creation time, not just a recyclable PID.
            $owned.Kill()
            if (-not $owned.WaitForExit(10000)) { throw '等待 VPN 退出超时，未执行重启。' }
          }
          Remove-VpnStartMarker $startMarker $snapshot.record.startMarkerToken
          if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
          $after = Snapshot
          if ($after.state -in @('ready','starting')) { throw '隧道仍未停止，拒绝继续重启。' }
          Show-Result $after; $result.message = '托盘持有的隧道已停止。'
        }
      } elseif ($snapshot.state -eq 'external') {
        Show-Result $snapshot
        $result.message = '检测到外部代理；未重复登录，也未验证它支持校园浏览。'
      } elseif ($snapshot.state -eq 'ready') {
        Show-Result $snapshot; $result.message = '已有托盘代理就绪，未重复启动。'
      } elseif ($snapshot.state -eq 'starting') {
        throw '已有 VPN 进程但端口尚未就绪，请先停止它再重试。'
      } else {
        if (-not (Test-Path -LiteralPath $exe)) { throw '缺少 zju-connect.exe，请先运行引擎安装脚本。' }
        if (-not $cfg.studentId -or -not $cfg.password) { throw '配置中缺少 studentId/password。' }
        $domains = if ($client.domains -and $client.domains.Count) { @($client.domains) } else { @('nuaa.edu.cn') }
        $argsList = @('-protocol', [string]$cfg.tunnel.protocol, '-server', [string]$cfg.tunnel.server, '-port', [string]$cfg.tunnel.port,
          '-username', [string]$cfg.studentId, '-password', [string]$cfg.password, '-disable-zju-config', '-remote-dns-server', 'auto',
          '-http-bind', $httpBind, '-socks-bind', $socksBind)
        foreach ($domain in $domains) { $argsList += @('-custom-proxy-domain', [string]$domain) }
        if ($cfg.tunnel.bindInterface) { $argsList += @('-bind-interface', [string]$cfg.tunnel.bindInterface) }
        $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + $PID
        $outLog = Join-Path $env:TEMP ("nuaa-campus-vpn-$stamp.out.log")
        $errLog = Join-Path $env:TEMP ("nuaa-campus-vpn-$stamp.err.log")
        # A marker informs the current plugin; the mutex serializes all PowerShell clients.
        $markerToken = $PID.ToString() + '-' + [guid]::NewGuid().ToString('N')
        Set-Content -LiteralPath $startMarker -Value $markerToken -Encoding ASCII
        $createdMarker = $true
        $proc = Start-Process -FilePath $exe -ArgumentList (($argsList | ForEach-Object { ConvertTo-VpnArgument $_ }) -join ' ') `
          -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        $record = [pscustomobject]@{ pid = $proc.Id; external = $false; processStartedAt = $proc.StartTime.ToUniversalTime().ToString('o');
          http = $httpBind; socks = $socksBind; domains = $domains; startedAt = (Get-Date -Format o); stdout = $outLog; stderr = $errLog; startMarkerToken = $markerToken }
        Write-VpnJson $pidFile $record # Write ownership immediately, before waiting for readiness.
        $deadline = (Get-Date).AddSeconds($timeoutSec)
        $readySince = $null
        while ((Get-Date) -lt $deadline) {
          $proc.Refresh()
          if ($proc.HasExited) {
            $text = ''
            foreach ($f in @($outLog,$errLog)) { if (Test-Path $f) { $text += Get-Content $f -Raw -Encoding UTF8 } }
            $cause = if ($text -match 'SHUTDOWN') { '服务端关闭会话' } elseif ($text -match 'panic:') { '引擎崩溃' } else { '引擎提前退出' }
            throw ("$cause（退出码 $($proc.ExitCode)）；日志保留在临时目录，未覆盖上次日志。")
          }
          $snapshot = Snapshot
          if ($snapshot.state -eq 'ready') {
            if (-not $readySince) { $readySince = Get-Date }
            if (((Get-Date) - $readySince).TotalMilliseconds -ge 1500) { break }
          } else { $readySince = $null }
          Set-Content -LiteralPath $startMarker -Value $markerToken -Encoding ASCII
          Start-Sleep -Milliseconds 250
        }
        $proc.Refresh()
        if ($proc.HasExited -or -not $readySince -or ((Get-Date) - $readySince).TotalMilliseconds -lt 1500) { throw '连接超时：代理端口未稳定就绪。' }
        $snapshot = Snapshot
        if ($snapshot.state -ne 'ready') { throw '就绪检查失败，代理端口已消失。' }
        $keepProcess = $true
        Show-Result $snapshot
        $result.message = '本机代理已监听；尚未验证校内 HTTP 可达性。'
      }
    }
  }
} catch {
  # Only emit our own summaries; never dump authentication responses or process arguments.
  $message = $_.Exception.Message
  if ($cfg) { foreach ($secret in @($cfg.studentId,$cfg.password,$cfg.apiKey)) { if ($secret) { $message = $message.Replace([string]$secret, '[REDACTED]') } } }
  $result.message = $message
} finally {
  if ($proc -and -not $keepProcess) {
    try { $proc.Refresh(); if (-not $proc.HasExited) { $proc.Kill(); [void]$proc.WaitForExit(10000) } } catch { }
    if ($proc.HasExited -and (Test-Path -LiteralPath $pidFile)) {
      try { $saved = Get-Content $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json; if ($saved.pid -eq $proc.Id) { Remove-Item -LiteralPath $pidFile -Force } } catch { }
    }
  }
  if ($createdMarker) { Remove-VpnStartMarker $startMarker $markerToken }
  Exit-VpnActionLock $lock
  if ($ResultFile) { Write-VpnJson $ResultFile $result }
}
Write-Host $result.message
exit $result.code
