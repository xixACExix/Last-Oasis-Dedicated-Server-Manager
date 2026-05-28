$ErrorActionPreference = "Stop"

$toolRoot = Split-Path -Parent $PSScriptRoot
$portableNodeVersion = "22.19.0"
$portableNodeRoot = Join-Path $toolRoot "tools\node"
$portableNpmPath = Join-Path $portableNodeRoot "npm.cmd"
$nonInteractiveInstall = $env:TOOL_01_INSTALL_NONINTERACTIVE -eq "1"
$disableConsoleFallback = $env:TOOL_01_DISABLE_CONSOLE_FALLBACK -eq "1"
$packagedSteamCmdArchive = Join-Path $toolRoot "InstallerPayload\steamcmd.zip"
$installLogsRoot = Join-Path $toolRoot "data\install-logs"

function Get-InstallerSeedValue {
    param(
        [string]$Default = "",
        [string]$EnvironmentVariable = ""
    )

    if ($EnvironmentVariable) {
        $environmentValue = [Environment]::GetEnvironmentVariable($EnvironmentVariable)
        if ($environmentValue) {
            return $environmentValue.Trim()
        }
    }

    return $Default
}

function Prompt-InstallerValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [string]$Default = "",
        [string]$EnvironmentVariable = ""
    )

    $seedValue = Get-InstallerSeedValue -Default $Default -EnvironmentVariable $EnvironmentVariable
    if ($nonInteractiveInstall) {
        return $seedValue
    }

    $displayDefault = if ($seedValue) { " [$seedValue]" } else { " [leave blank]" }
    $value = Read-Host "$Label$displayDefault"
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $seedValue
    }

    return $value.Trim()
}

function Show-InstallerForm {
    param(
        [hashtable]$SeedValues
    )

    $uiScriptPath = Join-Path $PSScriptRoot "install-control-center-ui.ps1"
    if (-not (Test-Path $uiScriptPath)) {
        throw "Installer UI script was not found."
    }

    $serverPathSeed = if ($null -ne $SeedValues.serverPath) { [string]$SeedValues.serverPath } else { "" }
    $steamCmdDirectorySeed = if ($null -ne $SeedValues.steamCmdInstallDirectory) { [string]$SeedValues.steamCmdInstallDirectory } else { "" }
    $profileRootSeed = if ($null -ne $SeedValues.profileRoot) { [string]$SeedValues.profileRoot } else { "" }
    $publicAddressSeed = if ($null -ne $SeedValues.publicAddress) { [string]$SeedValues.publicAddress } else { "" }
    $customerKeySeed = if ($null -ne $SeedValues.customerKey) { [string]$SeedValues.customerKey } else { "" }
    $providerKeySeed = if ($null -ne $SeedValues.providerKey) { [string]$SeedValues.providerKey } else { "" }
    $providerNameSeed = if ($null -ne $SeedValues.providerName) { [string]$SeedValues.providerName } else { "" }
    $apiKeySeed = if ($null -ne $SeedValues.apiKey) { [string]$SeedValues.apiKey } else { "" }

    $uiArguments = New-Object System.Collections.Generic.List[string]
    $uiArguments.Add("-NoProfile") | Out-Null
    $uiArguments.Add("-ExecutionPolicy") | Out-Null
    $uiArguments.Add("Bypass") | Out-Null
    $uiArguments.Add("-STA") | Out-Null
    $uiArguments.Add("-File") | Out-Null
    $uiArguments.Add($uiScriptPath) | Out-Null

    function Add-UiSeedArgument {
        param(
            [System.Collections.Generic.List[string]]$ArgumentList,
            [string]$Name,
            [string]$Value,
            [switch]$AllowEmpty
        )

        if (-not $AllowEmpty -and [string]::IsNullOrWhiteSpace($Value)) {
            return
        }

        $ArgumentList.Add($Name) | Out-Null
        $safeValue = if ($null -eq $Value) { "" } else { $Value }
        $ArgumentList.Add($safeValue) | Out-Null
    }

    Add-UiSeedArgument -ArgumentList $uiArguments -Name "-ServerPath" -Value $serverPathSeed -AllowEmpty
    Add-UiSeedArgument -ArgumentList $uiArguments -Name "-SteamCmdInstallDirectory" -Value $steamCmdDirectorySeed -AllowEmpty
    Add-UiSeedArgument -ArgumentList $uiArguments -Name "-ProfileRoot" -Value $profileRootSeed -AllowEmpty
    Add-UiSeedArgument -ArgumentList $uiArguments -Name "-PublicAddress" -Value $publicAddressSeed
    Add-UiSeedArgument -ArgumentList $uiArguments -Name "-CustomerKey" -Value $customerKeySeed
    Add-UiSeedArgument -ArgumentList $uiArguments -Name "-ProviderKey" -Value $providerKeySeed
    Add-UiSeedArgument -ArgumentList $uiArguments -Name "-ProviderName" -Value $providerNameSeed
    Add-UiSeedArgument -ArgumentList $uiArguments -Name "-ApiKey" -Value $apiKeySeed

    $uiOutput = & powershell.exe @uiArguments
    if ($LASTEXITCODE -ne 0 -or -not $uiOutput) {
        throw "Installer cancelled."
    }

    return $uiOutput | ConvertFrom-Json -AsHashtable
}

