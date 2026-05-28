param(
    [string]$TaskName = "Last Oasis Manager Backend Watchdog",
    [int]$Port = 4020
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$watchdogScript = Join-Path $PSScriptRoot "backend-watchdog.ps1"

if (-not (Test-Path -LiteralPath $watchdogScript)) {
    throw "Backend watchdog script was not found: $watchdogScript"
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$actionArguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", "`"$watchdogScript`"",
    "-Port", $Port
) -join " "

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument $actionArguments `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed backend autostart task: $TaskName" -ForegroundColor Green
Write-Host "The backend watchdog starts at user logon and restarts the manager backend if it crashes." -ForegroundColor Green
