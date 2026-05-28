$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $root "data"
$logPath = Join-Path $logDirectory "control-center.log"
$portableNpm = Join-Path $root "tools\node\npm.cmd"
$portableNodeExe = Join-Path $root "tools\node\node.exe"
$portableNode = Join-Path $root "tools\node"
$serverEntry = Join-Path $root "dist\server\index.js"
$port = if ($env:PORT) { [int]$env:PORT } else { 4020 }

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$existingListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
  exit 0
}

$nodeCommand = if (Test-Path $portableNodeExe) {
  $portableNodeExe
} else {
  $resolved = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $resolved) {
    throw "No Node runtime was found. Run install-tool_01.cmd first so the control center can install its portable Node runtime."
  }

  $resolved.Source
}

$runtimePathPrefix = if (Test-Path (Join-Path $portableNode "node.exe")) {
  "$portableNode;"
} else {
  ""
}

$command = if (Test-Path $serverEntry) {
  "cd /d `"$root`" && set `PORT=$port` && set `PATH=$runtimePathPrefix%PATH%` && `"$nodeCommand`" `"$serverEntry`" >> `"$logPath`" 2>&1"
} else {
  $npmCommand = if (Test-Path $portableNpm) {
    $portableNpm
  } else {
    $resolved = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $resolved) {
      throw "No packaged server build or npm runtime was found. Run install-tool_01.cmd first so the control center can finish installing."
    }

    $resolved.Source
  }

  "cd /d `"$root`" && set `PORT=$port` && set `PATH=$runtimePathPrefix%PATH%` && `"$npmCommand`" run start:dev >> `"$logPath`" 2>&1"
}
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $command -WindowStyle Hidden | Out-Null
