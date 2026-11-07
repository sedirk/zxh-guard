# Pure lifecycle reducer. No process, registry, network or UI side effects.
function New-VpnLifecycle {
  [pscustomobject]@{
    State = 'stopped'; Observed = 'stopped'; WantRunning = $false
    Operation = ''; Effect = ''; RestartPending = $false
    Since = [datetime]::MinValue; ReadySince = [datetime]::MinValue
    RetryAt = [datetime]::MinValue; Failures = 0; LastError = ''; CleanupError = ''
  }
}
function Begin-VpnOperation($Model, [string]$Action, [datetime]$Now) {
  $Model.Operation = $Action
  $Model.Effect = $Action
  $Model.Since = $Now
  $Model.State = if ($Action -eq 'start') { 'starting' } else { 'stopping' }
}
function Request-VpnAction($Model, [string]$Action, [datetime]$Now = (Get-Date)) {
  switch ($Action) {
    'start' {
      if ($Model.Operation -or $Model.State -notin @('stopped','failed') -or $Model.Observed -ne 'stopped') { return $false }
      $Model.WantRunning = $true; $Model.RestartPending = $false
      $Model.Failures = 0; $Model.LastError = ''; $Model.CleanupError = ''
      Begin-VpnOperation $Model 'start' $Now
    }
    'stop' {
      if ($Model.State -in @('stopped','external','stopping')) { return $false }
      $Model.WantRunning = $false; $Model.RestartPending = $false
      if ($Model.Operation -eq 'start') {
        # Do not spawn stop concurrently. Finish/timeout the start worker, then clean up.
        $Model.State = 'stopping'
      } elseif ($Model.Observed -eq 'stopped' -and -not $Model.Operation) {
        $Model.State = 'stopped'; $Model.LastError = ''; $Model.Failures = 0
      } else { Begin-VpnOperation $Model 'stop' $Now }
    }
    'restart' {
      if ($Model.Operation -or $Model.State -ne 'ready' -or $Model.Observed -ne 'ready') { return $false }
      $Model.WantRunning = $true; $Model.RestartPending = $true
      $Model.Failures = 0; $Model.LastError = ''; $Model.CleanupError = ''
      Begin-VpnOperation $Model 'stop' $Now
    }
    default { return $false }
  }
  return $true
}
function Set-VpnFailure($Model, [string]$Message, [datetime]$Now) {
  $Model.LastError = $Message
  $Model.Failures++
  $Model.ReadySince = [datetime]::MinValue
  # A server-initiated SHUTDOWN is terminal: retrying immediately can lock the account.
  if ($Message -match 'SHUTDOWN|服务端.*关闭') {
    $Model.State = 'failed'; $Model.WantRunning = $false
    return
  }
  if ($Model.WantRunning -and $Model.Failures -lt 3 -and $Model.Observed -eq 'stopped') {
    $Model.State = 'retry_wait'; $Model.RetryAt = $Now.AddSeconds(15)
  } else { $Model.State = 'failed'; $Model.WantRunning = $false }
}
function Complete-VpnOperation($Model, [bool]$Success, [string]$Observed, [string]$Message, [datetime]$Now = (Get-Date)) {
  $action = $Model.Operation
  if (-not $action) { return }
  $Model.Operation = ''; $Model.Effect = ''; $Model.Observed = $Observed
  if ($action -eq 'start') {
    if (-not $Model.WantRunning) {
      if (-not $Success) { $Model.CleanupError = $Message }
      Begin-VpnOperation $Model 'stop' $Now
    } elseif ($Success -and $Observed -eq 'ready') {
      $Model.State = 'ready'; $Model.ReadySince = $Now; $Model.LastError = ''
    } elseif ($Success -and $Observed -eq 'external') {
      $Model.State = 'external'; $Model.WantRunning = $false
      $Model.LastError = ''
    } else {
      if (-not $Message) { $Message = 'Worker did not establish a listening proxy.' }
      Set-VpnFailure $Model $Message $Now
    }
  } else {
    if (-not $Success -or $Observed -in @('ready','starting')) {
      $Model.State = 'failed'; $Model.WantRunning = $false; $Model.RestartPending = $false
      $Model.LastError = if ($Message) { $Message } else { 'Stop did not finish; restart was cancelled.' }
    } elseif ($Observed -eq 'external') {
      $Model.State = 'external'; $Model.WantRunning = $false; $Model.RestartPending = $false
      $Model.LastError = ''
    } elseif ($Model.RestartPending -and $Model.WantRunning) {
      $Model.RestartPending = $false
      Begin-VpnOperation $Model 'start' $Now
    } elseif ($Model.CleanupError) {
      $Model.State = 'failed'; $Model.WantRunning = $false
      $Model.LastError = $Model.CleanupError; $Model.CleanupError = ''
    } else {
      $Model.State = 'stopped'; $Model.WantRunning = $false
      $Model.LastError = ''; $Model.Failures = 0
    }
  }
}
function Observe-VpnLifecycle($Model, [string]$Observed, [datetime]$Now = (Get-Date), [string]$Message = '') {
  $Model.Observed = $Observed
  if ($Model.Operation) { return }
  if ($Observed -eq 'external') {
    $Model.State = 'external'; $Model.WantRunning = $false
    return
  }
  # Keep a failed stop/timeout visible until the user acts; observation is not success.
  if ($Model.State -eq 'failed') { return }
  if ($Observed -eq 'ready') {
    if ($Model.State -ne 'ready') { $Model.ReadySince = $Now }
    $Model.State = 'ready'
    if (($Now - $Model.ReadySince).TotalSeconds -ge 60) { $Model.Failures = 0 }
    return
  }
  if ($Observed -eq 'starting') {
    $Model.State = 'failed'; $Model.WantRunning = $false
    $Model.LastError = if ($Message) { $Message } else { 'VPN 进程仍在退出或代理端口尚未就绪；请先断开，再重试。' }
    return
  }
  if ($Model.State -eq 'ready' -and $Model.WantRunning) {
    $failure = if ($Message) { $Message } else { 'VPN process exited or proxy listener disappeared.' }
    Set-VpnFailure $Model $failure $Now
  } elseif ($Model.State -in @('ready','external')) {
    $Model.State = 'stopped'
  }
  if ($Model.State -eq 'retry_wait' -and $Model.WantRunning -and $Now -ge $Model.RetryAt) {
    Begin-VpnOperation $Model 'start' $Now
  }
}
function Get-VpnControls($Model) {
  [pscustomobject]@{
    CanStart = (-not $Model.Operation -and $Model.State -in @('stopped','failed') -and $Model.Observed -eq 'stopped')
    CanStop = ($Model.State -notin @('stopped','external','stopping') -and ($Model.WantRunning -or $Model.Observed -in @('ready','starting')))
    CanRestart = (-not $Model.Operation -and $Model.State -eq 'ready' -and $Model.Observed -eq 'ready')
    CanSetProxy = (-not $Model.Operation -and $Model.State -eq 'ready')
  }
}
