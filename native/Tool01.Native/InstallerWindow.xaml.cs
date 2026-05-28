using System.IO;
using System.Diagnostics;
using System.Text;
using System.Windows;
using Microsoft.Win32;

namespace Tool01.Native;

public partial class InstallerWindow : Window
{
    private readonly string _root;
    private bool _installCompleted;

    public InstallerWindow(string root)
    {
        InitializeComponent();
        _root = root;

        var systemDrive = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows)) ?? "C:\\";
        var existingContext = BackendWorkspaceBootstrapper.ReadInstallContext(_root);

        SteamCmdPathBox.Text = UseExistingPath(existingContext.SteamCmdInstallDirectory, Path.Combine(systemDrive, "SteamCMD"));
        ServerPathBox.Text = UseExistingPath(existingContext.ServerPath, Path.Combine(systemDrive, "LastOasisServer"));
        ProfileRootBox.Text = UseExistingProfileRoot(existingContext)
            ? existingContext.ProfileRoot
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "LO_Profiles");
    }

    public bool InstallCompleted => _installCompleted;

    private void BrowseSteamCmdFolderClick(object sender, RoutedEventArgs e) => BrowseFolderInto(SteamCmdPathBox);

    private void BrowseServerFolderClick(object sender, RoutedEventArgs e) => BrowseFolderInto(ServerPathBox);

    private void BrowseProfileFolderClick(object sender, RoutedEventArgs e) => BrowseFolderInto(ProfileRootBox);

    private void BrowseFolderInto(System.Windows.Controls.TextBox textBox)
    {
        var dialog = new OpenFolderDialog();
        if (!string.IsNullOrWhiteSpace(textBox.Text) && Directory.Exists(textBox.Text))
        {
            dialog.InitialDirectory = textBox.Text;
        }

        var result = dialog.ShowDialog();
        if (result == true)
        {
            textBox.Text = dialog.FolderName;
        }
    }

    private async void InstallClick(object sender, RoutedEventArgs e)
    {
        var steamCmdPath = SteamCmdPathBox.Text.Trim();
        var serverPath = ServerPathBox.Text.Trim();
        var profileRoot = ProfileRootBox.Text.Trim();

        if (!ValidateInstallPath(steamCmdPath, "SteamCMD folder") ||
            !ValidateInstallPath(serverPath, "Server folder") ||
            !ValidateInstallPath(profileRoot, "Profile folder"))
        {
            return;
        }

        if (!ConfirmProfileRootChoice(profileRoot))
        {
            return;
        }

        ToggleInstallUi(false);
        ClearLog();
        AppendLog("Starting install...");
        AppendLog($"SteamCMD folder: {steamCmdPath}");
        AppendLog($"Server folder: {serverPath}");
        AppendLog($"Profile folder: {profileRoot}");
        SetStatus("Installing SteamCMD, then the dedicated server, then the manager...");

        try
        {
            await RunInstallerProcessAsync(steamCmdPath, serverPath, profileRoot);
            _installCompleted = true;
            SetStatus("Install complete. Opening the manager...");
            DialogResult = true;
            Close();
        }
        catch (Exception ex)
        {
            AppendLog(ex.Message);
            SetStatus("Install failed. Fix the path or try again.");
            MessageBox.Show(
                ex.Message,
                "Last Oasis Installer",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            ToggleInstallUi(true);
        }
    }

    private void CancelClick(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private bool ValidateInstallPath(string path, string label)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            MessageBox.Show($"{label} cannot be blank.", "Last Oasis Installer", MessageBoxButton.OK, MessageBoxImage.Warning);
            return false;
        }

        var parent = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(path));
        if (string.IsNullOrWhiteSpace(parent) || !Directory.Exists(parent))
        {
            MessageBox.Show($"{label} can be new, but its parent folder must already exist.", "Last Oasis Installer", MessageBoxButton.OK, MessageBoxImage.Warning);
            return false;
        }

        return true;
    }

    private static string UseExistingPath(string existingPath, string fallbackPath)
    {
        return string.IsNullOrWhiteSpace(existingPath)
            ? fallbackPath
            : existingPath;
    }

    private static bool UseExistingProfileRoot(LocalInstallContext existingContext)
    {
        if (string.IsNullOrWhiteSpace(existingContext.ProfileRoot))
        {
            return false;
        }

        if (File.Exists(existingContext.ProfileLinkPath))
        {
            return true;
        }

        return File.Exists(Path.Combine(existingContext.ProfileRoot, "lo-tool.config.json")) ||
               File.Exists(Path.Combine(existingContext.ProfileRoot, "install-context.json"));
    }

    private bool ConfirmProfileRootChoice(string profileRoot)
    {
        var existingContext = BackendWorkspaceBootstrapper.ReadInstallContext(_root);
        if (string.IsNullOrWhiteSpace(existingContext.ProfileRoot) ||
            PathsEqual(existingContext.ProfileRoot, profileRoot))
        {
            return true;
        }

        var selectedConfigPath = Path.Combine(profileRoot, "lo-tool.config.json");
        var existingConfigPath = Path.Combine(existingContext.ProfileRoot, "lo-tool.config.json");
        if (File.Exists(selectedConfigPath) || !File.Exists(existingConfigPath))
        {
            return true;
        }

        var result = MessageBox.Show(
            "The selected profile folder does not contain an existing manager config.\n\n" +
            $"Existing profile folder:\n{existingContext.ProfileRoot}\n\n" +
            $"Selected folder:\n{profileRoot}\n\n" +
            "Choose No to switch back to the existing profile folder. Choose Yes only if you intentionally want a fresh manager profile.",
            "Last Oasis Installer",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning,
            MessageBoxResult.No);

        if (result == MessageBoxResult.Yes)
        {
            return true;
        }

        ProfileRootBox.Text = existingContext.ProfileRoot;
        return false;
    }

    private static bool PathsEqual(string left, string right)
    {
        try
        {
            return string.Equals(
                Path.GetFullPath(left),
                Path.GetFullPath(right),
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        }
    }

    private async Task RunInstallerProcessAsync(string steamCmdPath, string serverPath, string profileRoot)
    {
        var installScriptPath = Path.Combine(_root, "scripts", "install-control-center.ps1");
        if (!File.Exists(installScriptPath))
        {
            throw new InvalidOperationException("The main installer script is missing from the extracted backend.");
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -ExecutionPolicy Bypass -File \"{installScriptPath}\"",
            WorkingDirectory = _root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        startInfo.Environment["TOOL_01_INSTALL_NONINTERACTIVE"] = "1";
        startInfo.Environment["TOOL_01_DISABLE_CONSOLE_FALLBACK"] = "1";
        startInfo.Environment["LAST_OASIS_SERVER_PATH"] = serverPath;
        startInfo.Environment["TOOL_01_STEAMCMD_DIR"] = steamCmdPath;
        startInfo.Environment["TOOL_01_PROFILE_ROOT"] = profileRoot;

        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };

        var outputClosed = new TaskCompletionSource();
        var errorClosed = new TaskCompletionSource();

        process.OutputDataReceived += (_, args) =>
        {
            if (args.Data is null)
            {
                outputClosed.TrySetResult();
                return;
            }

            Dispatcher.Invoke(() => AppendLog(args.Data));
        };

        process.ErrorDataReceived += (_, args) =>
        {
            if (args.Data is null)
            {
                errorClosed.TrySetResult();
                return;
            }

            Dispatcher.Invoke(() => AppendLog(args.Data));
        };

        if (!process.Start())
        {
            throw new InvalidOperationException("The installer process could not be started.");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        await process.WaitForExitAsync();
        await Task.WhenAll(outputClosed.Task, errorClosed.Task);

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Install failed with exit code {process.ExitCode}.");
        }

        for (var attempt = 0; attempt < 20; attempt++)
        {
            if (!BackendWorkspaceBootstrapper.NeedsInstall(_root))
            {
                return;
            }

            await Task.Delay(500);
        }

        throw new InvalidOperationException("Install finished, but the backend still reports setup as incomplete.");
    }

    private void ToggleInstallUi(bool enabled)
    {
        InstallButton.IsEnabled = enabled;
        CancelButton.IsEnabled = enabled;
        SteamCmdPathBox.IsEnabled = enabled;
        ServerPathBox.IsEnabled = enabled;
        ProfileRootBox.IsEnabled = enabled;
    }

    private void SetStatus(string text)
    {
        StatusText.Text = text;
    }

    private void ClearLog()
    {
        LogTextBox.Clear();
    }

    private void AppendLog(string message)
    {
        var line = string.IsNullOrWhiteSpace(message)
            ? string.Empty
            : $"[{DateTime.Now:HH:mm:ss}] {message}";
        LogTextBox.AppendText(line + Environment.NewLine);
        LogTextBox.ScrollToEnd();
    }
}
