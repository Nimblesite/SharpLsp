using System.Collections;
using System.Collections.Immutable;
using System.Globalization;
using System.Reflection;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Debugging;

/// <summary>Owns Roslyn Edit-and-Continue baselines for active debug sessions.</summary>
internal sealed class HotReloadSessionRegistry
{
    private readonly Dictionary<Guid, HotReloadSession> _sessions = [];
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
            "update" => await UpdateAsync(
                    ParseSession(request.SessionId),
                    Required(request.FilePath, "filePath"),
                    Required(request.NewText, "newText"),
                    ct
                )
                .ConfigureAwait(false),
            "end" => await EndAsync(ParseSession(request.SessionId)).ConfigureAwait(false),
            _ => throw new InvalidOperationException(
                $"Unknown hot reload action '{request.Action}'."
            ),
        };
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
        }

        return session.Response("started", [], []);
    }

    private async Task<HotReloadResponse> UpdateAsync(
        Guid id,
        string filePath,
        string newText,
        CancellationToken ct
    )
    {
        var session = Find(id);
        return await session.UpdateAsync(filePath, newText, ct).ConfigureAwait(false);
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

    private sealed class HotReloadSession : IAsyncDisposable
    {
        private const string ServiceTypeName =
            "Microsoft.CodeAnalysis.ExternalAccess.UnitTesting.Api.UnitTestingHotReloadService, Microsoft.CodeAnalysis.Features";

        private readonly MSBuildWorkspace _workspace;
        private readonly object _service;
        private readonly MethodInfo _emit;
        private readonly MethodInfo _end;
        private readonly SemaphoreSlim _gate = new(1, 1);
        private Solution _solution;
        private bool _ended;

        public Guid Id { get; } = Guid.NewGuid();
        public string AssemblyName { get; }

        private HotReloadSession(
            MSBuildWorkspace workspace,
            Solution solution,
            string assemblyName,
            object service,
            MethodInfo emit,
            MethodInfo end
        )
        {
            _workspace = workspace;
            _solution = solution;
            AssemblyName = assemblyName;
            _service = service;
            _emit = emit;
            _end = end;
        }

        public static async Task<HotReloadSession> CreateAsync(
            string projectPath,
            ImmutableArray<string> capabilities,
            CancellationToken ct
        )
        {
            var workspace = MSBuildWorkspace.Create(
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["Configuration"] = "Debug",
                }
            );
            try
            {
                var project = await workspace
                    .OpenProjectAsync(CanonicalPath(projectPath), cancellationToken: ct)
                    .ConfigureAwait(false);
                var solution = project.Solution;
                foreach (var loadedProject in project.Solution.Projects)
                {
                    if (loadedProject.OutputFilePath is { } assemblyPath)
                    {
                        solution = solution.WithProjectCompilationOutputInfo(
                            loadedProject.Id,
                            loadedProject.CompilationOutputInfo.WithAssemblyPath(assemblyPath)
                        );
                    }
                }

                project = solution.GetProject(project.Id)!;
                var serviceType = Type.GetType(ServiceTypeName, throwOnError: true)!;
                var service = Activator.CreateInstance(
                    serviceType,
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
                    binder: null,
                    args: [workspace.Services],
                    culture: null
                )!;
                var start = RequiredMethod(serviceType, "StartSessionAsync");
                _ = await InvokeTaskAsync(start, service, [project.Solution, capabilities, ct])
                    .ConfigureAwait(false);
                return new HotReloadSession(
                    workspace,
                    project.Solution,
                    project.AssemblyName ?? project.Name,
                    service,
                    RequiredMethod(serviceType, "EmitSolutionUpdateAsync"),
                    RequiredMethod(serviceType, "EndSession")
                );
            }
            catch
            {
                workspace.Dispose();
                throw;
            }
        }

        public async Task<HotReloadResponse> UpdateAsync(
            string filePath,
            string newText,
            CancellationToken ct
        )
        {
            await _gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                ObjectDisposedException.ThrowIf(_ended, this);
                var document = FindDocument(_solution, filePath);
                var candidate = _solution.WithDocumentText(
                    document.Id,
                    SourceText.From(newText, Encoding.UTF8)
                );
                var result = await InvokeTaskAsync(_emit, _service, [candidate, true, ct])
                    .ConfigureAwait(false);
                var updates = ReadUpdates(result);
                var diagnostics = ReadDiagnostics(result);
                if (diagnostics.Count > 0)
                {
                    return Response("restartRequired", [], diagnostics);
                }

                _solution = candidate;
                return Response("applied", updates, []);
            }
            finally
            {
                _ = _gate.Release();
            }
        }

        public HotReloadResponse Response(
            string status,
            List<HotReloadDelta> updates,
            List<string> diagnostics
        )
        {
            return new HotReloadResponse
            {
                Status = status,
                SessionId = Id.ToString("D"),
                AssemblyName = AssemblyName,
                Updates = updates,
                Diagnostics = diagnostics,
            };
        }

        public async ValueTask DisposeAsync()
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                try
                {
                    if (!_ended)
                    {
                        _ = _end.Invoke(_service, null);
                    }
                }
                finally
                {
                    _ended = true;
                    _workspace.Dispose();
                }
            }
            finally
            {
                _ = _gate.Release();
                _gate.Dispose();
            }
        }

        private static Document FindDocument(Solution solution, string filePath)
        {
            var fullPath = CanonicalPath(filePath);
            return solution
                    .Projects.SelectMany(project => project.Documents)
                    .FirstOrDefault(document => PathsEqual(document.FilePath, fullPath))
                ?? throw new InvalidOperationException(
                    $"Hot reload document not found: {filePath}"
                );
        }

        private static bool PathsEqual(string? left, string right)
        {
            return left is not null
                && string.Equals(
                    CanonicalPath(left),
                    right,
                    OperatingSystem.IsWindows()
                        ? StringComparison.OrdinalIgnoreCase
                        : StringComparison.Ordinal
                );
        }

        private static string CanonicalPath(string path)
        {
            var fullPath = Path.GetFullPath(path);
            if (OperatingSystem.IsWindows())
            {
                return fullPath;
            }

            var root = Path.GetPathRoot(fullPath)!;
            var current = root;
            foreach (
                var segment in fullPath[root.Length..]
                    .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
            )
            {
                current = Path.Combine(current, segment);
                FileSystemInfo entry = Directory.Exists(current)
                    ? new DirectoryInfo(current)
                    : new FileInfo(current);
                if (entry.ResolveLinkTarget(returnFinalTarget: true) is { } target)
                {
                    current = target.FullName;
                }
            }

            return current;
        }

        private static MethodInfo RequiredMethod(Type type, string name)
        {
            return type.GetMethod(
                    name,
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
                ) ?? throw new MissingMethodException(type.FullName, name);
        }

        private static async Task<object?> InvokeTaskAsync(
            MethodInfo method,
            object target,
            object?[] arguments
        )
        {
            var task = (Task)(
                method.Invoke(target, arguments)
                ?? throw new InvalidOperationException($"{method.Name} returned no task.")
            );
            await task.ConfigureAwait(false);
            return task.GetType().GetProperty("Result")?.GetValue(task);
        }

        private static List<HotReloadDelta> ReadUpdates(object? result)
        {
            var updates = TupleItem(result, "Item1");
            var converted = new List<HotReloadDelta>();
            foreach (var update in (IEnumerable)updates)
            {
                var type = update.GetType();
                converted.Add(
                    new HotReloadDelta
                    {
                        ModuleId = (
                            (Guid)RequiredField(type, "ModuleId").GetValue(update)!
                        ).ToString("D"),
                        MetadataDelta = Base64Field(type, update, "MetadataDelta"),
                        IlDelta = Base64Field(type, update, "ILDelta"),
                        PdbDelta = Base64Field(type, update, "PdbDelta"),
                    }
                );
            }
            return converted;
        }

        private static List<string> ReadDiagnostics(object? result)
        {
            var diagnostics = (IEnumerable)TupleItem(result, "Item2");
            return
            [
                .. diagnostics
                    .Cast<Diagnostic>()
                    .Select(diagnostic =>
                        $"{diagnostic.Id}: {diagnostic.GetMessage(CultureInfo.InvariantCulture)}"
                    ),
            ];
        }

        private static object TupleItem(object? tuple, string name)
        {
            return tuple?.GetType().GetField(name)?.GetValue(tuple)
                ?? throw new InvalidOperationException($"Hot reload result omitted {name}.");
        }

        private static FieldInfo RequiredField(Type type, string name)
        {
            return type.GetField(
                    name,
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
                ) ?? throw new MissingFieldException(type.FullName, name);
        }

        private static string Base64Field(Type type, object update, string name)
        {
            var bytes = (IEnumerable<byte>)RequiredField(type, name).GetValue(update)!;
            return Convert.ToBase64String(bytes.ToArray());
        }
    }
}
