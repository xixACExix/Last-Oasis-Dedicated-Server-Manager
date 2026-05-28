param(
    [int]$Port = 4020,
    [int]$IntervalSeconds = 15
)

$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $root "data"
$logPath = Join-Path $dataRoot "backend-watchdog.log"
$startScript = Join-Path $PSScriptRoot "start-control-center.ps1"

New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null

function Write-WatchdogLog {
    param([string]$Message)

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $logPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Test-BackendHealth {
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 6
        return [bool]$response.ok
    } catch {
        return $false
    }
}

Write-WatchdogLog "Backend watchdog started for port $Port."

while ($true) {
    if (-not (Test-BackendHealth)) {
        Write-WatchdogLog "Backend health check failed. Starting control center backend."
        try {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript
            if ($LASTEXITCODE -ne 0) {
                Write-WatchdogLog "Start script exited with code $LASTEXITCODE."
            }
        } catch {
            Write-WatchdogLog "Start script failed: $($_.Exception.Message)"
        }
    }

    Start-Sleep -Seconds ([Math]::Max(5, $IntervalSeconds))
}
