using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        string tempRoot = Path.Combine(
            Path.GetTempPath(),
            "Tool_01_Installer_" + Guid.NewGuid().ToString("N"));

        try
        {
            Directory.CreateDirectory(tempRoot);

            string payloadZipPath = Path.Combine(tempRoot, "FullPackage.zip");
            string bootstrapScriptPath = Path.Combine(tempRoot, "installer-bootstrap.ps1");

            WriteEmbeddedResource("Tool01Zip", payloadZipPath);
            WriteEmbeddedResource("InstallerBootstrapPs1", bootstrapScriptPath);

            string installerDirectory = Path.GetDirectoryName(Application.ExecutablePath);
            if (string.IsNullOrWhiteSpace(installerDirectory))
            {
                installerDirectory = Environment.CurrentDirectory;
            }

            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -STA -File " + Quote(bootstrapScriptPath),
                WorkingDirectory = tempRoot,
                UseShellExecute = false,
                CreateNoWindow = false
            };
            startInfo.EnvironmentVariables["TOOL_01_INSTALL_DESTINATION"] = Path.Combine(installerDirectory, "LO_Manager_backend");
            startInfo.EnvironmentVariables["TOOL_01_INSTALLER_SOURCE_DIR"] = installerDirectory;

            using (Process process = Process.Start(startInfo))
            {
                if (process == null)
                {
                    MessageBox.Show(
                        "Failed to start the Tool_01 installer bootstrap.",
                        "Tool_01 Installer",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return 2;
                }

                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                ex.Message,
                "Tool_01 Installer",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempRoot))
                {
                    Directory.Delete(tempRoot, true);
                }
            }
            catch
            {
            }
        }
    }

    private static void WriteEmbeddedResource(string resourceName, string destinationPath)
    {
        Assembly assembly = Assembly.GetExecutingAssembly();
        using (Stream resourceStream = assembly.GetManifestResourceStream(resourceName))
        {
            if (resourceStream == null)
            {
                throw new InvalidOperationException("Embedded installer resource was not found: " + resourceName);
            }

            string destinationDirectory = Path.GetDirectoryName(destinationPath);
            if (!string.IsNullOrWhiteSpace(destinationDirectory))
            {
                Directory.CreateDirectory(destinationDirectory);
            }

            using (FileStream destinationStream = new FileStream(destinationPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                resourceStream.CopyTo(destinationStream);
            }
        }
    }

    private static string Quote(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "\"\"";
        }

        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
