using Serilog;

namespace SharpLsp.Sidecar.CSharp.Debugging;

/// <summary>
/// Owns Roslyn Edit-and-Continue baselines for active debug sessions.
/// Implements [DEBUG-FEATURES-HOT-RELOAD]: one <see cref="HotReloadSession" />
/// per debug session, addressed by the id handed out at start. The registry is
/// capped: a client that vanished mid-start can never leak workspaces beyond
/// <paramref name="maxSessions" /> — the oldest session is evicted first.
/// </summary>
/// <param name="maxSessions">Upper bound on concurrently held baselines.</param>
internal sealed class HotReloadSessionRegistry(int maxSessions = 4)
{
    private readonly Dictionary<Guid, HotReloadSession> _sessions = [];
    private readonly List<Guid> _order = [];
    private readonly Lock _sync = new();

    public async Task<HotReloadResponse> HandleAsync(HotReloadRequest request, CancellationToken ct)
    {
        return request.Action switch
        {
            "start" => await StartAsync(
                    Required(request.ProjectPath, "projectPath"),
                    request.Capabilities ?? ["Baseline"],
                    ct
                )
                .ConfigureAwait(false),
            "update" => await Find(ParseSession(request.SessionId))
                .UpdateAsync(DocumentsOf(request), ct)
                .ConfigureAwait(false),
            "commit" => await Find(ParseSession(request.SessionId))
                .CommitAsync()
                .ConfigureAwait(false),
            "discard" => await Find(ParseSession(request.SessionId))
                .DiscardAsync()
                .ConfigureAwait(false),
            "end" => await EndAsync(ParseSession(request.SessionId)).ConfigureAwait(false),
            _ => throw new InvalidOperationException(
                $"Unknown hot reload action '{request.Action}'."
            ),
        };
    }

    /// <summary>The saved batch: the multi-document list, or the legacy single file.</summary>
    private static List<HotReloadDocument> DocumentsOf(HotReloadRequest request)
    {
        return request.Documents is { Count: > 0 }
            ? request.Documents
            :
            [
                new HotReloadDocument
                {
                    FilePath = Required(request.FilePath, "filePath"),
                    NewText = Required(request.NewText, "newText"),
                },
            ];
    }

    private async Task<HotReloadResponse> StartAsync(
        string projectPath,
        List<string> capabilities,
        CancellationToken ct
    )
    {
        var session = await HotReloadSession
            .CreateAsync(projectPath, [.. capabilities], ct)
            .ConfigureAwait(false);
        lock (_sync)
        {
            _sessions.Add(session.Id, session);
            _order.Add(session.Id);
        }

        await EvictBeyondCapAsync().ConfigureAwait(false);
        return session.Response("started", [], []);
    }

    /// <summary>Dispose whatever the cap pushed out, oldest first.</summary>
    private async Task EvictBeyondCapAsync()
    {
        foreach (var stale in TakeBeyondCap())
        {
            Log.Warning("Hot reload evicting stale session {Id}", stale.Id);
            await stale.DisposeAsync().ConfigureAwait(false);
        }
    }

    private List<HotReloadSession> TakeBeyondCap()
    {
        lock (_sync)
        {
            var evicted = new List<HotReloadSession>();
            while (_order.Count > maxSessions)
            {
                var oldest = _order[0];
                _order.RemoveAt(0);
                if (_sessions.Remove(oldest, out var stale))
                {
                    evicted.Add(stale);
                }
            }

            return evicted;
        }
    }

    private async Task<HotReloadResponse> EndAsync(Guid id)
    {
        HotReloadSession session;
        lock (_sync)
        {
            if (!_sessions.Remove(id, out session!))
            {
                throw new InvalidOperationException($"Unknown hot reload session '{id}'.");
            }

            _ = _order.Remove(id);
        }

        var response = session.Response("ended", [], []);
        await session.DisposeAsync().ConfigureAwait(false);
        return response;
    }

    private HotReloadSession Find(Guid id)
    {
        lock (_sync)
        {
            return _sessions.TryGetValue(id, out var session)
                ? session
                : throw new InvalidOperationException($"Unknown hot reload session '{id}'.");
        }
    }

    private static string Required(string? value, string name)
    {
        return string.IsNullOrWhiteSpace(value)
            ? throw new InvalidOperationException($"Hot reload requires '{name}'.")
            : value;
    }

    private static Guid ParseSession(string? value)
    {
        return Guid.TryParse(value, out var id)
            ? id
            : throw new InvalidOperationException("Hot reload requires a valid 'sessionId'.");
    }
}
