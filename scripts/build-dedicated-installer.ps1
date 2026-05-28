$ErrorActionPreference = "Stop"

$toolRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $toolRoot "release"
$packageZipPath = Join-Path $releaseRoot "FullPackage.zip"
$outputExePath = Join-Path $releaseRoot "LastOasisManager-Installer.exe"
$bootstrapperSourcePath = Join-Path $PSScriptRoot "DedicatedInstallerBootstrapper.cs"
$bootstrapScriptPath = Join-Path $PSScriptRoot "installer-bootstrap.ps1"
$iconPath = Join-Path $toolRoot "native\Tool01.Native\Assets\LastOasisManager.ico"
$cscCandidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$cscPath = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

function Remove-FileWithRetry {
    param(
        [string]$Path,
        [int]$Attempts = 5
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
            return
        }
        catch {
            if ($attempt -eq $Attempts) {
                throw
            }

            Start-Sleep -Milliseconds (250 * $attempt)
        }
    }
}

if (-not (Test-Path -LiteralPath $packageZipPath)) {
    throw "FullPackage.zip was not found. Run scripts\\build-dedicated-package.ps1 first."
}

if (-not (Test-Path -LiteralPath $bootstrapperSourcePath)) {
    throw "Dedicated installer bootstrapper source was not found: $bootstrapperSourcePath"
}

if (-not (Test-Path -LiteralPath $bootstrapScriptPath)) {
    throw "installer-bootstrap.ps1 was not found: $bootstrapScriptPath"
}

if (-not (Test-Path -LiteralPath $iconPath)) {
    throw "Last Oasis installer icon was not found: $iconPath"
}

if (-not $cscPath) {
    throw "C# compiler (csc.exe) was not found."
}

if (Test-Path -LiteralPath $outputExePath) {
    Remove-FileWithRetry -Path $outputExePath
}

& $cscPath `
    /nologo `
    /target:winexe `
    /out:$outputExePath `
    /win32icon:$iconPath `
    /reference:System.Windows.Forms.dll `
    /resource:$packageZipPath,Tool01Zip `
    /resource:$bootstrapScriptPath,InstallerBootstrapPs1 `
    $bootstrapperSourcePath

if ($LASTEXITCODE -ne 0) {
    throw "Failed to compile LastOasisManager-Installer.exe. Exit code: $LASTEXITCODE"
}

if (-not (Test-Path -LiteralPath $outputExePath)) {
    throw "Dedicated installer exe was not created: $outputExePath"
}

Write-Output $outputExePath
