$ErrorActionPreference = "Stop"

$toolRoot = Split-Path -Parent $PSScriptRoot
$packageManifest = Get-Content -LiteralPath (Join-Path $toolRoot "package.json") -Raw | ConvertFrom-Json
$packageVersion = [string]$packageManifest.version
$releaseRoot = Join-Path $toolRoot "release\FullPackage"
$zipPath = Join-Path $toolRoot "release\FullPackage.zip"
$installerExePath = Join-Path $toolRoot "release\LastOasisManager-Installer.exe"
$nativeProjectPath = Join-Path $toolRoot "native\Tool01.Native\Tool01.Native.csproj"
$inspectorProjectPath = Join-Path $toolRoot "data\MyRealmInspector\MyRealmInspector.csproj"
$nativePublishRoot = Join-Path $toolRoot "tmp\NativeApp.packagebuild"
$nativeStandaloneRoot = Join-Path $toolRoot "release\NativeApp"
$nativeStandaloneZipPath = Join-Path $toolRoot "release\NativeApp.zip"
$dedicatedNativeRoot = Join-Path $toolRoot "release\DedicatedManager"
$dedicatedNativeZipPath = Join-Path $toolRoot "release\DedicatedManager.zip"
$backendHotfixRoot = Join-Path $toolRoot "release\BackendUpdate"
$backendHotfixZipPath = Join-Path $toolRoot "release\BackendUpdate.zip"
$backendPayloadZipPath = Join-Path $toolRoot "tmp\BackendPayload.zip"
$nativePayloadDirectory = Join-Path $toolRoot "native\Tool01.Native\Payload"
$nativePayloadPath = Join-Path $nativePayloadDirectory "Tool_01.payload.zip"
$installerPayloadSourceCandidates = @((Join-Path $toolRoot "InstallerPayload"))
if ($env:TOOL_01_INSTALLER_PAYLOAD_SOURCE) {
    $installerPayloadSourceCandidates += $env:TOOL_01_INSTALLER_PAYLOAD_SOURCE
}
$localNodeCandidate = Join-Path $toolRoot "tools\node\node.exe"
$nodeCommand = $null
if ($env:TOOL_01_NODE_EXE -and (Test-Path -LiteralPath $env:TOOL_01_NODE_EXE)) {
    $nodeCommand = Get-Item -LiteralPath $env:TOOL_01_NODE_EXE
} elseif (Test-Path -LiteralPath $localNodeCandidate) {
    $nodeCommand = Get-Item -LiteralPath $localNodeCandidate
} else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
}
$nodeCommandPath = if ($nodeCommand) {
    if ($nodeCommand.Source) { $nodeCommand.Source } else { $nodeCommand.FullName }
} else {
    ""
}
$nodeRuntimeSource = if ($nodeCommandPath) { Split-Path -Parent $nodeCommandPath } else { "" }
$localDotnetCandidate = Join-Path $toolRoot "tools\dotnet\dotnet.exe"
$dotnetCommand = if (Test-Path -LiteralPath $localDotnetCandidate) {
    Get-Item -LiteralPath $localDotnetCandidate
} else {
    Get-Command dotnet.exe -ErrorAction SilentlyContinue
}
$dotnetCommandPath = if ($dotnetCommand) {
    if ($dotnetCommand.Source) { $dotnetCommand.Source } else { $dotnetCommand.FullName }
} else {
    ""
}
if (-not $dotnetCommandPath) {
    throw "dotnet.exe was not found."
}

function Invoke-NodeBuild {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCommand) {
        & $npmCommand.Source run build
        return
    }

    if (-not $nodeCommand) {
        throw "Neither npm.cmd nor node.exe was found."
    }

    $nodeExe = $nodeCommandPath
    & $nodeExe node_modules\typescript\bin\tsc -p tsconfig.app.json --noEmit
    if ($LASTEXITCODE -ne 0) { return }
    & $nodeExe node_modules\typescript\bin\tsc -p tsconfig.server.json --noEmit
    if ($LASTEXITCODE -ne 0) { return }
    & $nodeExe node_modules\typescript\bin\tsc -p tsconfig.server.build.json
    if ($LASTEXITCODE -ne 0) { return }
    & $nodeExe node_modules\vite\bin\vite.js build
}