function Read-JsonHashtable {
    param(
        [string]$Path
    )

    if (-not $Path -or -not (Test-Path $Path)) {
        return @{}
    }

    try {
        $raw = Get-Content -LiteralPath $Path -Raw
        if ([string]::IsNullOrWhiteSpace($raw)) {
            return @{}
        }

        return ($raw | ConvertFrom-Json -AsHashtable)
    } catch {
        return @{}
    }
}

function Resolve-ExistingPath {
    param(
        [string[]]$Candidates
    )

    foreach ($candidate in $Candidates) {
        if (-not $candidate) {
            continue
        }

        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    return ""
}

function Get-RegistrySteamRoot {
    $registryPaths = @(
        "HKCU:\Software\Valve\Steam",
        "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam",
        "HKLM:\SOFTWARE\Valve\Steam"
    )

    foreach ($registryPath in $registryPaths) {
        try {
            $item = Get-ItemProperty -Path $registryPath -ErrorAction Stop
            foreach ($property in @("SteamPath", "InstallPath")) {
                $value = $item.$property
                if (-not $value) {
                    continue
                }

                if (Test-Path $value) {
                    return (Resolve-Path $value).Path
                }
            }
        } catch {
            continue
        }
    }

    return ""
}

function Get-DefaultProfileRoot {
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    if ($desktopPath) {
        return (Join-Path $desktopPath "LO_Profiles")
    }

    if ($env:ProgramData) {
        return (Join-Path $env:ProgramData "LO_Profiles")
    }

    return (Join-Path $env:SystemDrive "LO_Profiles")
}

function Get-LinkedProfileRoot {
    $linkPath = Join-Path $toolRoot "data\profile-link.json"
    $link = Read-JsonHashtable -Path $linkPath
    if ($link.ContainsKey("profileRoot") -and $link.profileRoot) {
        $resolvedProfileRoot = [System.IO.Path]::GetFullPath([string]$link.profileRoot)
        if (Test-Path $resolvedProfileRoot) {
            return $resolvedProfileRoot
        }
    }

    return ""
}

function Get-ExistingInstallContext {
    param(
        [string]$ProfileRoot = ""
    )

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($ProfileRoot) {
        $null = $candidates.Add((Join-Path $ProfileRoot "install-context.json"))
    }

    $linkedProfileRoot = Get-LinkedProfileRoot
    if ($linkedProfileRoot) {
        $null = $candidates.Add((Join-Path $linkedProfileRoot "install-context.json"))
    }

    $null = $candidates.Add((Join-Path $toolRoot "data\install-context.json"))

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path $candidate)) {
            continue
        }

        $context = Read-JsonHashtable -Path $candidate
        if ($context.Count -gt 0) {
            return $context
        }
    }

    return @{}
}

