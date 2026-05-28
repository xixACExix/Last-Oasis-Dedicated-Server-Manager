param(
    [string]$TaskName = "Last Oasis Manager Backend Watchdog"
)

$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Backend autostart task is not installed: $TaskName" -ForegroundColor Yellow
    exit 0
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

Write-Host "Removed backend autostart task: $TaskName" -ForegroundColor Green
