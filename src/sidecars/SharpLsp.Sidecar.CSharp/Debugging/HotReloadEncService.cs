using System.Collections;
using System.Collections.Immutable;
using System.Globalization;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Host;

namespace SharpLsp.Sidecar.CSharp.Debugging;

/// <summary>The outcome of one Edit-and-Continue emit. Implements [DEBUG-FEATURES-HOT-RELOAD].</summary>
/// <param name="Ready">True when Roslyn holds a pending update awaiting commit or discard.</param>
/// <param name="Updates">The emitted metadata/IL/PDB deltas, empty unless ready.</param>
/// <param name="Diagnostics">Rude-edit, syntax, and emit diagnostics.</param>
internal sealed record EncEmitResult(
    bool Ready,
    List<HotReloadDelta> Updates,
    List<Diagnostic> Diagnostics
);

/// <summary>
/// Reflection adapter over Roslyn's Edit-and-Continue engine.
///
/// Why reflection: Roslyn ships no public hot-reload API. The hosts Microsoft
/// controls reach it through `internal` ExternalAccess wrappers gated by
/// InternalsVisibleTo, and Microsoft.CodeAnalysis.Features 5.6.0 exposes only
/// `UnitTestingHotReloadService` — whose one-shot EmitSolutionUpdateAsync
/// commits or discards AT EMIT TIME. The two-phase contract of
/// [DEBUG-FEATURES-HOT-RELOAD] (emit, hand the deltas to the debuggee, commit
/// only once the runtime confirmed them, discard otherwise) needs the
/// underlying `IEditAndContinueService` members the wrapper hides. Every
/// lookup fails fast (`MissingMethodException`/`MissingFieldException`) on a
/// Roslyn upgrade instead of degrading silently, and the sidecar is neither
/// trimmed nor AOT-published, so nothing here is stripped at build time.
/// </summary>
internal sealed class HotReloadEncService
{
    private const string WrapperTypeName =
        "Microsoft.CodeAnalysis.ExternalAccess.UnitTesting.Api.UnitTestingHotReloadService, Microsoft.CodeAnalysis.Features";

    private const BindingFlags Anything =
        BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;

    private readonly object _wrapper;
    private readonly MethodInfo _end;
    private readonly object _encService;
    private readonly object? _sessionId;
    private readonly object? _spanProvider;
    private readonly object? _emptyRunningProjects;
    private readonly MethodInfo _emit;
    private readonly MethodInfo _commit;
    private readonly MethodInfo _discard;

    private HotReloadEncService(object wrapper, MethodInfo end, object encService)
    {
        _wrapper = wrapper;
        _end = end;
        _encService = encService;
        var contract = EncContract(encService);
        _emit = RequiredMethod(contract, "EmitSolutionUpdateAsync");
        _commit = RequiredMethod(contract, "CommitSolutionUpdate");
        _discard = RequiredMethod(contract, "DiscardSolutionUpdate");
        var wrapperType = wrapper.GetType();
        _sessionId = RequiredField(wrapperType, "_sessionId").GetValue(wrapper);
        _spanProvider = RequiredField(wrapperType, "s_solutionActiveStatementSpanProvider")
            .GetValue(null);
        _emptyRunningProjects = RequiredField(_emit.GetParameters()[2].ParameterType, "Empty")
            .GetValue(null);
    }

    /// <summary>Start one EnC session over the baseline solution.</summary>
    public static async Task<HotReloadEncService> StartAsync(
        HostWorkspaceServices services,
        Solution solution,
        ImmutableArray<string> capabilities,
        CancellationToken ct
    )
    {
        var wrapperType = Type.GetType(WrapperTypeName, throwOnError: true)!;
        var wrapper =
            Activator.CreateInstance(wrapperType, Anything, binder: null, [services], culture: null)
            ?? throw new InvalidOperationException($"Could not construct {wrapperType.FullName}.");
        var start = RequiredMethod(wrapperType, "StartSessionAsync");
        _ = await AwaitReflectedAsync(
                start.Invoke(wrapper, [solution, capabilities, ct])
                    ?? throw new InvalidOperationException("StartSessionAsync returned no task.")
            )
            .ConfigureAwait(false);
        var encService =
            RequiredField(wrapperType, "_encService").GetValue(wrapper)
            ?? throw new InvalidOperationException("The Edit-and-Continue service is missing.");
        return new HotReloadEncService(
            wrapper,
            RequiredMethod(wrapperType, "EndSession"),
            encService
        );
    }

