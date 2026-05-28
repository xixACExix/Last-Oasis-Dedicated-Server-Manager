using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LOManagerBridge;

public sealed class LOManagerBridgeTileRouter
{
    private static readonly Regex TileNameRegex = new(@"LogPersistence:\s+tile_name:\s*(?<value>.+)$", RegexOptions.Compiled);
    private static readonly Regex TileIdRegex = new(@"LogPersistence:\s+tile_id:\s*(?<value>.+)$", RegexOptions.Compiled);

    private readonly string _mistRoot;
    private readonly ConcurrentDictionary<string, TileInstance> _tilesByBridgeId = new(StringComparer.OrdinalIgnoreCase);

    public LOManagerBridgeTileRouter(string mistRoot)
    {
        _mistRoot = mistRoot;
    }

    public IReadOnlyCollection<TileInstance> ActiveTiles => _tilesByBridgeId.Values.ToArray();

    public TileInstance StartTile(string serverExePath, string existingArguments)
    {
        var bridgeId = CreateBridgeId();
        var inboxPath = GetInboxPath(bridgeId);

        Directory.CreateDirectory(Path.GetDirectoryName(inboxPath)!);

        var args = $"{existingArguments} -LOMBTileId={bridgeId}";
        var startInfo = new ProcessStartInfo
        {
            FileName = serverExePath,
            Arguments = args,
            WorkingDirectory = Path.GetDirectoryName(serverExePath)!,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = false,
        };

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };

        var tile = new TileInstance(
            BridgeId: bridgeId,
            InboxPath: inboxPath,
            ProcessId: null,
            TileName: null,
            TileId: null);

        if (!process.Start())
        {
            throw new InvalidOperationException("Failed to start Last Oasis tile process.");
        }

        tile = tile with { ProcessId = process.Id };
        _tilesByBridgeId[bridgeId] = tile;

        process.OutputDataReceived += (_, e) => TrackLogLine(bridgeId, e.Data);
        process.ErrorDataReceived += (_, e) => TrackLogLine(bridgeId, e.Data);
        process.Exited += (_, _) => _tilesByBridgeId.TryRemove(bridgeId, out _);

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        return tile;
    }

    public void TrackLogLine(string bridgeId, string? line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }

        if (!_tilesByBridgeId.TryGetValue(bridgeId, out var tile))
        {
            return;
        }

        var tileName = TileNameRegex.Match(line);
        if (tileName.Success)
        {
            _tilesByBridgeId[bridgeId] = tile with { TileName = tileName.Groups["value"].Value.Trim() };
            return;
        }

        var tileId = TileIdRegex.Match(line);
        if (tileId.Success)
        {
            _tilesByBridgeId[bridgeId] = tile with { TileId = tileId.Groups["value"].Value.Trim() };
        }
    }

    public async Task SendToTileIdAsync(string tileId, BridgeCommand command, CancellationToken cancellationToken = default)
    {
        var tile = ActiveTiles.FirstOrDefault(x => string.Equals(x.TileId, tileId, StringComparison.OrdinalIgnoreCase));
        if (tile is null)
        {
            throw new InvalidOperationException($"No running tile with tile_id {tileId} is known yet.");
        }

        await WriteCommandAsync(tile.InboxPath, command, cancellationToken);
    }

    public async Task SendToTileNameAsync(string tileName, BridgeCommand command, CancellationToken cancellationToken = default)
    {
        var tile = ActiveTiles.FirstOrDefault(x => string.Equals(x.TileName, tileName, StringComparison.OrdinalIgnoreCase));
        if (tile is null)
        {
            throw new InvalidOperationException($"No running tile named {tileName} is known yet.");
        }

        await WriteCommandAsync(tile.InboxPath, command, cancellationToken);
    }

    public async Task SendToAllTilesAsync(BridgeCommand command, CancellationToken cancellationToken = default)
    {
        foreach (var tile in ActiveTiles)
        {
            await WriteCommandAsync(tile.InboxPath, command with { Id = $"{command.Id}-{tile.BridgeId}" }, cancellationToken);
        }
    }

    private string GetInboxPath(string bridgeId)
    {
        return Path.Combine(_mistRoot, "Content", "Mods", "LOManagerBridge", "Inbox", $"{bridgeId}.json");
    }

    private static async Task WriteCommandAsync(string path, BridgeCommand command, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);

        var json = JsonSerializer.Serialize(command, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
        });

        var tempPath = $"{path}.tmp";
        await File.WriteAllTextAsync(tempPath, json, cancellationToken);
        File.Move(tempPath, path, overwrite: true);
    }

    private static string CreateBridgeId()
    {
        return $"tile-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}-{Guid.NewGuid():N}"[..38];
    }
}

public sealed record TileInstance(
    string BridgeId,
    string InboxPath,
    int? ProcessId,
    string? TileName,
    string? TileId);

public sealed record BridgeCommand(
    string Id,
    string Type,
    string Message,
    int Seconds,
    bool ShowChat = true,
    bool ShowWidget = false,
    bool ShowClock = false,
    string? CreatedUtc = null)
{
    public static BridgeCommand AdminMessage(string message)
    {
        return new BridgeCommand(
            Id: $"admin-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss-fff}",
            Type: "AdminMessage",
            Message: message,
            Seconds: 0,
            ShowChat: true,
            ShowWidget: false,
            ShowClock: false,
            CreatedUtc: DateTimeOffset.UtcNow.ToString("O"));
    }

    public static BridgeCommand RestartWarning(string message, int seconds)
    {
        return new BridgeCommand(
            Id: $"restart-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss-fff}",
            Type: "RestartWarning",
            Message: message,
            Seconds: seconds,
            ShowChat: true,
            ShowWidget: false,
            ShowClock: true,
            CreatedUtc: DateTimeOffset.UtcNow.ToString("O"));
    }
}
