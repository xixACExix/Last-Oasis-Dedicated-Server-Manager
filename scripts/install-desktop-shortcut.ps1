$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath("Desktop")
$cmdPath = Join-Path $env:SystemRoot "System32\cmd.exe"
$installContextPath = Join-Path $root "data\install-context.json"
$installContext = $null

if (Test-Path $installContextPath) {
    try {
        $installContext = Get-Content $installContextPath -Raw | ConvertFrom-Json
    } catch {
        $installContext = $null
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

function New-DesktopShortcut {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$TargetPath,
        [AllowEmptyString()]
        [string]$Arguments = "",
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [Parameter(Mandatory = $true)]
        [string]$IconLocation
    )

    $shell = New-Object -ComObject WScript.Shell
    if (Test-Path $Path) {
        Remove-Item -LiteralPath $Path -Force
    }

    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $TargetPath
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = $Description
    $shortcut.IconLocation = $IconLocation
    $shortcut.WindowStyle = 1
    $shortcut.Save()
}

$nativeExePath = Resolve-ExistingPath @(
    (Join-Path $root "release\DedicatedManager\Last Oasis Dedicated Server Tool.exe")
    (Join-Path $root "DedicatedManager\Last Oasis Dedicated Server Tool.exe")
    (Join-Path (Split-Path -Parent $root) "DedicatedManager\Last Oasis Dedicated Server Tool.exe")
    (Join-Path $root "release\NativeApp\Tool01.Native.exe")
    (Join-Path $root "NativeApp\Tool01.Native.exe")
    (Join-Path (Split-Path -Parent $root) "Last Oasis Dedicated Server Tool.exe")
    (Join-Path $root "release\Tool01.Native\Tool01.Native.exe")
    (Join-Path $root "Tool01.Native\Tool01.Native.exe")
    (Join-Path (Split-Path -Parent $root) "Tool01.Native.exe")
    (Join-Path (Split-Path -Parent $root) "Tool01.Native\Tool01.Native.exe")
)

$gameExe = Resolve-ExistingPath @(
    if ($installContext) { Join-Path $installContext.gamePath "Mist\Binaries\Win64\MistClient-Win64-Shipping.exe" }
    "C:\SteamLibrary\steamapps\common\Last Oasis\Mist\Binaries\Win64\MistClient-Win64-Shipping.exe"
    "C:\SteamLibrary\steamapps\common\Last Oasis\OasisLauncher.exe"
    "C:\SteamLibrary\steamapps\common\Last Oasis\MistClient.exe"
)

$serverExe = Resolve-ExistingPath @(
    if ($installContext) { Join-Path $installContext.serverPath "Mist\Binaries\Win64\MistServer-Win64-Shipping.exe" }
    "C:\SteamLibrary\steamapps\common\Last Oasis - Dedicated Server\Mist\Binaries\Win64\MistServer-Win64-Shipping.exe"
    "C:\SteamLibrary\steamapps\common\LastOasis-DedicatedServer\Mist\Binaries\Win64\MistServer-Win64-Shipping.exe"
)

$iconPath = Resolve-ExistingPath @(
    $nativeExePath
    (Join-Path $root "LastOasisManager.ico")
    (Join-Path $root "DedicatedManager\LastOasisManager.ico")
    (Join-Path $root "release\DedicatedManager\LastOasisManager.ico")
    (Join-Path $root "native\Tool01.Native\Assets\LastOasisManager.ico")
    $serverExe
    $gameExe
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    "C:\Windows\System32\imageres.dll"
)

if (-not $iconPath) {
    $iconPath = "C:\Windows\System32\shell32.dll"
}

New-DesktopShortcut `
    -Path (Join-Path $desktop "Last Oasis Control Center.lnk") `
    -TargetPath ($(if ($nativeExePath) { $nativeExePath } else { $cmdPath })) `
    -Arguments ($(if ($nativeExePath) { "" } else { "/k `"$root\lo-tool.cmd`"" })) `
    -WorkingDirectory ($(if ($nativeExePath) { Split-Path -Parent $nativeExePath } else { $root })) `
    -Description ($(if ($nativeExePath) { "Launch the native Last Oasis Control Center" } else { "Launch the Last Oasis Control Center" })) `
    -IconLocation "$($(if ($nativeExePath) { $nativeExePath } else { $iconPath })),0"

New-DesktopShortcut `
    -Path (Join-Path $desktop "Stop Last Oasis Control Center.lnk") `
    -TargetPath $cmdPath `
    -Arguments "/k `"$root\stop-lo-tool.cmd`"" `
    -WorkingDirectory $root `
    -Description "Stop the Last Oasis Control Center backend" `
    -IconLocation "C:\Windows\System32\shell32.dll,27"

Write-Output (Join-Path $desktop "Last Oasis Control Center.lnk")
Write-Output (Join-Path $desktop "Stop Last Oasis Control Center.lnk")