function Get-SteamLibraryRoots {
    param(
        [string]$SteamExePath
    )

    $candidateRoots = @(
        if ($SteamExePath) { Split-Path -Parent $SteamExePath }
        Get-RegistrySteamRoot
        "C:\Program Files (x86)\Steam"
        "C:\Program Files\Steam"
        "C:\SteamLibrary"
    ) | Where-Object { $_ }

    $roots = New-Object System.Collections.Generic.List[string]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($candidateRoot in $candidateRoots) {
        if (-not (Test-Path $candidateRoot)) {
            continue
        }

        $resolvedRoot = (Resolve-Path $candidateRoot).Path
        if ($seen.Add($resolvedRoot)) {
            $null = $roots.Add($resolvedRoot)
        }

        $libraryFoldersPath = Join-Path $resolvedRoot "steamapps\libraryfolders.vdf"
        if (-not (Test-Path $libraryFoldersPath)) {
            continue
        }

        $rawLibraryFolders = Get-Content $libraryFoldersPath -Raw
        foreach ($match in [regex]::Matches($rawLibraryFolders, '"path"\s+"([^"]+)"')) {
            $libraryRoot = $match.Groups[1].Value -replace '\\\\', '\'
            if (-not $libraryRoot -or -not (Test-Path $libraryRoot)) {
                continue
            }

            $resolvedLibraryRoot = (Resolve-Path $libraryRoot).Path
            if ($seen.Add($resolvedLibraryRoot)) {
                $null = $roots.Add($resolvedLibraryRoot)
            }
        }
    }

    return $roots.ToArray()
}

function Resolve-SteamCommonInstall {
    param(
        [string[]]$LibraryRoots,
        [string[]]$Names
    )

    foreach ($libraryRoot in $LibraryRoots) {
        foreach ($name in $Names) {
            if (-not $name) {
                continue
            }

            $candidate = Join-Path $libraryRoot "steamapps\common\$name"
            if (Test-Path $candidate) {
                return (Resolve-Path $candidate).Path
            }
        }
    }

    return ""
}

function Resolve-WorkshopContentPath {
    param(
        [string]$ServerPath,
        [string[]]$LibraryRoots
    )

    $candidates = @()
    if ($ServerPath) {
        $serverLibraryRoot = Split-Path (Split-Path $ServerPath -Parent) -Parent
        if ($serverLibraryRoot) {
            $candidates += (Join-Path $serverLibraryRoot "workshop\content\903950")
        }
    }

    foreach ($libraryRoot in $LibraryRoots) {
        $candidates += (Join-Path $libraryRoot "workshop\content\903950")
    }

    foreach ($candidate in $candidates | Where-Object { $_ }) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    return ($candidates | Select-Object -First 1)
}

function Install-PortableNode {
    param(
        [string]$DestinationRoot,
        [string]$Version
    )

    $nodeZipUrl = "https://nodejs.org/dist/v$Version/node-v$Version-win-x64.zip"
    $toolsRoot = Split-Path -Parent $DestinationRoot
    $tempZip = Join-Path $toolsRoot "node-portable.zip"
    $extractRoot = Join-Path $toolsRoot "node-extract"

    New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
    if (Test-Path $DestinationRoot) {
        Remove-Item -LiteralPath $DestinationRoot -Recurse -Force
    }
    if (Test-Path $extractRoot) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }

    Write-Host "Downloading portable Node.js $Version..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $nodeZipUrl -OutFile $tempZip
    Expand-Archive -LiteralPath $tempZip -DestinationPath $extractRoot -Force

    $extractedNodeRoot = Get-ChildItem -Path $extractRoot -Directory | Select-Object -First 1
    if (-not $extractedNodeRoot) {
        throw "Portable Node.js archive extracted, but no runtime folder was found."
    }

    Move-Item -LiteralPath $extractedNodeRoot.FullName -Destination $DestinationRoot
    Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue

    $npmPath = Join-Path $DestinationRoot "npm.cmd"
    if (-not (Test-Path $npmPath)) {
        throw "Portable Node.js was downloaded, but npm.cmd was not found."
    }

    return $npmPath
}

function Get-DefaultDedicatedServerPath {
    param(
        [string[]]$LibraryRoots
    )

    $systemDrive = if ([string]::IsNullOrWhiteSpace($env:SystemDrive)) { "C:" } else { $env:SystemDrive }
    return (Join-Path $systemDrive "LastOasisServer")
}

