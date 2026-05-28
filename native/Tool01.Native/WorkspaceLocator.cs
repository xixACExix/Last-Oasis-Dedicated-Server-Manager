using System.Diagnostics;

namespace Tool01.Native;

internal static class WorkspaceLocator
{
    public static string FindRoot()
    {
        return BackendWorkspaceBootstrapper.FindOrExtractWorkspace();
    }

    public static void OpenUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return;
        }

        Process.Start(new ProcessStartInfo
        {
            FileName = url,
            UseShellExecute = true,
        });
    }

    public static void OpenPath(string? targetPath)
    {
        if (string.IsNullOrWhiteSpace(targetPath))
        {
            return;
        }

        Process.Start(new ProcessStartInfo
        {
            FileName = targetPath,
            UseShellExecute = true,
        });
    }
}
