using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

namespace Tool01.Native;

internal static class BackendWorkspaceBootstrapper
{
    private const string EmbeddedPayloadName = "Tool01.Native.Payload.Tool_01.payload.zip";
    private const string ExtractedFolderName = "LO_Manager_backend";
    private const string LegacyExtractedFolderName = "Tool01.Backend";
    private const string PayloadHashFileName = ".backend-payload.sha256";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };
    private sealed record ProfileLink(string? ProfileRoot);
    private sealed record WritableProfileLink(string? ProfileRoot, string? LinkedAt);
    private sealed record InstallContextPayload(
        string? ToolRoot,
        string? ProfileRoot,
        string? ServerPath,
        string? GamePath,
        string? SteamExePath,
        string? SteamServicePath,
        string? WorkshopContentPath,
        string? SteamCmdInstallDirectory,
        string? SteamCmdPath,
        string? NodeRoot,
        string? InstalledAt
    );

    public static string FindOrExtractWorkspace()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (IsWorkspaceRoot(current.FullName))
            {
                RefreshEmbeddedWorkspaceIfStale(current.FullName);
                return current.FullName;
            }

            current = current.Parent;
        }

        var extractedRoot = Path.Combine(AppContext.BaseDirectory, ExtractedFolderName);
        if (IsWorkspaceRoot(extractedRoot))
        {
            RefreshEmbeddedWorkspaceIfStale(extractedRoot);
            return extractedRoot;
        }

        var legacyExtractedRoot = Path.Combine(AppContext.BaseDirectory, LegacyExtractedFolderName);
        if (IsWorkspaceRoot(legacyExtractedRoot))
        {
            if (!Directory.Exists(extractedRoot))
            {
                try
                {
                    Directory.Move(legacyExtractedRoot, extractedRoot);
                    RefreshEmbeddedWorkspaceIfStale(extractedRoot);
                    return extractedRoot;
                }
                catch
                {
                    // Keep old installs usable even if Windows has a handle open during the rename.
                }
            }

            RefreshEmbeddedWorkspaceIfStale(legacyExtractedRoot);
            return legacyExtractedRoot;
        }

        ExtractEmbeddedWorkspace(extractedRoot);
        return extractedRoot;
    }

    public static bool NeedsInstall(string root)
    {
        var installContext = ReadInstallContext(root);
        if (!string.IsNullOrWhiteSpace(installContext.InstallContextPath) && File.Exists(installContext.InstallContextPath))
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(installContext.ServerPath))
        {
            var serverExePath = Path.Combine(installContext.ServerPath, "Mist", "Binaries", "Win64", "MistServer-Win64-Shipping.exe");
            if (File.Exists(serverExePath))
            {
                return false;
            }
        }

        if (!string.IsNullOrWhiteSpace(installContext.SteamCmdPath) && File.Exists(installContext.SteamCmdPath))
        {
            return false;
        }

        return true;
    }

    public static LocalInstallContext ReadInstallContext(string root)
    {
        var workspaceDataPath = Path.Combine(root, "data");
        var profileLinkPath = Path.Combine(workspaceDataPath, "profile-link.json");
        var profileRoot = workspaceDataPath;

        if (File.Exists(profileLinkPath))
        {
            try
            {
                var profileLink = JsonSerializer.Deserialize<ProfileLink>(File.ReadAllText(profileLinkPath), JsonOptions);
                if (!string.IsNullOrWhiteSpace(profileLink?.ProfileRoot))
                {
                    profileRoot = Path.GetFullPath(profileLink.ProfileRoot);
                }
            }
            catch
            {
                profileRoot = workspaceDataPath;
            }
        }

        var installContextPath = Path.Combine(profileRoot, "install-context.json");
        var installContext = new LocalInstallContext
        {
            ToolRoot = root,
            WorkspaceDataPath = workspaceDataPath,
            ProfileLinkPath = profileLinkPath,
            InstallContextPath = installContextPath,
            ProfileRoot = profileRoot,
        };

        if (!File.Exists(installContextPath))
        {
            return installContext;
        }

        try
        {
            var payload = JsonSerializer.Deserialize<InstallContextPayload>(File.ReadAllText(installContextPath), JsonOptions);
            if (payload is null)
            {
                return installContext;
            }

            installContext.ToolRoot = string.IsNullOrWhiteSpace(payload.ToolRoot) ? root : payload.ToolRoot;
            installContext.ProfileRoot = string.IsNullOrWhiteSpace(payload.ProfileRoot) ? profileRoot : payload.ProfileRoot;
            installContext.ServerPath = payload.ServerPath ?? "";
            installContext.GamePath = payload.GamePath ?? "";
            installContext.SteamExePath = payload.SteamExePath ?? "";
            installContext.SteamServicePath = payload.SteamServicePath ?? "";
            installContext.WorkshopContentPath = payload.WorkshopContentPath ?? "";
            installContext.SteamCmdInstallDirectory = payload.SteamCmdInstallDirectory ?? "";
            installContext.SteamCmdPath = payload.SteamCmdPath ?? "";
            installContext.NodeRoot = payload.NodeRoot ?? "";
            installContext.InstalledAt = payload.InstalledAt ?? "";
        }
        catch
        {
            return installContext;
        }

        return installContext;
    }

    public static LocalInstallContext SaveInstallContext(string root, LocalInstallContext requestedContext)
    {
        var workspaceDataPath = Path.Combine(root, "data");
        Directory.CreateDirectory(workspaceDataPath);

        var currentContext = ReadInstallContext(root);
        var requestedProfileRoot = NormalizePathOrFallback(requestedContext.ProfileRoot, currentContext.ProfileRoot, workspaceDataPath);
        var requestedToolRoot = NormalizePathOrFallback(requestedContext.ToolRoot, root, root);
        var requestedServerPath = NormalizePathOrEmpty(requestedContext.ServerPath);
        var requestedSteamCmdInstallDirectory = NormalizePathOrEmpty(requestedContext.SteamCmdInstallDirectory);
        var requestedSteamCmdPath = !string.IsNullOrWhiteSpace(requestedSteamCmdInstallDirectory)
            ? Path.Combine(requestedSteamCmdInstallDirectory, "steamcmd.exe")
            : NormalizePathOrEmpty(requestedContext.SteamCmdPath);
        var requestedWorkshopContentPath = !string.IsNullOrWhiteSpace(requestedSteamCmdInstallDirectory)
            ? Path.Combine(requestedSteamCmdInstallDirectory, "steamapps", "workshop", "content", "903950")
            : NormalizePathOrEmpty(requestedContext.WorkshopContentPath);

        Directory.CreateDirectory(requestedProfileRoot);
        Directory.CreateDirectory(Path.Combine(requestedProfileRoot, "backups"));
        MigrateProfileData(currentContext.ProfileRoot, requestedProfileRoot);
        EnsureProfileFolderReadme(requestedProfileRoot, workspaceDataPath);

        var installContextPath = Path.Combine(requestedProfileRoot, "install-context.json");
        var profileLinkPath = Path.Combine(workspaceDataPath, "profile-link.json");
        var payload = new InstallContextPayload(
            requestedToolRoot,
            requestedProfileRoot,
            requestedServerPath,
            NormalizePathOrEmpty(requestedContext.GamePath),
            NormalizePathOrEmpty(requestedContext.SteamExePath),
            NormalizePathOrEmpty(requestedContext.SteamServicePath),
            requestedWorkshopContentPath,
            requestedSteamCmdInstallDirectory,
            requestedSteamCmdPath,
            NormalizePathOrEmpty(requestedContext.NodeRoot),
            DateTimeOffset.UtcNow.ToString("O")
        );

        File.WriteAllText(installContextPath, JsonSerializer.Serialize(payload, JsonOptions));
        File.WriteAllText(
            profileLinkPath,
            JsonSerializer.Serialize(new WritableProfileLink(requestedProfileRoot, DateTimeOffset.UtcNow.ToString("O")), JsonOptions));

        return ReadInstallContext(root);
    }

    private static bool IsWorkspaceRoot(string path)
    {
        return File.Exists(Path.Combine(path, "package.json")) &&
               File.Exists(Path.Combine(path, "scripts", "start-control-center.ps1"));
    }

    private static void ExtractEmbeddedWorkspace(string destinationRoot)
    {
        var parentDirectory = Path.GetDirectoryName(destinationRoot);
        if (!string.IsNullOrWhiteSpace(parentDirectory))
        {
            Directory.CreateDirectory(parentDirectory);
        }

        Directory.CreateDirectory(destinationRoot);
        var payloadBytes = ReadEmbeddedPayloadBytes();
        ExtractPayloadBytesToDirectory(payloadBytes, destinationRoot, skipNativeApps: false);
        WritePayloadHash(destinationRoot, ComputePayloadHash(payloadBytes));

        if (!IsWorkspaceRoot(destinationRoot))
        {
            throw new InvalidOperationException("The embedded backend payload was extracted, but the workspace is incomplete.");
        }
    }

    private static void RefreshEmbeddedWorkspaceIfStale(string destinationRoot)
    {
        var payloadBytes = ReadEmbeddedPayloadBytes();
        var payloadHash = ComputePayloadHash(payloadBytes);
        var hashPath = PayloadHashPath(destinationRoot);
        if (File.Exists(hashPath))
        {
            try
            {
                var existingHash = File.ReadAllText(hashPath).Trim();
                if (string.Equals(existingHash, payloadHash, StringComparison.OrdinalIgnoreCase))
                {
                    return;
                }
            }
            catch
            {
                // If the marker cannot be read, refresh the backend files below.
            }
        }

        ExtractPayloadBytesToDirectory(payloadBytes, destinationRoot, skipNativeApps: true);
        WritePayloadHash(destinationRoot, payloadHash);
    }

    private static byte[] ReadEmbeddedPayloadBytes()
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var resource = assembly.GetManifestResourceStream(EmbeddedPayloadName);
        if (resource is null)
        {
            throw new InvalidOperationException("The embedded backend payload was not found in Tool01.Native.exe.");
        }

        using var payloadBuffer = new MemoryStream();
        resource.CopyTo(payloadBuffer);
        return payloadBuffer.ToArray();
    }

    private static string ComputePayloadHash(byte[] payloadBytes)
    {
        return Convert.ToHexString(SHA256.HashData(payloadBytes)).ToLowerInvariant();
    }

    private static string PayloadHashPath(string destinationRoot)
    {
        return Path.Combine(destinationRoot, "data", PayloadHashFileName);
    }

    private static void WritePayloadHash(string destinationRoot, string payloadHash)
    {
        var hashPath = PayloadHashPath(destinationRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(hashPath)!);
        File.WriteAllText(hashPath, payloadHash);
    }

    private static void ExtractPayloadBytesToDirectory(byte[] payloadBytes, string destinationRoot, bool skipNativeApps)
    {
        Directory.CreateDirectory(destinationRoot);
        var normalizedRoot = Path.GetFullPath(destinationRoot);
        if (!normalizedRoot.EndsWith(Path.DirectorySeparatorChar))
        {
            normalizedRoot += Path.DirectorySeparatorChar;
        }

        using var payloadBuffer = new MemoryStream(payloadBytes);
        using var archive = new ZipArchive(payloadBuffer, ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            var normalizedEntryName = entry.FullName.Replace('\\', '/');
            if (skipNativeApps &&
                (normalizedEntryName.StartsWith("NativeApp/", StringComparison.OrdinalIgnoreCase) ||
                 normalizedEntryName.StartsWith("DedicatedManager/", StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            var destinationPath = Path.GetFullPath(Path.Combine(destinationRoot, entry.FullName));
            if (!destinationPath.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("The embedded backend payload contains an invalid path.");
            }

            if (string.IsNullOrWhiteSpace(entry.Name))
            {
                Directory.CreateDirectory(destinationPath);
                continue;
            }

            var destinationDirectory = Path.GetDirectoryName(destinationPath);
            if (!string.IsNullOrWhiteSpace(destinationDirectory))
            {
                Directory.CreateDirectory(destinationDirectory);
            }

            entry.ExtractToFile(destinationPath, overwrite: true);
        }
    }

    private static string NormalizePathOrEmpty(string? candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate))
        {
            return "";
        }

        return Path.GetFullPath(Environment.ExpandEnvironmentVariables(candidate.Trim()));
    }

    private static string NormalizePathOrFallback(string? candidate, string? fallback, string hardFallback)
    {
        var preferred = NormalizePathOrEmpty(candidate);
        if (!string.IsNullOrWhiteSpace(preferred))
        {
            return preferred;
        }

        var secondary = NormalizePathOrEmpty(fallback);
        if (!string.IsNullOrWhiteSpace(secondary))
        {
            return secondary;
        }

        return Path.GetFullPath(hardFallback);
    }

    private static void EnsureProfileFolderReadme(string profileRoot, string workspaceDataPath)
    {
        var readmePath = Path.Combine(profileRoot, "README.txt");
        if (File.Exists(readmePath))
        {
            return;
        }

        var lines = new[]
        {
            "LO_Profiles settings folder",
            "",
            "This folder stores the reusable dedicated-server setup data that should survive fresh installs.",
            "",
            "Important files here:",
            "- lo-tool.config.json -> launch profiles, realm settings, event settings, mod settings",
            "- install-context.json -> important install/runtime paths chosen during setup",
            "- backups\\ -> saved config backups created before installer rewrites",
            "",
            "If the manager is reinstalled somewhere else, point the new installer or native app back to this same folder.",
            $"The workspace-local data folder only keeps a small link file that points here: {workspaceDataPath}",
        };

        File.WriteAllText(readmePath, string.Join(Environment.NewLine, lines));
    }

    private static void MigrateProfileData(string? sourceRoot, string targetRoot)
    {
        var normalizedSource = NormalizePathOrEmpty(sourceRoot);
        var normalizedTarget = NormalizePathOrEmpty(targetRoot);
        if (string.IsNullOrWhiteSpace(normalizedSource) || string.IsNullOrWhiteSpace(normalizedTarget))
        {
            return;
        }

        if (string.Equals(normalizedSource, normalizedTarget, StringComparison.OrdinalIgnoreCase) || !Directory.Exists(normalizedSource))
        {
            return;
        }

        Directory.CreateDirectory(normalizedTarget);

        CopyFileIfMissing(Path.Combine(normalizedSource, "lo-tool.config.json"), Path.Combine(normalizedTarget, "lo-tool.config.json"));
        CopyFileIfMissing(Path.Combine(normalizedSource, "README.txt"), Path.Combine(normalizedTarget, "README.txt"));
        MergeDirectory(Path.Combine(normalizedSource, "backups"), Path.Combine(normalizedTarget, "backups"));
    }

    private static void CopyFileIfMissing(string sourcePath, string targetPath)
    {
        if (!File.Exists(sourcePath) || File.Exists(targetPath))
        {
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);
        File.Copy(sourcePath, targetPath, overwrite: false);
    }

    private static void MergeDirectory(string sourceDirectory, string targetDirectory)
    {
        if (!Directory.Exists(sourceDirectory))
        {
            return;
        }

        Directory.CreateDirectory(targetDirectory);

        foreach (var filePath in Directory.GetFiles(sourceDirectory, "*", SearchOption.AllDirectories))
        {
            var relativePath = Path.GetRelativePath(sourceDirectory, filePath);
            var targetPath = Path.Combine(targetDirectory, relativePath);
            if (File.Exists(targetPath))
            {
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);
            File.Copy(filePath, targetPath, overwrite: false);
        }
    }
}
