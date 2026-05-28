$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:PORT) { [int]$env:PORT } else { 4020 }
$stopped = New-Object System.Collections.Generic.List[string]

function Stop-TrackedProcess {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [Parameter(Mandatory = $true)]
        [string]$Reason
    )

    if ($ProcessId -eq $PID) {
        return
    }

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) {
        return
    }

    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        $stopped.Add("$($process.ProcessName)#$ProcessId ($Reason)") | Out-Null
    } catch {
        Write-Warning "Failed to stop process $ProcessId ($Reason): $($_.Exception.Message)"
    }
}

$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
    Stop-TrackedProcess -ProcessId $listener.OwningProcess -Reason "port $port listener"
}

$candidates = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and $_.CommandLine -like "*$root*" -and (
        $_.CommandLine -like "*src/server/index.ts*" -or
        $_.CommandLine -like "*dist/server/index.js*" -or
        $_.CommandLine -like "*backend-watchdog.ps1*" -or
        $_.CommandLine -like "*launcher-monitor.ps1*" -or
        $_.CommandLine -like "*start-control-center.ps1*" -or
        $_.CommandLine -like "*lo-tool.cmd*" -or
        $_.CommandLine -like "*npm.cmd run start*"
    )
}

foreach ($candidate in $candidates) {
    Stop-TrackedProcess -ProcessId $candidate.ProcessId -Reason "control center helper"
}

if ($stopped.Count -eq 0) {
    Write-Host "Last Oasis Control Center backend is already stopped." -ForegroundColor Yellow
    exit 0
}

Write-Host "Stopped Last Oasis Control Center components:" -ForegroundColor Green
$stopped | Sort-Object -Unique | ForEach-Object { Write-Host " - $_" }