function Resolve-AbsoluteFolderPath {
    param(
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }

    $trimmedPath = $Path.Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($trimmedPath)) {
        return ""
    }

    if ($trimmedPath -match '^[A-Za-z]:$') {
        $trimmedPath += '\'
    }

    $systemDrive = if ([string]::IsNullOrWhiteSpace($env:SystemDrive)) { 'C:' } else { $env:SystemDrive }

    if ($trimmedPath.StartsWith('\')) {
        $trimmedPath = Join-Path ($systemDrive + '\') $trimmedPath.TrimStart('\')
    }
    elseif (-not [System.IO.Path]::IsPathRooted($trimmedPath)) {
        $trimmedPath = Join-Path ($systemDrive + '\') $trimmedPath
    }

    try {
        return [System.IO.Path]::GetFullPath($trimmedPath)
    }
    catch {
        return $trimmedPath
    }
}

function Resolve-NpmRuntime {
    $portableNodeExe = Join-Path $portableNodeRoot "node.exe"
    if ((Test-Path $portableNpmPath) -and (Test-Path $portableNodeExe)) {
        return @{
            npmPath = $portableNpmPath
            nodeRoot = $portableNodeRoot
        }
    }

    $resolvedNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $resolvedNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($resolvedNpm -and $resolvedNode) {
        return @{
            npmPath = $resolvedNpm.Source
            nodeRoot = (Split-Path -Parent $resolvedNode.Source)
        }
    }

    $installedNpm = Install-PortableNode -DestinationRoot $portableNodeRoot -Version $portableNodeVersion
    return @{
        npmPath = $installedNpm
        nodeRoot = $portableNodeRoot
    }
}

function Test-PackagedNodeDependencies {
    $tsxCli = Join-Path $toolRoot "node_modules\tsx\dist\cli.mjs"
    return (Test-Path -LiteralPath $tsxCli)
}

function Test-PackagedBuildArtifacts {
    $clientIndex = Join-Path $toolRoot "dist\client\index.html"
    $serverEntry = Join-Path $toolRoot "dist\server\index.js"
    return (Test-Path -LiteralPath $clientIndex) -and (Test-Path -LiteralPath $serverEntry)
}

function Ensure-SteamCmd {
    param(
        [string]$InstallDirectory,
        [switch]$ForceReinstall
    )

    $resolvedInstallDirectory = Resolve-AbsoluteFolderPath -Path $InstallDirectory
    if ([string]::IsNullOrWhiteSpace($resolvedInstallDirectory)) {
        throw "SteamCMD install folder was not provided."
    }

    $steamCmdExe = Join-Path $resolvedInstallDirectory "steamcmd.exe"
    if ($ForceReinstall -and (Test-Path $resolvedInstallDirectory)) {
        Remove-Item -LiteralPath $resolvedInstallDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ((Test-Path $steamCmdExe) -and -not $ForceReinstall) {
        return $steamCmdExe
    }

    $steamCmdZipUrl = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip"
    $tempZip = Join-Path ([System.IO.Path]::GetTempPath()) ('steamcmd-' + [guid]::NewGuid().ToString('N') + '.zip')

    New-Item -ItemType Directory -Path $resolvedInstallDirectory -Force | Out-Null
    if (Test-Path -LiteralPath $packagedSteamCmdArchive) {
        Write-Host "Using bundled SteamCMD archive..." -ForegroundColor Cyan
        Expand-Archive -LiteralPath $packagedSteamCmdArchive -DestinationPath $resolvedInstallDirectory -Force
    }
    else {
        Write-Host "Downloading SteamCMD..." -ForegroundColor Cyan
        try {
            Invoke-WebRequest -Uri $steamCmdZipUrl -OutFile $tempZip -UseBasicParsing
            Expand-Archive -LiteralPath $tempZip -DestinationPath $resolvedInstallDirectory -Force
        }
        finally {
            Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
        }
    }

    if (-not (Test-Path $steamCmdExe)) {
        throw "SteamCMD archive extracted, but steamcmd.exe was not found."
    }

    $bootstrapExitCode = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Push-Location (Split-Path -Parent $steamCmdExe)
        try {
            & $steamCmdExe +quit | Out-Null
            $bootstrapExitCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }

        if ($bootstrapExitCode -eq 0) {
            break
        }

        if ($bootstrapExitCode -eq 7 -and $attempt -lt 3) {
            Write-Host "SteamCMD updated itself on first run. Retrying bootstrap..." -ForegroundColor DarkYellow
            Start-Sleep -Seconds 3
            continue
        }

        throw "SteamCMD bootstrap failed with exit code $bootstrapExitCode."
    }

    return $steamCmdExe
}

function Ensure-DedicatedServerInstall {
    param(
        [string]$ServerPath,
        [string]$SteamCmdPath
    )

    $resolvedServerPath = Resolve-AbsoluteFolderPath -Path $ServerPath
    if ([string]::IsNullOrWhiteSpace($resolvedServerPath)) {
        throw "Dedicated server path was not provided."
    }

    $serverExecutable = Join-Path $resolvedServerPath "Mist\Binaries\Win64\MistServer-Win64-Shipping.exe"
    if (Test-Path $serverExecutable) {
        return $serverExecutable
    }

    New-Item -ItemType Directory -Path $resolvedServerPath -Force | Out-Null
    New-Item -ItemType Directory -Path $installLogsRoot -Force | Out-Null
    $installLogPath = Join-Path $installLogsRoot ("steamcmd-server-install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $steamCmdRoot = Split-Path -Parent $SteamCmdPath
    $missingConfigurationDetected = $false

    for ($attempt = 1; $attempt -le 2; $attempt++) {
        if ($attempt -eq 1) {
            Write-Host "Installing Last Oasis dedicated server (920720)..." -ForegroundColor Cyan
        }
        else {
            Write-Host "SteamCMD reported missing configuration. Rebuilding SteamCMD and retrying install..." -ForegroundColor DarkYellow
            $SteamCmdPath = Ensure-SteamCmd -InstallDirectory $steamCmdRoot -ForceReinstall
        }

        $installArgs = @(
            "+force_install_dir", $resolvedServerPath,
            "+login", "anonymous",
            "+app_update", "920720", "validate",
            "+quit"
        )

        Push-Location $steamCmdRoot
        try {
            $installOutput = @(& $SteamCmdPath @installArgs 2>&1 | Tee-Object -FilePath $installLogPath -Append)
        }
        finally {
            Pop-Location
        }

        $missingConfigurationDetected = (($installOutput | Out-String) -match 'Missing configuration')
        if (-not $missingConfigurationDetected -and $LASTEXITCODE -eq 0 -and (Test-Path $serverExecutable)) {
            return $serverExecutable
        }

        if ($missingConfigurationDetected -and $attempt -lt 2) {
            continue
        }

        if ($LASTEXITCODE -ne 0) {
            throw "SteamCMD server install failed with exit code $LASTEXITCODE. See log: $installLogPath"
        }
    }

    if ($missingConfigurationDetected) {
        throw "SteamCMD reported 'Missing configuration' while installing AppID 920720. See log: $installLogPath"
    }

    if (-not (Test-Path $serverExecutable)) {
        throw "Dedicated server install completed, but MistServer-Win64-Shipping.exe was not found."
    }

    return $serverExecutable
}

$existingInstallContext = Get-ExistingInstallContext
$steamExePath = Resolve-ExistingPath @(
    $env:LAST_OASIS_STEAM_PATH
    if ($existingInstallContext.steamExePath) { [string]$existingInstallContext.steamExePath }
    if (Get-RegistrySteamRoot) { Join-Path (Get-RegistrySteamRoot) "steam.exe" }
    "C:\Program Files (x86)\Steam\steam.exe"
    "C:\Program Files\Steam\steam.exe"
)
$defaultProfileRoot = if ($existingInstallContext.profileRoot) {
    [string]$existingInstallContext.profileRoot
} else {
    Get-DefaultProfileRoot
}
$profileRoot = Get-InstallerSeedValue -Default $defaultProfileRoot -EnvironmentVariable "TOOL_01_PROFILE_ROOT"

$steamLibraryRoots = Get-SteamLibraryRoots -SteamExePath $steamExePath
$detectedServerPath = Resolve-SteamCommonInstall -LibraryRoots $steamLibraryRoots -Names @(
    "Last Oasis - Dedicated Server",
    "LastOasis-DedicatedServer"
)

$serverPath = Resolve-ExistingPath @(
    $env:LAST_OASIS_SERVER_PATH
    if ($existingInstallContext.serverPath) { [string]$existingInstallContext.serverPath }
    $detectedServerPath
    "C:\SteamLibrary\steamapps\common\Last Oasis - Dedicated Server"
    "C:\SteamLibrary\steamapps\common\LastOasis-DedicatedServer"
    "C:\Program Files (x86)\Steam\steamapps\common\Last Oasis - Dedicated Server"
    "C:\Program Files (x86)\Steam\steamapps\common\LastOasis-DedicatedServer"
)

if (-not $serverPath) {
    $serverPath = Get-DefaultDedicatedServerPath -LibraryRoots $steamLibraryRoots
}

$detectedGamePath = Resolve-SteamCommonInstall -LibraryRoots $steamLibraryRoots -Names @(
    "Last Oasis"
)

$gamePath = Resolve-ExistingPath @(
    $env:LAST_OASIS_GAME_PATH
    if ($existingInstallContext.gamePath) { [string]$existingInstallContext.gamePath }
    $detectedGamePath
    "C:\SteamLibrary\steamapps\common\Last Oasis"
    "C:\Program Files (x86)\Steam\steamapps\common\Last Oasis"
)

$steamServicePath = Resolve-ExistingPath @(
    $env:LAST_OASIS_STEAM_SERVICE_PATH
    if ($existingInstallContext.steamServicePath) { [string]$existingInstallContext.steamServicePath }
    if ($steamExePath) { Join-Path (Split-Path -Parent $steamExePath) "SteamService.exe" }
    "C:\Program Files (x86)\Steam\SteamService.exe"
    "C:\Program Files\Steam\SteamService.exe"
)

$defaultSystemDrive = if ([string]::IsNullOrWhiteSpace($env:SystemDrive)) { "C:" } else { $env:SystemDrive }
$defaultSteamCmdInstallDirectory = Join-Path $defaultSystemDrive "SteamCMD"

$steamCmdInstallDirectory = Resolve-ExistingPath @(
    $env:TOOL_01_STEAMCMD_DIR
    if ($existingInstallContext.steamCmdInstallDirectory) { [string]$existingInstallContext.steamCmdInstallDirectory }
    $defaultSteamCmdInstallDirectory
)

if (-not $steamCmdInstallDirectory) {
    $steamCmdInstallDirectory = $defaultSteamCmdInstallDirectory
}

$seedValues = @{
    serverPath = Resolve-AbsoluteFolderPath -Path (Get-InstallerSeedValue -Default $serverPath -EnvironmentVariable "LAST_OASIS_SERVER_PATH")
    steamCmdInstallDirectory = Resolve-AbsoluteFolderPath -Path (Get-InstallerSeedValue -Default $steamCmdInstallDirectory -EnvironmentVariable "TOOL_01_STEAMCMD_DIR")
    profileRoot = Resolve-AbsoluteFolderPath -Path (Get-InstallerSeedValue -Default $profileRoot -EnvironmentVariable "TOOL_01_PROFILE_ROOT")
    publicAddress = Get-InstallerSeedValue -Default "" -EnvironmentVariable "TOOL_01_PUBLIC_ADDRESS"
    customerKey = Get-InstallerSeedValue -Default "" -EnvironmentVariable "TOOL_01_CUSTOMER_KEY"
    providerKey = Get-InstallerSeedValue -Default "" -EnvironmentVariable "TOOL_01_PROVIDER_KEY"
    providerName = Get-InstallerSeedValue -Default "" -EnvironmentVariable "TOOL_01_PROVIDER_NAME"
    apiKey = Get-InstallerSeedValue -Default "" -EnvironmentVariable "TOOL_01_API_KEY"
}

if ($nonInteractiveInstall) {
    $serverPath = $seedValues.serverPath
    $steamCmdInstallDirectory = $seedValues.steamCmdInstallDirectory
    $profileRoot = $seedValues.profileRoot
    $publicAddress = $seedValues.publicAddress
    $customerKey = $seedValues.customerKey
    $providerKey = $seedValues.providerKey
    $providerName = $seedValues.providerName
    $apiKey = $seedValues.apiKey
} else {
    try {
        $installerValues = Show-InstallerForm -SeedValues $seedValues
        $serverPath = if ($null -ne $installerValues.serverPath) { [string]$installerValues.serverPath } else { "" }
        $steamCmdInstallDirectory = if ($null -ne $installerValues.steamCmdInstallDirectory) { [string]$installerValues.steamCmdInstallDirectory } else { "" }
        $profileRoot = if ($null -ne $installerValues.profileRoot) { [string]$installerValues.profileRoot } else { "" }
        $publicAddress = if ($null -ne $installerValues.publicAddress) { [string]$installerValues.publicAddress } else { "" }
        $customerKey = if ($null -ne $installerValues.customerKey) { [string]$installerValues.customerKey } else { "" }
        $providerKey = if ($null -ne $installerValues.providerKey) { [string]$installerValues.providerKey } else { "" }
        $providerName = if ($null -ne $installerValues.providerName) { [string]$installerValues.providerName } else { "" }
        $apiKey = if ($null -ne $installerValues.apiKey) { [string]$installerValues.apiKey } else { "" }
    } catch {
        if ($disableConsoleFallback) {
            throw
        }

        if ($_.Exception.Message -eq "Installer cancelled.") {
            Write-Warning "Installer window was closed before values were submitted. Falling back to console prompts."
        } else {
            Write-Warning "Installer form was not available. Falling back to console prompts."
        }
        $serverPath = Prompt-InstallerValue -Label "Dedicated server path" -Default $seedValues.serverPath
        $steamCmdInstallDirectory = Prompt-InstallerValue -Label "SteamCMD install folder" -Default $seedValues.steamCmdInstallDirectory
        $profileRoot = Prompt-InstallerValue -Label "Profile/settings folder" -Default $seedValues.profileRoot
        $publicAddress = Prompt-InstallerValue -Label "Public IP or DNS for realm host advertising" -Default $seedValues.publicAddress
        $customerKey = Prompt-InstallerValue -Label "MyRealm customer key" -Default $seedValues.customerKey
        $providerKey = Prompt-InstallerValue -Label "MyRealm provider key" -Default $seedValues.providerKey
        $providerName = Prompt-InstallerValue -Label "Provider label/name" -Default $seedValues.providerName
        $apiKey = Prompt-InstallerValue -Label "MyRealm API key" -Default $seedValues.apiKey
    }
}

if (-not $steamCmdInstallDirectory -and $serverPath) {
    $steamCmdInstallDirectory = Join-Path $serverPath "tools\steamcmd"
}

$serverPath = Resolve-AbsoluteFolderPath -Path $serverPath
$steamCmdInstallDirectory = Resolve-AbsoluteFolderPath -Path $steamCmdInstallDirectory
$profileRoot = Resolve-AbsoluteFolderPath -Path $profileRoot

if (-not $gamePath) {
    $gamePath = Resolve-ExistingPath @(
        $env:LAST_OASIS_GAME_PATH
        if ($existingInstallContext.gamePath) { [string]$existingInstallContext.gamePath }
        (Resolve-SteamCommonInstall -LibraryRoots $steamLibraryRoots -Names @("Last Oasis"))
    )
}

if (-not $steamExePath) {
    $steamExePath = Resolve-ExistingPath @(
        $env:LAST_OASIS_STEAM_PATH
        if ($existingInstallContext.steamExePath) { [string]$existingInstallContext.steamExePath }
        if (Get-RegistrySteamRoot) { Join-Path (Get-RegistrySteamRoot) "steam.exe" }
        "C:\Program Files (x86)\Steam\steam.exe"
        "C:\Program Files\Steam\steam.exe"
    )
}

if (-not $steamServicePath) {
    $steamServicePath = Resolve-ExistingPath @(
        $env:LAST_OASIS_STEAM_SERVICE_PATH
        if ($existingInstallContext.steamServicePath) { [string]$existingInstallContext.steamServicePath }
        if ($steamExePath) { Join-Path (Split-Path -Parent $steamExePath) "SteamService.exe" }
        "C:\Program Files (x86)\Steam\SteamService.exe"
        "C:\Program Files\Steam\SteamService.exe"
    )
}

if (-not $workshopContentPath -and $steamCmdInstallDirectory) {
    $workshopContentPath = Join-Path $steamCmdInstallDirectory "steamapps\workshop\content\903950"
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "        LAST OASIS CONTROL CENTER DEDICATED INSTALL" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "Server path : $serverPath" -ForegroundColor Gray
Write-Host "SteamCMD    : $steamCmdInstallDirectory" -ForegroundColor Gray
Write-Host "Profile dir : $profileRoot" -ForegroundColor Gray
Write-Host "Workshop    : $workshopContentPath" -ForegroundColor DarkGray
Write-Host ""

$npmRuntime = Resolve-NpmRuntime
$npmCommand = $npmRuntime.npmPath
$runtimeNodeRoot = if ($npmRuntime.nodeRoot) { [string]$npmRuntime.nodeRoot } else { "" }
$nodeRootForContext = if ($runtimeNodeRoot -and (Test-Path $portableNodeRoot) -and ((Resolve-Path $runtimeNodeRoot).Path -eq (Resolve-Path $portableNodeRoot).Path)) {
    $portableNodeRoot
} else {
    ""
}
Write-Host "Using npm runtime: $npmCommand" -ForegroundColor Gray

Push-Location $toolRoot
$originalPath = $env:PATH
try {
    if ($runtimeNodeRoot -and (Test-Path $runtimeNodeRoot)) {
        $env:PATH = "$runtimeNodeRoot;$env:PATH"
    }

    if (Test-PackagedNodeDependencies) {
        Write-Host "Using packaged Node dependencies." -ForegroundColor Gray
    }
    else {
        & $npmCommand install --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed."
        }
    }

    $steamCmdPath = Ensure-SteamCmd -InstallDirectory $steamCmdInstallDirectory
    $null = Ensure-DedicatedServerInstall -ServerPath $serverPath -SteamCmdPath $steamCmdPath

    $bootstrapArgs = @(
        "run",
        "bootstrap:install",
        "--",
        "--server-path", $serverPath,
        "--steamcmd-dir", $steamCmdInstallDirectory,
        "--steamcmd-path", $steamCmdPath
    )

    if ($nodeRootForContext) {
        $bootstrapArgs += @("--node-root", $nodeRootForContext)
    }

    if ($gamePath) {
        $bootstrapArgs += @("--game-path", $gamePath)
    }

    if ($steamExePath) {
        $bootstrapArgs += @("--steam-exe", $steamExePath)
    }

    if ($steamServicePath) {
        $bootstrapArgs += @("--steam-service", $steamServicePath)
    }

    if ($workshopContentPath) {
        $bootstrapArgs += @("--workshop-path", $workshopContentPath)
    }

    if ($customerKey) {
        $bootstrapArgs += @("--customer-key", $customerKey)
    }

    if ($providerKey) {
        $bootstrapArgs += @("--provider-key", $providerKey)
    }

    if ($providerName) {
        $bootstrapArgs += @("--provider-name", $providerName)
    }

    if ($apiKey) {
        $bootstrapArgs += @("--api-key", $apiKey)
    }

    if ($publicAddress) {
        $bootstrapArgs += @("--public-address", $publicAddress)
    }

    if ($profileRoot) {
        $bootstrapArgs += @("--profile-root", $profileRoot)
    }

    & $npmCommand @bootstrapArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Dedicated-server bootstrap failed."
    }

    if (Test-PackagedBuildArtifacts) {
        Write-Host "Using packaged client and server build artifacts." -ForegroundColor Gray
    }
    else {
        & $npmCommand run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed."
        }
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install-desktop-shortcut.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop shortcut installation failed."
    }

    if ($env:TOOL_01_SKIP_BACKEND_AUTOSTART -eq "1") {
        Write-Host "Skipping backend autostart task because TOOL_01_SKIP_BACKEND_AUTOSTART=1." -ForegroundColor Yellow
    }
    else {
        try {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install-backend-autostart.ps1")
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Backend autostart task installer exited with code $LASTEXITCODE."
            }
        } catch {
            Write-Warning "Backend autostart task could not be installed: $($_.Exception.Message)"
        }
    }
} finally {
    $env:PATH = $originalPath
    Pop-Location
}

Write-Host ""
Write-Host "Dedicated-server install completed." -ForegroundColor Green
Write-Host "Use install-tool_01.cmd on the target machine to rebuild or repair this install later." -ForegroundColor Green
