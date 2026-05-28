using System.Windows;

namespace Tool01.Native;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        try
        {
            var root = WorkspaceLocator.FindRoot();
            var forceInstaller = e.Args.Any(arg =>
                    string.Equals(arg, "--install", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(arg, "/install", StringComparison.OrdinalIgnoreCase)) ||
                string.Equals(
                    Environment.GetEnvironmentVariable("TOOL_01_FORCE_INSTALLER"),
                    "1",
                    StringComparison.OrdinalIgnoreCase);

            if (forceInstaller || BackendWorkspaceBootstrapper.NeedsInstall(root))
            {
                var installerWindow = new InstallerWindow(root);
                var installResult = installerWindow.ShowDialog();
                if (installResult != true || !installerWindow.InstallCompleted)
                {
                    Shutdown();
                    return;
                }
            }

            var window = new MainWindow();
            MainWindow = window;
            window.Show();
        }
        catch (OperationCanceledException)
        {
            Shutdown();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                ex.Message,
                "Last Oasis Dedicated Server Tool",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Shutdown();
        }
    }
}
