param(
  [string]$ApiUrl = "http://localhost:4020/api/monitor",
  [string]$BrowserUrl = "http://localhost:4020"
)

$ErrorActionPreference = "SilentlyContinue"

function Write-Banner {
  Clear-Host
  Write-Host ""
  Write-Host "===============================================================" -ForegroundColor Yellow
  Write-Host "                 LAST OASIS CONTROL CENTER" -ForegroundColor Yellow
  Write-Host "===============================================================" -ForegroundColor Yellow
  Write-Host "  Live launcher monitor" -ForegroundColor DarkYellow
  Write-Host ""
  Write-Host "  Q = close monitor    O = open browser again    S = snapshot" -ForegroundColor Gray
  Write-Host ""
}

function Write-EventLine {
  param(
    [string]$Label,
    [string]$Message,
    [ConsoleColor]$Color = [ConsoleColor]::Gray
  )

  if ([string]::IsNullOrWhiteSpace($Message)) {
    return
  }

  $timestamp = Get-Date -Format "HH:mm:ss"
  Write-Host "[$timestamp] $Label $Message" -ForegroundColor $Color
}

function Write-Snapshot {
  param($State)

  if (-not $State) {
    return
  }

  $runningCount = $State.runningHosts
  $desiredHosts = $State.desiredHosts
  $selectedProfile = $State.selectedProfileName
  $launchPhase = $State.launchPhase
  $launchSummary = $State.launchSummary
  $eventPhase = $State.eventPhase
  $eventNext = $State.nextTransitionAt
  $eventNextText = if ($eventNext) { (Get-Date $eventNext).ToString("dd/MM HH:mm") } else { "none" }
  $activeBatchCount = $State.activeBatchCount
  $previewBatchCount = $State.previewBatchCount

  Write-Host ""
  Write-Host "Current snapshot" -ForegroundColor Cyan
  Write-Host "  Running hosts : $runningCount"
  Write-Host "  Desired hosts : $desiredHosts"
  Write-Host "  Selected host : $selectedProfile"
  Write-Host "  Launch phase  : $launchPhase"
  Write-Host "  Launch note   : $launchSummary"
  Write-Host "  Event phase   : $eventPhase"
  Write-Host "  Active batch  : $activeBatchCount"
  Write-Host "  Preview batch : $previewBatchCount"
  Write-Host "  Next event    : $eventNextText"
  Write-Host ""
}

Write-Banner

$browserOpened = $false
$wasReachable = $false
$waitingNoticeShown = $false
$lastStatusDigest = ""
$lastSchedulerAction = ""
$lastEventAction = ""
$lastLaunchSummary = ""
$lastRunningCount = -1
$lastDesiredCount = -1
$lastPhase = ""
$lastSelectedProfile = ""
$lastSnapshotAt = [DateTime]::MinValue
$shouldExit = $false

while ($true) {
  if ([Console]::KeyAvailable) {
    $key = [Console]::ReadKey($true)
    switch ($key.Key) {
      "Q" {
        Write-Host ""
        Write-Host "Closing launcher monitor. The control center backend keeps running in the background." -ForegroundColor DarkYellow
        $shouldExit = $true
      }
      "O" {
        Start-Process $BrowserUrl | Out-Null
        Write-EventLine -Label "Browser:" -Message "Opened the control center in your default browser." -Color Cyan
      }
      "S" {
        try {
          $state = Invoke-RestMethod -Uri $ApiUrl -TimeoutSec 12
          Write-Snapshot -State $state
        } catch {
          Write-EventLine -Label "Snapshot:" -Message "The local API is not reachable right now." -Color Red
        }
      }
    }
  }

  if ($shouldExit) {
    break
  }

  try {
    $state = Invoke-RestMethod -Uri $ApiUrl -TimeoutSec 12

    if (-not $wasReachable) {
      Write-EventLine -Label "API:" -Message "Control center backend is online." -Color Green
      $wasReachable = $true
      $waitingNoticeShown = $false
    }

    if (-not $browserOpened) {
      Start-Process $BrowserUrl | Out-Null
      Write-EventLine -Label "Browser:" -Message "Opened the control center page." -Color Cyan
      $browserOpened = $true
    }

    $runningCount = $state.runningHosts
    $desiredCount = $state.desiredHosts
    $selectedProfile = $state.selectedProfileName
    $phase = $state.eventPhase
    $statusDigest = "$runningCount|$desiredCount|$selectedProfile|$phase"

    if ($statusDigest -ne $lastStatusDigest) {
      Write-EventLine -Label "Status:" -Message "Running hosts $runningCount, desired hosts $desiredCount, selected $selectedProfile, event phase $phase." -Color White
      $lastStatusDigest = $statusDigest
    }

    if ($state.serverAction -and $state.serverAction -ne $lastSchedulerAction) {
      Write-EventLine -Label "Servers:" -Message $state.serverAction -Color Yellow
      $lastSchedulerAction = $state.serverAction
    }

    if ($state.launchSummary -and $state.launchSummary -ne $lastLaunchSummary) {
      Write-EventLine -Label "Launch:" -Message $state.launchSummary -Color DarkYellow
      $lastLaunchSummary = $state.launchSummary
    }

    if ($state.eventAction -and $state.eventAction -ne $lastEventAction) {
      Write-EventLine -Label "Events:" -Message $state.eventAction -Color Magenta
      $lastEventAction = $state.eventAction
    }

    if (
      $runningCount -ne $lastRunningCount -or
      $desiredCount -ne $lastDesiredCount -or
      $selectedProfile -ne $lastSelectedProfile -or
      $phase -ne $lastPhase -or
      ((Get-Date) - $lastSnapshotAt).TotalSeconds -ge 45
    ) {
      Write-Snapshot -State $state
      $lastRunningCount = $runningCount
      $lastDesiredCount = $desiredCount
      $lastSelectedProfile = $selectedProfile
      $lastPhase = $phase
      $lastSnapshotAt = Get-Date
    }
  } catch {
    if ($wasReachable) {
      Write-EventLine -Label "API:" -Message "Lost connection to the local control center backend. Waiting for it to come back..." -Color Red
    } elseif (-not $waitingNoticeShown) {
      Write-EventLine -Label "API:" -Message "Waiting for the local control center backend to come online..." -Color DarkYellow
      $waitingNoticeShown = $true
    }

    $wasReachable = $false
  }

  Start-Sleep -Milliseconds 2500
}
