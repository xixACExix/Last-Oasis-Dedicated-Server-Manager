param(
    [string]$ServerPath = "",
    [string]$GamePath = "",
    [string]$SteamExePath = "",
    [string]$SteamServicePath = "",
    [string]$WorkshopContentPath = "",
    [string]$SteamCmdInstallDirectory = "",
    [string]$ProfileRoot = "",
    [string]$PublicAddress = "",
    [string]$CustomerKey = "",
    [string]$ProviderKey = "",
    [string]$ProviderName = "",
    [string]$ApiKey = "",
    [switch]$RunInstall
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$script:InstallerLogBox = $null
$script:InstallerStatusLabel = $null

function Append-InstallerLog {
    param(
        [string]$Message
    )

    if (-not $script:InstallerLogBox) {
        return
    }

    $line = if ([string]::IsNullOrWhiteSpace($Message)) {
        ""
    }
    else {
        "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message
    }

    $script:InstallerLogBox.AppendText($line + [Environment]::NewLine)
    $script:InstallerLogBox.SelectionStart = $script:InstallerLogBox.TextLength
    $script:InstallerLogBox.ScrollToCaret()
    [System.Windows.Forms.Application]::DoEvents()
}

function Drain-InstallQueue {
    param(
        [System.Collections.Queue]$Queue
    )

    while ($true) {
        $nextLine = $null
        [System.Threading.Monitor]::Enter($Queue)
        try {
            if ($Queue.Count -gt 0) {
                $nextLine = [string]$Queue.Dequeue()
            }
        }
        finally {
            [System.Threading.Monitor]::Exit($Queue)
        }

        if ($null -eq $nextLine) {
            break
        }

        Append-InstallerLog -Message $nextLine
    }
}

function Invoke-InstallerRun {
    param(
        [hashtable]$Values
    )

    $installScriptPath = Join-Path $PSScriptRoot "install-control-center.ps1"
    if (-not (Test-Path -LiteralPath $installScriptPath)) {
        throw "The main installer script was not found."
    }

    $toolRoot = Split-Path -Parent $PSScriptRoot
    $logQueue = New-Object System.Collections.Queue
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $process.StartInfo.FileName = "powershell.exe"
    $process.StartInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$installScriptPath`""
    $process.StartInfo.WorkingDirectory = $toolRoot
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.EnvironmentVariables["TOOL_01_INSTALL_NONINTERACTIVE"] = "1"
    $process.StartInfo.EnvironmentVariables["TOOL_01_DISABLE_CONSOLE_FALLBACK"] = "1"
    $process.StartInfo.EnvironmentVariables["LAST_OASIS_SERVER_PATH"] = $Values.serverPath
    $process.StartInfo.EnvironmentVariables["TOOL_01_STEAMCMD_DIR"] = $Values.steamCmdInstallDirectory
    $process.StartInfo.EnvironmentVariables["TOOL_01_PROFILE_ROOT"] = $Values.profileRoot
    $process.StartInfo.EnvironmentVariables["TOOL_01_PUBLIC_ADDRESS"] = $Values.publicAddress
    $process.StartInfo.EnvironmentVariables["TOOL_01_CUSTOMER_KEY"] = $Values.customerKey
    $process.StartInfo.EnvironmentVariables["TOOL_01_PROVIDER_KEY"] = $Values.providerKey
    $process.StartInfo.EnvironmentVariables["TOOL_01_PROVIDER_NAME"] = $Values.providerName
    $process.StartInfo.EnvironmentVariables["TOOL_01_API_KEY"] = $Values.apiKey

    $outputHandler = [System.Diagnostics.DataReceivedEventHandler]{
        param($sender, $eventArgs)
        if (-not [string]::IsNullOrWhiteSpace($eventArgs.Data)) {
            [System.Threading.Monitor]::Enter($logQueue)
            try {
                $logQueue.Enqueue($eventArgs.Data)
            }
            finally {
                [System.Threading.Monitor]::Exit($logQueue)
            }
        }
    }
    $errorHandler = [System.Diagnostics.DataReceivedEventHandler]{
        param($sender, $eventArgs)
        if (-not [string]::IsNullOrWhiteSpace($eventArgs.Data)) {
            [System.Threading.Monitor]::Enter($logQueue)
            try {
                $logQueue.Enqueue($eventArgs.Data)
            }
            finally {
                [System.Threading.Monitor]::Exit($logQueue)
            }
        }
    }

    $null = $process.add_OutputDataReceived($outputHandler)
    $null = $process.add_ErrorDataReceived($errorHandler)

    Append-InstallerLog -Message "Starting install..."
    if (-not $process.Start()) {
        throw "The installer process could not be started."
    }

    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()

    while (-not $process.HasExited) {
        Drain-InstallQueue -Queue $logQueue
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 200
    }

    $process.WaitForExit()
    Drain-InstallQueue -Queue $logQueue
    $process.remove_OutputDataReceived($outputHandler)
    $process.remove_ErrorDataReceived($errorHandler)

    if ($process.ExitCode -ne 0) {
        throw "Install failed with exit code $($process.ExitCode)."
    }

    Append-InstallerLog -Message "Install complete."
}

function Set-FlatButtonStyle {
    param(
        [Parameter(Mandatory = $true)]
        [System.Windows.Forms.Button]$Button,
        [Parameter(Mandatory = $true)]
        [System.Drawing.Color]$BackColor,
        [Parameter(Mandatory = $true)]
        [System.Drawing.Color]$ForeColor,
        [System.Drawing.Color]$BorderColor = [System.Drawing.Color]::FromArgb(88, 63, 40)
    )

    $Button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $Button.UseVisualStyleBackColor = $false
    $Button.BackColor = $BackColor
    $Button.ForeColor = $ForeColor
    $Button.FlatAppearance.BorderColor = $BorderColor
    $Button.FlatAppearance.BorderSize = 1
    $Button.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(
        [Math]::Min(255, $BackColor.R + 12),
        [Math]::Min(255, $BackColor.G + 12),
        [Math]::Min(255, $BackColor.B + 12)
    )
    $Button.FlatAppearance.MouseDownBackColor = [System.Drawing.Color]::FromArgb(
        [Math]::Max(0, $BackColor.R - 12),
        [Math]::Max(0, $BackColor.G - 12),
        [Math]::Max(0, $BackColor.B - 12)
    )
}

function New-SectionCard {
    param(
        [System.Windows.Forms.Control]$Parent,
        [string]$Title,
        [string]$Subtitle,
        [int]$X,
        [int]$Y,
        [int]$CardWidth,
        [int]$CardHeight
    )

    $panel = New-Object System.Windows.Forms.Panel
    $panel.Location = New-Object System.Drawing.Point($X, $Y)
    $panel.Size = New-Object System.Drawing.Size($CardWidth, $CardHeight)
    $panel.BackColor = [System.Drawing.Color]::FromArgb(31, 20, 13)
    $panel.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $Parent.Controls.Add($panel)

    $accent = New-Object System.Windows.Forms.Panel
    $accent.Location = New-Object System.Drawing.Point(0, 0)
    $accent.Size = New-Object System.Drawing.Size($CardWidth, 4)
    $accent.BackColor = [System.Drawing.Color]::FromArgb(214, 157, 84)
    $panel.Controls.Add($accent)

    $titleLabel = New-Object System.Windows.Forms.Label
    $titleLabel.Location = New-Object System.Drawing.Point(18, 16)
    $titleLabel.Size = New-Object System.Drawing.Size(($CardWidth - 36), 22)
    $titleLabel.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 12)
    $titleLabel.ForeColor = [System.Drawing.Color]::FromArgb(244, 231, 208)
    $titleLabel.Text = $Title
    $panel.Controls.Add($titleLabel)

    $subtitleLabel = New-Object System.Windows.Forms.Label
    $subtitleLabel.Location = New-Object System.Drawing.Point(18, 42)
    $subtitleLabel.Size = New-Object System.Drawing.Size(($CardWidth - 36), 34)
    $subtitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(208, 188, 160)
    $subtitleLabel.Text = $Subtitle
    $panel.Controls.Add($subtitleLabel)

    return $panel
}

function New-InfoChip {
    param(
        [System.Windows.Forms.Control]$Parent,
        [string]$Text,
        [int]$X,
        [int]$Y,
        [int]$Width = 106
    )

    $chip = New-Object System.Windows.Forms.Label
    $chip.Location = New-Object System.Drawing.Point($X, $Y)
    $chip.Size = New-Object System.Drawing.Size($Width, 24)
    $chip.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $chip.BackColor = [System.Drawing.Color]::FromArgb(52, 35, 22)
    $chip.ForeColor = [System.Drawing.Color]::FromArgb(241, 197, 137)
    $chip.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $chip.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 8.5)
    $chip.Text = $Text
    $Parent.Controls.Add($chip)
}

function New-LabeledTextBox {
    param(
        [System.Windows.Forms.Control]$Parent,
        [string]$Label,
        [string]$Value,
        [int]$Y,
        [ValidateSet("none", "folder", "file")]
        [string]$Browse = "none"
    )

    $labelControl = New-Object System.Windows.Forms.Label
    $labelControl.Location = New-Object System.Drawing.Point(18, $Y)
    $labelControl.Size = New-Object System.Drawing.Size(190, 20)
    $labelControl.ForeColor = [System.Drawing.Color]::FromArgb(243, 228, 203)
    $labelControl.Text = $Label
    $Parent.Controls.Add($labelControl)

    $textBox = New-Object System.Windows.Forms.TextBox
    $textBox.Location = New-Object System.Drawing.Point(218, ($Y - 3))
    $textBox.Size = New-Object System.Drawing.Size(508, 24)
    $textBox.Text = $Value
    $textBox.BackColor = [System.Drawing.Color]::FromArgb(16, 10, 7)
    $textBox.ForeColor = [System.Drawing.Color]::FromArgb(245, 234, 214)
    $textBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $Parent.Controls.Add($textBox)

    if ($Browse -ne "none") {
        $button = New-Object System.Windows.Forms.Button
        $button.Location = New-Object System.Drawing.Point(738, ($Y - 5))
        $button.Size = New-Object System.Drawing.Size(108, 28)
        $button.Text = "Browse..."
        Set-FlatButtonStyle -Button $button -BackColor ([System.Drawing.Color]::FromArgb(66, 45, 29)) -ForeColor ([System.Drawing.Color]::FromArgb(245, 231, 210))
        $button.Add_Click({
            if ($Browse -eq "folder") {
                $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
                $dialog.ShowNewFolderButton = $true
                if ($textBox.Text -and (Test-Path $textBox.Text)) {
                    $dialog.SelectedPath = $textBox.Text
                }

                if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                    $textBox.Text = $dialog.SelectedPath
                }
            } else {
                $dialog = New-Object System.Windows.Forms.OpenFileDialog
                $dialog.Filter = "Executable (*.exe)|*.exe|All files (*.*)|*.*"
                if ($textBox.Text -and (Test-Path $textBox.Text)) {
                    $dialog.FileName = $textBox.Text
                }

                if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                    $textBox.Text = $dialog.FileName
                }
            }
        })
        $Parent.Controls.Add($button)
    }

    return $textBox
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Tool_01 Dedicated Installer"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(940, 948)
$form.MinimumSize = $form.Size
$form.MaximumSize = $form.Size
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(18, 11, 7)
$form.ForeColor = [System.Drawing.Color]::FromArgb(241, 229, 198)
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$form.Add_Shown({
    $form.Activate()
})

$headerPanel = New-Object System.Windows.Forms.Panel
$headerPanel.Location = New-Object System.Drawing.Point(0, 0)
$headerPanel.Size = New-Object System.Drawing.Size(940, 146)
$headerPanel.BackColor = [System.Drawing.Color]::FromArgb(28, 17, 11)
$form.Controls.Add($headerPanel)

$headerAccent = New-Object System.Windows.Forms.Panel
$headerAccent.Location = New-Object System.Drawing.Point(0, 142)
$headerAccent.Size = New-Object System.Drawing.Size(940, 4)
$headerAccent.BackColor = [System.Drawing.Color]::FromArgb(214, 157, 84)
$form.Controls.Add($headerAccent)

$crestRing = New-Object System.Windows.Forms.Panel
$crestRing.Location = New-Object System.Drawing.Point(22, 20)
$crestRing.Size = New-Object System.Drawing.Size(72, 72)
$crestRing.BackColor = [System.Drawing.Color]::Transparent
$headerPanel.Controls.Add($crestRing)
$crestRing.Add_Paint({
    param($sender, $eventArgs)
    $graphics = $eventArgs.Graphics
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $penOuter = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(214, 157, 84), 2)
    $penInner = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(110, 70, 34), 1)
    $brushCore = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(94, 56, 25))
    $brushSail = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(241, 197, 137))
    $graphics.FillEllipse($brushCore, 22, 22, 28, 28)
    $graphics.DrawEllipse($penOuter, 8, 8, 56, 56)
    $graphics.DrawEllipse($penInner, 16, 16, 40, 40)
    $pointsLeft = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point(18, 22)),
        (New-Object System.Drawing.Point(30, 12)),
        (New-Object System.Drawing.Point(28, 58)),
        (New-Object System.Drawing.Point(18, 48))
    )
    $pointsRight = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point(54, 22)),
        (New-Object System.Drawing.Point(42, 12)),
        (New-Object System.Drawing.Point(44, 58)),
        (New-Object System.Drawing.Point(54, 48))
    )
    $graphics.FillPolygon($brushSail, $pointsLeft)
    $graphics.FillPolygon($brushSail, $pointsRight)
    $penOuter.Dispose()
    $penInner.Dispose()
    $brushCore.Dispose()
    $brushSail.Dispose()
})

$header = New-Object System.Windows.Forms.Label
$header.Location = New-Object System.Drawing.Point(112, 18)
$header.Size = New-Object System.Drawing.Size(520, 34)
$header.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 18)
$header.ForeColor = [System.Drawing.Color]::FromArgb(247, 233, 206)
$header.Text = "Last Oasis Control Center"
$headerPanel.Controls.Add($header)

$subHeader = New-Object System.Windows.Forms.Label
$subHeader.Location = New-Object System.Drawing.Point(114, 56)
$subHeader.Size = New-Object System.Drawing.Size(520, 56)
$subHeader.ForeColor = [System.Drawing.Color]::FromArgb(209, 190, 162)
$subHeader.Text = "Pick only the 3 core paths, then Tool_01 installs SteamCMD, installs or validates the dedicated server, and saves everything else for later editing inside the manager."
$headerPanel.Controls.Add($subHeader)

$headerMeta = New-Object System.Windows.Forms.Panel
$headerMeta.Location = New-Object System.Drawing.Point(694, 18)
$headerMeta.Size = New-Object System.Drawing.Size(214, 104)
$headerMeta.BackColor = [System.Drawing.Color]::FromArgb(33, 22, 15)
$headerMeta.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$headerPanel.Controls.Add($headerMeta)

$headerMetaTitle = New-Object System.Windows.Forms.Label
$headerMetaTitle.Location = New-Object System.Drawing.Point(12, 8)
$headerMetaTitle.Size = New-Object System.Drawing.Size(188, 18)
$headerMetaTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$headerMetaTitle.ForeColor = [System.Drawing.Color]::FromArgb(214, 157, 84)
$headerMetaTitle.Text = "Install readiness"
$headerMeta.Controls.Add($headerMetaTitle)

New-InfoChip -Parent $headerMeta -Text "Auto-detect" -X 12 -Y 30 -Width 188
New-InfoChip -Parent $headerMeta -Text "SteamCMD" -X 12 -Y 56 -Width 188
New-InfoChip -Parent $headerMeta -Text "Safe defaults" -X 12 -Y 82 -Width 188

$pathsCard = New-SectionCard -Parent $form -Title "Install paths" -Subtitle "Pick only the same core locations the simple launcher needs: dedicated server, SteamCMD, and the reusable profile/settings folder. SteamCMD and the dedicated server are installed automatically, and the rest is derived." -X 20 -Y 166 -CardWidth 886 -CardHeight 206
$serverPathBox = New-LabeledTextBox -Parent $pathsCard -Label "Dedicated server path" -Value $ServerPath -Y 86 -Browse "folder"
$steamCmdInstallDirectoryBox = New-LabeledTextBox -Parent $pathsCard -Label "SteamCMD install folder" -Value $SteamCmdInstallDirectory -Y 124 -Browse "folder"
$profileRootBox = New-LabeledTextBox -Parent $pathsCard -Label "Profile/settings folder" -Value $ProfileRoot -Y 162 -Browse "folder"

$realmCard = New-SectionCard -Parent $form -Title "Realm setup" -Subtitle "Fill in the keys and public address if you already have them. Blank values are allowed and can be added or changed later from the manager." -X 20 -Y 390 -CardWidth 886 -CardHeight 286
$publicAddressBox = New-LabeledTextBox -Parent $realmCard -Label "Public IP or DNS" -Value $PublicAddress -Y 86
$customerKeyBox = New-LabeledTextBox -Parent $realmCard -Label "Customer key" -Value $CustomerKey -Y 124
$providerKeyBox = New-LabeledTextBox -Parent $realmCard -Label "Provider key" -Value $ProviderKey -Y 162
$providerNameBox = New-LabeledTextBox -Parent $realmCard -Label "Provider label" -Value $ProviderName -Y 200
$apiKeyBox = New-LabeledTextBox -Parent $realmCard -Label "API key" -Value $ApiKey -Y 238

$footerCard = New-Object System.Windows.Forms.Panel
$footerCard.Location = New-Object System.Drawing.Point(20, 692)
$footerCard.Size = New-Object System.Drawing.Size(886, 62)
$footerCard.BackColor = [System.Drawing.Color]::FromArgb(31, 20, 13)
$footerCard.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$form.Controls.Add($footerCard)

$footerHint = New-Object System.Windows.Forms.Label
$footerHint.Location = New-Object System.Drawing.Point(16, 10)
$footerHint.Size = New-Object System.Drawing.Size(610, 40)
$footerHint.ForeColor = [System.Drawing.Color]::FromArgb(208, 188, 160)
$footerHint.Text = "Choose 3 paths, then the installer handles SteamCMD, the dedicated server install, and the rest of the machine paths automatically. Everything else can be changed later in the manager."
$footerCard.Controls.Add($footerHint)

$logCard = New-Object System.Windows.Forms.Panel
$logCard.Location = New-Object System.Drawing.Point(20, 768)
$logCard.Size = New-Object System.Drawing.Size(886, 126)
$logCard.BackColor = [System.Drawing.Color]::FromArgb(31, 20, 13)
$logCard.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$form.Controls.Add($logCard)

$logTitle = New-Object System.Windows.Forms.Label
$logTitle.Location = New-Object System.Drawing.Point(16, 10)
$logTitle.Size = New-Object System.Drawing.Size(180, 20)
$logTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
$logTitle.ForeColor = [System.Drawing.Color]::FromArgb(243, 228, 203)
$logTitle.Text = "Install progress"
$logCard.Controls.Add($logTitle)

$script:InstallerStatusLabel = New-Object System.Windows.Forms.Label
$script:InstallerStatusLabel.Location = New-Object System.Drawing.Point(204, 10)
$script:InstallerStatusLabel.Size = New-Object System.Drawing.Size(662, 20)
$script:InstallerStatusLabel.ForeColor = [System.Drawing.Color]::FromArgb(208, 188, 160)
$script:InstallerStatusLabel.Text = if ($RunInstall) { "Ready to install." } else { "Ready." }
$logCard.Controls.Add($script:InstallerStatusLabel)

$script:InstallerLogBox = New-Object System.Windows.Forms.TextBox
$script:InstallerLogBox.Location = New-Object System.Drawing.Point(16, 36)
$script:InstallerLogBox.Size = New-Object System.Drawing.Size(852, 74)
$script:InstallerLogBox.Multiline = $true
$script:InstallerLogBox.ReadOnly = $true
$script:InstallerLogBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
$script:InstallerLogBox.BackColor = [System.Drawing.Color]::FromArgb(16, 10, 7)
$script:InstallerLogBox.ForeColor = [System.Drawing.Color]::FromArgb(245, 234, 214)
$script:InstallerLogBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$logCard.Controls.Add($script:InstallerLogBox)

if ($RunInstall) {
    Append-InstallerLog -Message "Choose the server path, SteamCMD folder, and profile folder, then click Install."
}

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Location = New-Object System.Drawing.Point(678, 15)
$cancelButton.Size = New-Object System.Drawing.Size(94, 30)
$cancelButton.Text = "Cancel"
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
Set-FlatButtonStyle -Button $cancelButton -BackColor ([System.Drawing.Color]::FromArgb(48, 33, 22)) -ForeColor ([System.Drawing.Color]::FromArgb(244, 231, 208))
$footerCard.Controls.Add($cancelButton)

$installButton = New-Object System.Windows.Forms.Button
$installButton.Location = New-Object System.Drawing.Point(782, 15)
$installButton.Size = New-Object System.Drawing.Size(102, 30)
$installButton.Text = "Install"
Set-FlatButtonStyle -Button $installButton -BackColor ([System.Drawing.Color]::FromArgb(214, 157, 84)) -ForeColor ([System.Drawing.Color]::FromArgb(35, 18, 8)) -BorderColor ([System.Drawing.Color]::FromArgb(166, 113, 52))
$footerCard.Controls.Add($installButton)

$form.AcceptButton = $installButton
$form.CancelButton = $cancelButton

$installButton.Add_Click({
    if ([string]::IsNullOrWhiteSpace($serverPathBox.Text)) {
        [System.Windows.Forms.MessageBox]::Show("Pick a Last Oasis dedicated server path before continuing.", "Tool_01 Installer", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
    }

    $serverPathValue = $serverPathBox.Text.Trim()
    $serverParentPath = Split-Path -Parent $serverPathValue
    if ([string]::IsNullOrWhiteSpace($serverParentPath) -or -not (Test-Path $serverParentPath)) {
        [System.Windows.Forms.MessageBox]::Show("The dedicated server path can be new, but its parent folder must already exist.", "Tool_01 Installer", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
    }

    if ([string]::IsNullOrWhiteSpace($steamCmdInstallDirectoryBox.Text)) {
        [System.Windows.Forms.MessageBox]::Show("Pick a SteamCMD install folder before continuing.", "Tool_01 Installer", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
    }

    $steamCmdParentPath = Split-Path -Parent $steamCmdInstallDirectoryBox.Text.Trim()
    if ([string]::IsNullOrWhiteSpace($steamCmdParentPath) -or -not (Test-Path $steamCmdParentPath)) {
        [System.Windows.Forms.MessageBox]::Show("The SteamCMD install folder can be new, but its parent folder must already exist.", "Tool_01 Installer", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
    }

    if ([string]::IsNullOrWhiteSpace($profileRootBox.Text)) {
        [System.Windows.Forms.MessageBox]::Show("Pick a profile/settings folder before continuing. This folder keeps the reusable config for fresh reinstalls.", "Tool_01 Installer", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
    }

    $profileRootParentPath = Split-Path -Parent $profileRootBox.Text.Trim()
    if ([string]::IsNullOrWhiteSpace($profileRootParentPath) -or -not (Test-Path $profileRootParentPath)) {
        [System.Windows.Forms.MessageBox]::Show("The profile/settings folder can be new, but its parent folder must already exist.", "Tool_01 Installer", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
        return
    }

    $selectedValues = @{
        serverPath = $serverPathBox.Text.Trim()
        steamCmdInstallDirectory = $steamCmdInstallDirectoryBox.Text.Trim()
        profileRoot = $profileRootBox.Text.Trim()
        publicAddress = $publicAddressBox.Text.Trim()
        customerKey = $customerKeyBox.Text.Trim()
        providerKey = $providerKeyBox.Text.Trim()
        providerName = $providerNameBox.Text.Trim()
        apiKey = $apiKeyBox.Text.Trim()
    }

    if ($RunInstall) {
        try {
            $installButton.Enabled = $false
            $cancelButton.Enabled = $false
            $script:InstallerStatusLabel.Text = "Installing SteamCMD and validating the dedicated server. This can take a few minutes..."
            $form.UseWaitCursor = $true
            Invoke-InstallerRun -Values $selectedValues
            $script:InstallerStatusLabel.Text = "Install complete. Opening the manager..."
        }
        catch {
            $form.UseWaitCursor = $false
            $installButton.Enabled = $true
            $cancelButton.Enabled = $true
            $script:InstallerStatusLabel.Text = "Install failed. Fix the path or try again."
            Append-InstallerLog -Message $_.Exception.Message
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Tool_01 Installer", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
            return
        }
    }

    $form.Tag = $selectedValues
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
})

$result = $form.ShowDialog()
if ($result -ne [System.Windows.Forms.DialogResult]::OK -or -not $form.Tag) {
    exit 1
}

$form.Tag | ConvertTo-Json -Compress
