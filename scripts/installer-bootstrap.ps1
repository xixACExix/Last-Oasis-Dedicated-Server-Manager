$ErrorActionPreference = "Stop"

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$payloadZip = Join-Path $bundleRoot "FullPackage.zip"
$destination = if ($env:TOOL_01_INSTALL_DESTINATION) {
    $env:TOOL_01_INSTALL_DESTINATION
} elseif ($env:TOOL_01_INSTALLER_SOURCE_DIR) {
    Join-Path $env:TOOL_01_INSTALLER_SOURCE_DIR "LO_Manager_backend"
} else {
    Join-Path $env:SystemDrive "LO_Manager_backend"
}

if (-not (Test-Path $payloadZip)) {
    throw "FullPackage.zip was not found beside the installer bootstrap."
}

$resolvedDestination = [System.IO.Path]::GetFullPath($destination)
New-Item -ItemType Directory -Path $resolvedDestination -Force | Out-Null
Expand-Archive -LiteralPath $payloadZip -DestinationPath $resolvedDestination -Force

Write-Host "Extracted Tool_01 to $resolvedDestination" -ForegroundColor Green
Write-Host "Starting the Last Oasis setup window..." -ForegroundColor Green

$nativeInstaller = Join-Path $resolvedDestination "NativeApp\Tool01.Native.exe"
$dedicatedInstaller = Join-Path $resolvedDestination "DedicatedManager\Last Oasis Dedicated Server Tool.exe"

if (Test-Path $nativeInstaller) {
    Start-Process -FilePath $nativeInstaller -ArgumentList "--install" -WorkingDirectory $resolvedDestination | Out-Null
    exit 0
}

if (Test-Path $dedicatedInstaller) {
    Start-Process -FilePath $dedicatedInstaller -ArgumentList "--install" -WorkingDirectory $resolvedDestination | Out-Null
    exit 0
}

$installScript = Join-Path $resolvedDestination "install-tool_01.cmd"
if (-not (Test-Path $installScript)) {
    throw "No native setup app or install-tool_01.cmd was found after extracting FullPackage.zip."
}

$installerProcess = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$installScript`"" -WorkingDirectory $resolvedDestination -Wait -PassThru
exit $installerProcess.ExitCode