Write-Host "Building packaged client and server artifacts..." -ForegroundColor Cyan
Invoke-NodeBuild
if ($LASTEXITCODE -ne 0) {
    throw "Node build failed."
}

function Remove-FileWithRetry {
    param(
        [string]$Path,
        [int]$Attempts = 5
    )

    if (-not (Test-Path $Path)) {
        return
    }

    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        try {
            Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq $Attempts) {
                throw
            }

            Start-Sleep -Milliseconds (250 * $attempt)
        }
    }
}

function Remove-DebugSymbols {
    param(
        [string[]]$Roots
    )

    foreach ($root in $Roots) {
        if (-not (Test-Path -LiteralPath $root)) {
            continue
        }

        Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.pdb -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

if (Test-Path $releaseRoot) {
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

if (Test-Path $nativePublishRoot) {
    Remove-Item -LiteralPath $nativePublishRoot -Recurse -Force
}

if (Test-Path $nativeStandaloneRoot) {
    Remove-Item -LiteralPath $nativeStandaloneRoot -Recurse -Force
}

if (Test-Path $dedicatedNativeRoot) {
    Remove-Item -LiteralPath $dedicatedNativeRoot -Recurse -Force
}

if (Test-Path $backendHotfixRoot) {
    Remove-Item -LiteralPath $backendHotfixRoot -Recurse -Force
}

$topLevelItems = @(
    "src",
    "scripts",
    "dist",
    "docs",
    "node_modules",
    "index.html",
    "lo-tool.cmd",
    "stop-lo-tool.cmd",
    "install-tool_01.cmd",
    "package.json",
    "package-lock.json",
    "tsconfig.app.json",
    "tsconfig.server.json",
    "vite.config.ts"
)

foreach ($item in $topLevelItems) {
    $source = Join-Path $toolRoot $item
    if (-not (Test-Path $source)) {
        continue
    }

    $destination = Join-Path $releaseRoot $item
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

$privatePackageRemovals = @(
    ".env",
    ".git",
    "data\backups",
    "data\edge-debug-profile",
    "data\edge-profile",
    "data\LO_Profiles",
    "LO_Profiles"
)

foreach ($relativePath in $privatePackageRemovals) {
    $targetPath = Join-Path $releaseRoot $relativePath
    if (Test-Path -LiteralPath $targetPath) {
        Remove-Item -LiteralPath $targetPath -Recurse -Force
    }
}

if ($nodeRuntimeSource -and (Test-Path -LiteralPath $nodeRuntimeSource)) {
    $toolsRoot = Join-Path $releaseRoot "tools"
    $nodeToolsRoot = Join-Path $toolsRoot "node"
    New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $nodeToolsRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $nodeRuntimeSource "node.exe") -Destination (Join-Path $nodeToolsRoot "node.exe") -Force
}

$dedicatedOnlyRemovals = @(
    "scripts\start-last-oasis-private.cmd",
    "scripts\start-last-oasis-private.ps1",
    "scripts\prepare-last-oasis-private-client.ps1"
)

foreach ($relativePath in $dedicatedOnlyRemovals) {
    $targetPath = Join-Path $releaseRoot $relativePath
    if (Test-Path $targetPath) {
        Remove-Item -LiteralPath $targetPath -Force
    }
}

$releaseData = Join-Path $releaseRoot "data"
New-Item -ItemType Directory -Path $releaseData -Force | Out-Null

$installerPayloadSource = $installerPayloadSourceCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($installerPayloadSource) {
    Copy-Item -LiteralPath $installerPayloadSource -Destination (Join-Path $releaseRoot "InstallerPayload") -Recurse -Force
}

Set-Content -Path (Join-Path $releaseData "README.txt") -Value @"
This folder is mostly created empty on purpose.

Run install-tool_01.cmd on the target dedicated server to:
- detect Last Oasis game/server paths
- install the local runtime and SteamCMD
- generate a clean lo-tool.config.json
- create desktop shortcuts

The packaged MyRealm inspector helper is included here because the browser-history discovery flow depends on it.
"@ -Encoding UTF8

$inspectorPublishRoot = Join-Path $releaseData "MyRealmInspector"
if (Test-Path $inspectorPublishRoot) {
    Remove-Item -LiteralPath $inspectorPublishRoot -Recurse -Force
}

if (Test-Path $inspectorProjectPath) {
    Write-Host "Publishing MyRealm inspector helper..." -ForegroundColor Cyan
    & $dotnetCommandPath publish $inspectorProjectPath -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -p:DebugSymbols=false -o $inspectorPublishRoot
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet publish failed for MyRealmInspector."
    }
    Remove-DebugSymbols -Roots @($inspectorPublishRoot)
}

New-Item -ItemType Directory -Path $backendHotfixRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $releaseRoot "dist") -Destination (Join-Path $backendHotfixRoot "dist") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $releaseRoot "scripts\start-control-center.ps1") -Destination (Join-Path $backendHotfixRoot "start-control-center.ps1") -Force
Copy-Item -LiteralPath $inspectorPublishRoot -Destination (Join-Path $backendHotfixRoot "MyRealmInspector") -Recurse -Force
Set-Content -Path (Join-Path $backendHotfixRoot "README.txt") -Value @"
Last Oasis Manager Backend Update
Version: $packageVersion