    /// <summary>Emit deltas for the candidate WITHOUT committing Roslyn's baseline.</summary>
    public async Task<EncEmitResult> EmitAsync(Solution candidate, CancellationToken ct)
    {
        var invocation =
            _emit.Invoke(
                _encService,
                [_sessionId, candidate, _emptyRunningProjects, _spanProvider, ct]
            ) ?? throw new InvalidOperationException("EmitSolutionUpdateAsync returned no task.");
        var results =
            await AwaitReflectedAsync(invocation).ConfigureAwait(false)
            ?? throw new InvalidOperationException("EmitSolutionUpdateAsync returned no results.");
        var moduleUpdates = RequiredProperty(results, "ModuleUpdates");
        var ready = string.Equals(
            RequiredProperty(moduleUpdates, "Status").ToString(),
            "Ready",
            StringComparison.Ordinal
        );
        return new EncEmitResult(ready, ReadUpdates(moduleUpdates), ReadDiagnostics(results));
    }

    /// <summary>Commit the pending update: the debuggee confirmed the deltas.</summary>
    public void Commit()
    {
        _ = _commit.Invoke(_encService, [_sessionId]);
    }

    /// <summary>Discard the pending update: the debuggee never applied the deltas.</summary>
    public void Discard()
    {
        _ = _discard.Invoke(_encService, [_sessionId]);
    }

    /// <summary>End the EnC session.</summary>
    public void End()
    {
        _ = _end.Invoke(_wrapper, null);
    }

    private static Type EncContract(object encService)
    {
        return encService
                .GetType()
                .GetInterfaces()
                .FirstOrDefault(candidate =>
                    string.Equals(
                        candidate.Name,
                        "IEditAndContinueService",
                        StringComparison.Ordinal
                    )
                )
            ?? throw new MissingMethodException(
                encService.GetType().FullName,
                "IEditAndContinueService"
            );
    }

    private static List<HotReloadDelta> ReadUpdates(object moduleUpdates)
    {
        var updates = (IEnumerable)RequiredProperty(moduleUpdates, "Updates");
        return [.. updates.Cast<object>().Select(ToDelta)];
    }

    private static HotReloadDelta ToDelta(object update)
    {
        return new HotReloadDelta
        {
            ModuleId = ((Guid)RequiredProperty(update, "Module")).ToString("D"),
            MetadataDelta = Base64Property(update, "MetadataDelta"),
            IlDelta = Base64Property(update, "ILDelta"),
            PdbDelta = Base64Property(update, "PdbDelta"),
        };
    }

    private static List<Diagnostic> ReadDiagnostics(object results)
    {
        var method =
            results.GetType().GetMethod("GetAllDiagnostics", Anything)
            ?? throw new MissingMethodException(results.GetType().FullName, "GetAllDiagnostics");
        var diagnostics = (IEnumerable)(
            method.Invoke(results, null)
            ?? throw new InvalidOperationException("GetAllDiagnostics returned nothing.")
        );
        return [.. diagnostics.Cast<Diagnostic>()];
    }

    /// <summary>Render one diagnostic as the wire's "ID: message" line.</summary>
    public static string Render(Diagnostic diagnostic)
    {
        return $"{diagnostic.Id}: {diagnostic.GetMessage(CultureInfo.InvariantCulture)}";
    }

    private static async Task<object?> AwaitReflectedAsync(object awaitable)
    {
        if (awaitable is Task task)
        {
            await task.ConfigureAwait(false);
            return task.GetType().GetProperty("Result")?.GetValue(task);
        }

        var asTask =
            awaitable.GetType().GetMethod("AsTask")
            ?? throw new MissingMethodException(awaitable.GetType().FullName, "AsTask");
        var converted = (Task)asTask.Invoke(awaitable, null)!;
        await converted.ConfigureAwait(false);
        return converted.GetType().GetProperty("Result")?.GetValue(converted);
    }

    private static object RequiredProperty(object target, string name)
    {
        var property =
            target.GetType().GetProperty(name, Anything)
            ?? throw new MissingMemberException(target.GetType().FullName, name);
        return property.GetValue(target)
            ?? throw new InvalidOperationException($"{name} was unexpectedly null.");
    }

    private static string Base64Property(object update, string name)
    {
        var bytes = (IEnumerable<byte>)RequiredProperty(update, name);
        return Convert.ToBase64String([.. bytes]);
    }

    private static MethodInfo RequiredMethod(Type type, string name)
    {
        return type.GetMethod(name, Anything)
            ?? throw new MissingMethodException(type.FullName, name);
    }

    private static FieldInfo RequiredField(Type type, string name)
    {
        return type.GetField(name, Anything)
            ?? throw new MissingFieldException(type.FullName, name);
    }
}
