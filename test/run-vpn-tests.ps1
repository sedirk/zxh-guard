# Offline regression tests. No real VPN credentials, campus login or proxy registry writes.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'bin\vpn-lifecycle.ps1')
. (Join-Path $root 'bin\vpn-runtime.ps1')
$count = 0
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Test-Case([string]$Name, [scriptblock]$Body) { & $Body; $script:count++; Write-Host "PASS $Name" }
$t = [datetime]'2026-01-01T00:00:00'
Test-Case '100 duplicate starts and watchdog observations produce one operation' {
  $m = New-VpnLifecycle
  Assert (Request-VpnAction $m 'start' $t) 'first start rejected'
  $m.Effect = '' # consumed by dispatcher once
  1..100 | ForEach-Object {
    Assert (-not (Request-VpnAction $m 'start' $t)) 'duplicate start accepted'
    Assert (-not (Request-VpnAction $m 'restart' $t)) 'restart while starting accepted'
    Observe-VpnLifecycle $m 'stopped' ($t.AddSeconds(20))
  }
  Assert ($m.State -eq 'starting' -and $m.Operation -eq 'start' -and -not $m.Effect) 'watchdog started a second operation'
  Assert (-not (Get-VpnControls $m).CanStart -and (Get-VpnControls $m).CanStop) 'busy button state'
}
Test-Case 'cancel waits for start completion then stops; no auto reconnect' {
  $m = New-VpnLifecycle; [void](Request-VpnAction $m 'start' $t); $m.Effect = ''
  Assert (Request-VpnAction $m 'stop' $t) 'cancel rejected'
  Assert ($m.State -eq 'stopping' -and -not $m.WantRunning -and -not $m.Effect) 'cancel spawned concurrent stop'
  Complete-VpnOperation $m $true 'ready' '' $t
  Assert ($m.Operation -eq 'stop' -and $m.Effect -eq 'stop') 'cancel failed to queue cleanup'
  Complete-VpnOperation $m $true 'stopped' '' $t
  Observe-VpnLifecycle $m 'stopped' ($t.AddMinutes(5))
  Assert ($m.State -eq 'stopped' -and -not $m.WantRunning -and -not $m.Effect) 'manual stop auto-reconnected'
}
Test-Case 'restart is strictly stop then start and repeated restart is ignored' {
  $m = New-VpnLifecycle; [void](Request-VpnAction $m 'start' $t)
  Complete-VpnOperation $m $true 'ready' '' $t
  Assert (Request-VpnAction $m 'restart' $t) 'restart rejected'
  $m.Effect = ''
  Assert (-not (Request-VpnAction $m 'restart' $t)) 'double restart accepted'
  Observe-VpnLifecycle $m 'ready' ($t.AddSeconds(10))
  Assert ($m.Operation -eq 'stop' -and -not $m.Effect) 'start overlapped stop'
  Complete-VpnOperation $m $true 'stopped' '' ($t.AddSeconds(11))
  Assert ($m.Operation -eq 'start' -and $m.Effect -eq 'start') 'restart did not start after stop'
}
Test-Case 'failed stop cancels restart' {
  $m = New-VpnLifecycle; Observe-VpnLifecycle $m 'ready' $t
  [void](Request-VpnAction $m 'restart' $t)
  Complete-VpnOperation $m $false 'ready' 'stop failed' $t
  Assert ($m.State -eq 'failed' -and -not $m.Effect -and -not $m.WantRunning) 'restart proceeded after failed stop'
  Observe-VpnLifecycle $m 'ready' ($t.AddSeconds(1))
  Assert ($m.State -eq 'failed' -and $m.LastError -eq 'stop failed' -and (Get-VpnControls $m).CanStop) 'observation concealed stop failure'
}
Test-Case 'three failures stop retries and a manual retry resets the budget' {
  $m = New-VpnLifecycle; [void](Request-VpnAction $m 'start' $t)
  foreach ($i in 1..3) {
    Complete-VpnOperation $m $false 'stopped' 'simulated failure' $t
    if ($i -lt 3) {
      Assert ($m.State -eq 'retry_wait' -and $m.Failures -eq $i) 'missing retry budget'
      Observe-VpnLifecycle $m 'stopped' ($t.AddSeconds(14))
      Assert (-not $m.Operation) 'early retry'
      Observe-VpnLifecycle $m 'stopped' ($t.AddSeconds(15))
      Assert ($m.Operation -eq 'start') 'retry not dispatched'
    }
  }
  Assert ($m.State -eq 'failed' -and -not $m.WantRunning) 'retries did not stop'
  Assert (Request-VpnAction $m 'start' $t) 'manual retry rejected'
  Assert ($m.Failures -eq 0) 'manual retry did not reset budget'
}
Test-Case 'brief readiness does not reset failure counter' {
  $m = New-VpnLifecycle; [void](Request-VpnAction $m 'start' $t)
  $m.Failures = 2; Complete-VpnOperation $m $true 'ready' '' $t
  Observe-VpnLifecycle $m 'stopped' ($t.AddSeconds(2))
  Assert ($m.State -eq 'failed' -and $m.Failures -eq 3) 'flapping resets failure count'
}
Test-Case 'external tunnel cannot be stopped/restarted or trigger a second login' {
  $m = New-VpnLifecycle; Observe-VpnLifecycle $m 'external' $t
  foreach ($action in 'start','stop','restart') { Assert (-not (Request-VpnAction $m $action $t)) 'external tunnel control accepted' }
  Assert (-not (Get-VpnControls $m).CanSetProxy) 'external API proxy advertised as campus-capable'
  Observe-VpnLifecycle $m 'stopped' $t
  Assert ($m.State -eq 'stopped' -and -not $m.Effect) 'dead external tunnel remained starting'
}
Test-Case 'port loss with a live owned process requires cleanup, not another login' {
  $m = New-VpnLifecycle; Observe-VpnLifecycle $m 'starting' $t
  Assert ($m.State -eq 'failed' -and -not (Get-VpnControls $m).CanStart) 'live process allowed duplicate login'
  Assert ((Get-VpnControls $m).CanStop) 'cannot clean up unready process'
}
Test-Case 'server shutdown is terminal and actionable' {
  $m = New-VpnLifecycle; [void](Request-VpnAction $m 'start' $t)
  Complete-VpnOperation $m $true 'ready' '' $t
  $message = '服务端主动关闭了 VPN 会话（SHUTDOWN）。请确认账号未在手机或另一台电脑登录；不要使用全局代理，改用 PAC 模式后重试。'
  Observe-VpnLifecycle $m 'stopped' ($t.AddSeconds(2)) $message
  Assert ($m.State -eq 'failed' -and -not $m.WantRunning) 'server shutdown was not terminal'
  Assert ($m.LastError -match 'SHUTDOWN' -and $m.LastError -match 'PAC') 'server shutdown message is not actionable'
  Observe-VpnLifecycle $m 'stopped' ($t.AddMinutes(5))
  Assert (-not $m.Operation -and -not $m.WantRunning) 'server shutdown was retried'
}
Test-Case 'unready process exposes the shutdown cause instead of an English port error' {
  $m = New-VpnLifecycle
  Observe-VpnLifecycle $m 'starting' $t '服务端主动关闭了 VPN 会话（SHUTDOWN）；请先断开。'
  Assert ($m.State -eq 'failed' -and $m.LastError -match 'SHUTDOWN') 'shutdown cause was lost'
  Assert (-not (Get-VpnControls $m).CanStart -and (Get-VpnControls $m).CanStop) 'unready process controls are wrong'
}
Test-Case 'engine log tail recognizes a server shutdown without credentials' {
  $dir = Join-Path ([IO.Path]::GetTempPath()) ('vpn-hint-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $dir | Out-Null
  try {
    $out = Join-Path $dir 'engine.out.log'
    Set-Content -LiteralPath $out -Value '2026/11/07 14:51:03 SendConn: server returned SHUTDOWN (cmd 0x08); session terminated by server' -Encoding UTF8
    $hint = Get-VpnFailureHint ([pscustomobject]@{ stdout = $out; stderr = '' })
    Assert ($hint -match 'SHUTDOWN' -and $hint -match 'PAC') 'log hint did not identify SHUTDOWN'
  } finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'worker timeout remains visible after serialized cleanup' {
  $m = New-VpnLifecycle; [void](Request-VpnAction $m 'start' $t)
  $m.WantRunning = $false
  Complete-VpnOperation $m $false 'starting' 'worker timed out' $t
  Assert ($m.Operation -eq 'stop') 'timeout did not schedule cleanup'
  Complete-VpnOperation $m $true 'stopped' '' $t
  Observe-VpnLifecycle $m 'stopped' ($t.AddMinutes(5))
  Assert ($m.State -eq 'failed' -and $m.LastError -eq 'worker timed out' -and -not $m.Effect) 'cleanup erased timeout or retried'
}
Test-Case 'cancel retry countdown prevents future starts' {
  $m = New-VpnLifecycle; [void](Request-VpnAction $m 'start' $t)
  Complete-VpnOperation $m $false 'stopped' 'failure' $t
  Assert ((Get-VpnControls $m).CanStop) 'countdown cannot be cancelled'
  [void](Request-VpnAction $m 'stop' $t)
  Observe-VpnLifecycle $m 'stopped' ($t.AddMinutes(5))
  Assert ($m.State -eq 'stopped' -and -not $m.Effect -and -not $m.WantRunning) 'cancelled retry started'
}
Test-Case 'sustained readiness resets retry budget' {
  $m = New-VpnLifecycle; [void](Request-VpnAction $m 'start' $t)
  $m.Failures = 2; Complete-VpnOperation $m $true 'ready' '' $t
  Observe-VpnLifecycle $m 'ready' ($t.AddSeconds(60))
  Assert ($m.Failures -eq 0) 'stable connection did not reset budget'
}

$base = if ($env:PI_SCRATCH_DIR) { $env:PI_SCRATCH_DIR } else { [IO.Path]::GetTempPath() }
$temp = Join-Path $base ('vpn-tests-' + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $temp 'bin'; New-Item -ItemType Directory -Path $bin | Out-Null
$oldTemp = $env:TEMP; $oldTmp = $env:TMP
$workers = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$proxyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$proxyBefore = Get-ItemProperty $proxyPath | Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL | ConvertTo-Json -Compress
function Launch([string]$Action, [string]$Name) {
  $argsList = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $bin 'campus-vpn.ps1'),'-Standalone','-Action',$Action,'-ResultFile',(Join-Path $temp "$Name.json"))
  $p = Start-Process powershell.exe -ArgumentList (($argsList | ForEach-Object {ConvertTo-VpnArgument $_}) -join ' ') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $temp "$Name.out") -RedirectStandardError (Join-Path $temp "$Name.err")
  $workers.Add($p); return $p
}
function Finish($Process, [string]$Name) {
  Assert ($Process.WaitForExit(25000)) "worker timeout: $Name"
  $Process.Refresh()
  $file = Join-Path $temp "$Name.json"
  Assert (Test-Path $file) "worker result missing: $Name"
  return Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Free-Port {
  $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0); $l.Start()
  $port = $l.LocalEndpoint.Port; $l.Stop(); return $port
}
try {
  $env:TEMP = $temp; $env:TMP = $temp
  Copy-Item (Join-Path $root 'bin\campus-vpn.ps1'),(Join-Path $root 'bin\vpn-runtime.ps1'),(Join-Path $root 'bin\vpn-lifecycle.ps1'),(Join-Path $root 'bin\nuaa-vpn-tray.ps1') $bin
  # Test a private mutex namespace so the suite cannot block live tray operations.
  $testLock = 'Local\NuaaVpnTest-' + [guid]::NewGuid().ToString('N')
  $runtimeFile = Join-Path $bin 'vpn-runtime.ps1'
  $runtimeText = [IO.File]::ReadAllText($runtimeFile)
  Assert ($runtimeText.Contains('Local\NuaaCampusVpnLifecycle')) 'mutex test substitution target missing'
  [IO.File]::WriteAllText($runtimeFile, $runtimeText.Replace('Local\NuaaCampusVpnLifecycle', $testLock), (New-Object System.Text.UTF8Encoding($true)))
  $hp = Free-Port; do { $sp = Free-Port } while ($sp -eq $hp)
  $config = @{studentId='fake user'; password='fake "quoted" end\'; tunnel=@{protocol='easyconnect';server='test.invalid';port=443}; campusClient=@{httpBind="127.0.0.1:$hp";socksBind="127.0.0.1:$sp";startTimeoutMs=8000;domains=@('test.invalid')}}
  Write-VpnJson (Join-Path $temp 'config.json') $config
  $exe = Join-Path $bin 'zju-connect.exe'
  Add-Type -OutputAssembly $exe -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
public static class FakeVpn {
  static string Arg(string[] a,string k) { int i=Array.IndexOf(a,k); return i<0?"":a[i+1]; }
  static void Serve(TcpListener l) { while(true) { try { l.AcceptTcpClient().Close(); } catch { return; } } }
  public static int Main(string[] a) {
    if(Arg(a,"-username")!="fake user" || Arg(a,"-password")!="fake \"quoted\" end\\") return 41;
    File.AppendAllText("starts.txt", System.Diagnostics.Process.GetCurrentProcess().Id+"\n");
    string mode=File.Exists("mode.txt")?File.ReadAllText("mode.txt").Trim():"ok";
    if(mode=="fail") { Console.Error.WriteLine("panic: simulated engine failure"); return 7; }
    if(mode=="timeout") { Thread.Sleep(20000); return 9; }
    Thread.Sleep(1500);
    var h=new TcpListener(IPAddress.Loopback,int.Parse(Arg(a,"-http-bind").Split(':')[1]));
    var s=new TcpListener(IPAddress.Loopback,int.Parse(Arg(a,"-socks-bind").Split(':')[1]));
    h.Start(); s.Start();
    var ht=new Thread(()=>Serve(h)); ht.IsBackground=true; ht.Start();
    var st=new Thread(()=>Serve(s)); st.IsBackground=true; st.Start();
    Thread.Sleep(60000); return 0;
  }
}
'@
  Test-Case 'two concurrent CLI starts spawn exactly one engine; arguments round-trip' {
    $a = Launch 'start' 'a'; $b = Launch 'start' 'b'
    $ra = Finish $a 'a'; $rb = Finish $b 'b'
    Assert ((@($ra.code,$rb.code) | Sort-Object) -join ',' -eq '0,75') 'expected one success and one busy result'
    Assert (@(Get-Content (Join-Path $bin 'starts.txt')).Count -eq 1) 'more than one engine spawned'
    $snap = Get-VpnSnapshot (Join-Path $temp 'nuaa-campus-vpn.json') $exe "127.0.0.1:$hp" "127.0.0.1:$sp"
    Assert ($snap.state -eq 'ready') 'engine not ready (or argument quoting failed)'
    $script:ownedRecord = $snap.record
  }
  Test-Case 'repeated CLI start is idempotent and preserves process ownership' {
    $r = Finish (Launch 'start' 'repeat') 'repeat'
    Assert ($r.ok -and $r.pid -eq $script:ownedRecord.pid) 'owner PID changed'
    Assert (@(Get-Content (Join-Path $bin 'starts.txt')).Count -eq 1) 'repeat logged in again'
  }
  Test-Case 'wrong creation time and external pid=0 are never killed' {
    $stateFile = Join-Path $temp 'nuaa-campus-vpn.json'
    $stale = $script:ownedRecord | Select-Object *; $stale.processStartedAt = 'wrong'
    Write-VpnJson $stateFile $stale
    $r = Finish (Launch 'stop' 'stale') 'stale'
    Assert ($r.ok -and $r.state -eq 'external' -and (Get-Process -Id $script:ownedRecord.pid -ErrorAction SilentlyContinue)) 'stale PID was killed'
    Write-VpnJson $stateFile @{external=$true;pid=0}
    $r = Finish (Launch 'stop' 'external') 'external'
    Assert ($r.ok -and $r.state -eq 'external') 'external record was not protected'
    Write-VpnJson $stateFile $script:ownedRecord
    $r = Finish (Launch 'stop' 'ownedstop') 'ownedstop'
    Assert ($r.ok -and $r.state -eq 'stopped') 'owned engine did not stop'
  }
  Test-Case 'stop waits behind an in-progress CLI start and leaves no engine' {
    $a = Launch 'start' 'serialstart'
    $deadline = (Get-Date).AddSeconds(5)
    while (@(Get-Content (Join-Path $bin 'starts.txt')).Count -lt 2 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
    $b = Launch 'stop' 'serialstop'
    $ra = Finish $a 'serialstart'; $rb = Finish $b 'serialstop'
    Assert ($ra.ok -and $rb.ok -and $rb.state -eq 'stopped') 'stop/start were not serialized'
    Assert (-not (Test-VpnPort '127.0.0.1' $hp)) 'engine remained after stop'
  }
  Test-Case 'engine failure is reported and old logs are not overwritten' {
    Set-Content (Join-Path $bin 'mode.txt') 'fail' -Encoding ASCII
    $r = Finish (Launch 'start' 'failure') 'failure'
    Assert (-not $r.ok -and $r.code -eq 1 -and $r.message) 'missing failure feedback'
    Assert (-not (Test-Path (Join-Path $temp 'nuaa-campus-vpn.json'))) 'failed PID record retained'
    Assert (@(Get-ChildItem $temp -Filter 'nuaa-campus-vpn-*.out.log').Count -eq 3) 'logs were overwritten'
  }
  Test-Case 'startup timeout cleans only its engine and releases the mutex' {
    Set-Content (Join-Path $bin 'mode.txt') 'timeout' -Encoding ASCII
    $config.campusClient.startTimeoutMs = 3000; Write-VpnJson (Join-Path $temp 'config.json') $config
    $r = Finish (Launch 'start' 'timeout') 'timeout'
    Assert (-not $r.ok -and $r.message) 'timeout reported success'
    $testPid = [int](@(Get-Content (Join-Path $bin 'starts.txt'))[-1])
    Assert (-not (Get-Process -Id $testPid -ErrorAction SilentlyContinue)) 'timeout leaked engine'
    $m = Enter-VpnActionLock -Name $testLock; Assert ($null -ne $m) 'mutex leaked'; Exit-VpnActionLock $m
    Assert (-not (Test-Path (Join-Path $temp 'nuaa-campus-vpn.starting'))) 'timeout left startup marker'
  }
  Test-Case 'killed start worker leaves an identifiable child that serialized stop cleans' {
    $a = Launch 'start' 'killedworker'
    $stateFile = Join-Path $temp 'nuaa-campus-vpn.json'
    $deadline = (Get-Date).AddSeconds(5)
    while (-not (Test-Path $stateFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
    Assert (Test-Path $stateFile) 'child ownership was not recorded'
    $owned = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $a.Kill(); Assert ($a.WaitForExit(3000)) 'worker did not exit'
    $r = Finish (Launch 'stop' 'afterkill') 'afterkill'
    Assert ($r.ok -and $r.state -eq 'stopped') 'cleanup after abandoned mutex failed'
    Assert (-not (Get-Process -Id $owned.pid -ErrorAction SilentlyContinue)) 'orphan child survived'
    Assert (-not (Test-Path (Join-Path $temp 'nuaa-campus-vpn.starting'))) 'killed worker left startup marker'
  }
  Test-Case 'vanished external proxy is stopped, not permanently starting' {
    $stateFile = Join-Path $temp 'nuaa-campus-vpn.json'; Write-VpnJson $stateFile @{external=$true;pid=0}
    $snap = Get-VpnSnapshot $stateFile $exe "127.0.0.1:$hp" "127.0.0.1:$sp"
    Assert ($snap.state -eq 'stopped') 'dead external state stuck'
  }
  Test-Case 'real WinForms menu event smoke test without side effects' {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $bin 'nuaa-vpn-tray.ps1') -SelfTest
    Assert ($LASTEXITCODE -eq 0) 'tray menu self-test failed'
  }
} finally {
  foreach ($p in $workers) { try { if (-not $p.HasExited) { $p.Kill(); [void]$p.WaitForExit(3000) }; $p.Dispose() } catch { } }
  Get-Process zju-connect -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $bin 'zju-connect.exe') } | Stop-Process -Force
  $env:TEMP = $oldTemp; $env:TMP = $oldTmp
  $proxyAfter = Get-ItemProperty $proxyPath | Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL | ConvertTo-Json -Compress
  Assert ($proxyBefore -eq $proxyAfter) 'system proxy was unexpectedly changed'
  Write-Host "Offline test artifacts: $temp"
}
Write-Host "RESULT: $count tests passed; system proxy unchanged."