This hotfix bundle updates the control center backend without replacing the whole dedicated install.

Included:
- dist\
- start-control-center.ps1
- MyRealmInspector\

Apply on the dedicated machine:
1. Stop Backend in the native tool, or close the native tool window.
2. Do not press Stop All unless you actually want the tile hosts down too.
3. Copy dist\ into LO_Manager_backend\dist\
4. Copy start-control-center.ps1 into LO_Manager_backend\scripts\start-control-center.ps1
5. Copy MyRealmInspector\ into LO_Manager_backend\data\MyRealmInspector\
6. Start Backend again.
"@ -Encoding UTF8

Set-Content -Path (Join-Path $releaseRoot "INSTALL_NOTES.txt") -Value @"
Last Oasis Manager dedicated package
Version: $packageVersion

What this package includes:
- the Control Center source and scripts
- the packaged MyRealm inspector helper
- the dedicated installer
- the single-file installer wrapper
- no live lo-tool.config.json
- no MyRealm browser-session captures
- no local machine API keys or Discord webhooks

On the target machine:
1. Either run LastOasisManager-Installer.exe, or extract FullPackage.zip anywhere you want.
2. The installer can prompt for MyRealm keys, provider label, and public IP/DNS during setup.
3. The installer will try to detect:
   - Last Oasis dedicated server path
   - Last Oasis game path (if present)
   - Steam path and Steam libraries
   - workshop content path
   - SteamCMD
4. After install, the Control Center is ready for final review and any extra realm/mod settings you want to change.
5. The package includes the native Tool01 desktop app, and desktop shortcuts will point to it when available.

Notes:
- A clean install keeps the mod list empty until you configure it.
- Desktop shortcuts are created automatically.
"@ -Encoding UTF8

if (Test-Path $backendPayloadZipPath) {
    Remove-FileWithRetry -Path $backendPayloadZipPath
}

New-Item -ItemType Directory -Path (Split-Path -Parent $backendPayloadZipPath) -Force | Out-Null
Compress-Archive -Path (Join-Path $releaseRoot "*") -DestinationPath $backendPayloadZipPath -Force

New-Item -ItemType Directory -Path $nativePayloadDirectory -Force | Out-Null
Copy-Item -LiteralPath $backendPayloadZipPath -Destination $nativePayloadPath -Force

Write-Host "Publishing native desktop app for the dedicated package..." -ForegroundColor Cyan
& $dotnetCommandPath publish $nativeProjectPath -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -p:DebugSymbols=false -o $nativePublishRoot
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed for Tool01.Native."
}
Remove-DebugSymbols -Roots @($nativePublishRoot)

$nativePackageRoot = Join-Path $releaseRoot "NativeApp"
Copy-Item -LiteralPath $nativePublishRoot -Destination $nativePackageRoot -Recurse -Force
Copy-Item -LiteralPath $nativePublishRoot -Destination $nativeStandaloneRoot -Recurse -Force
Copy-Item -LiteralPath $nativePublishRoot -Destination $dedicatedNativeRoot -Recurse -Force
$nativeIconSource = Join-Path $toolRoot "native\Tool01.Native\Assets\LastOasisManager.ico"
if (Test-Path -LiteralPath $nativeIconSource) {
    Copy-Item -LiteralPath $nativeIconSource -Destination (Join-Path $nativePackageRoot "LastOasisManager.ico") -Force
    Copy-Item -LiteralPath $nativeIconSource -Destination (Join-Path $nativeStandaloneRoot "LastOasisManager.ico") -Force
    Copy-Item -LiteralPath $nativeIconSource -Destination (Join-Path $dedicatedNativeRoot "LastOasisManager.ico") -Force
}

$dedicatedNativeExePath = Join-Path $dedicatedNativeRoot "Last Oasis Dedicated Server Tool.exe"
$dedicatedPackagedRoot = Join-Path $releaseRoot "DedicatedManager"
$dedicatedPackagedExePath = Join-Path $dedicatedPackagedRoot "Last Oasis Dedicated Server Tool.exe"
Copy-Item -LiteralPath (Join-Path $dedicatedNativeRoot "Tool01.Native.exe") -Destination $dedicatedNativeExePath -Force
Remove-Item -LiteralPath (Join-Path $dedicatedNativeRoot "Tool01.Native.exe") -Force
Copy-Item -LiteralPath $dedicatedNativeRoot -Destination $dedicatedPackagedRoot -Recurse -Force
if (Test-Path (Join-Path $dedicatedPackagedRoot "Tool01.Native.exe")) {
    Remove-Item -LiteralPath (Join-Path $dedicatedPackagedRoot "Tool01.Native.exe") -Force
}
Copy-Item -LiteralPath $dedicatedNativeExePath -Destination $dedicatedPackagedExePath -Force
if (Test-Path -LiteralPath $nativeIconSource) {
    Copy-Item -LiteralPath $nativeIconSource -Destination (Join-Path $dedicatedPackagedRoot "LastOasisManager.ico") -Force
}

Remove-DebugSymbols -Roots @(
    $releaseRoot,
    $nativeStandaloneRoot,
    $dedicatedNativeRoot,
    $dedicatedPackagedRoot,
    $backendHotfixRoot
)

if (Test-Path $zipPath) {
    Remove-FileWithRetry -Path $zipPath
}

Compress-Archive -Path (Join-Path $releaseRoot "*") -DestinationPath $zipPath -Force

if (Test-Path $installerExePath) {
    Remove-FileWithRetry -Path $installerExePath
}

if (Test-Path $nativeStandaloneZipPath) {
    Remove-FileWithRetry -Path $nativeStandaloneZipPath
}

Compress-Archive -Path (Join-Path $nativeStandaloneRoot "*") -DestinationPath $nativeStandaloneZipPath -Force

if (Test-Path $dedicatedNativeZipPath) {
    Remove-FileWithRetry -Path $dedicatedNativeZipPath
}

Compress-Archive -Path (Join-Path $dedicatedNativeRoot "*") -DestinationPath $dedicatedNativeZipPath -Force

if (Test-Path $backendHotfixZipPath) {
    Remove-FileWithRetry -Path $backendHotfixZipPath
}

Compress-Archive -Path (Join-Path $backendHotfixRoot "*") -DestinationPath $backendHotfixZipPath -Force

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build-dedicated-installer.ps1")

Write-Output $releaseRoot
Write-Output $nativeStandaloneRoot
Write-Output $nativeStandaloneZipPath
Write-Output $dedicatedNativeRoot
Write-Output $dedicatedNativeZipPath
Write-Output $backendHotfixRoot
Write-Output $backendHotfixZipPath
Write-Output $zipPath
Write-Output $installerExePath
