using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using Serilog;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// One analyzer reference Roslyn refused to load — the failure the SDK build
/// reports as <c>CS9057</c>/<c>CS8032</c> and the sidecar must never drop
/// silently ([DIAG-CATEGORIES-ANALYZER]).
/// </summary>
internal sealed record AnalyzerLoadFailure(
    string AnalyzerPath,
    string Code,
    string Kind,
    string Message,
    Version? ReferencedCompilerVersion
)
{
    /// <summary>
    /// The failure as a project-level warning at the project URI, zero-length
    /// range at line zero — where the project's other ownerless findings live.
    /// </summary>
    public DiagnosticResult ToDiagnostic(string projectPath)
    {
        return DocumentPosition.ToDiagnostic(
            new FileLinePositionSpan(projectPath, new LinePosition(0, 0), new LinePosition(0, 0)),
            Code,
            "Warning", // The SDK build reports CS9057/CS8032 as warnings.
            Message
        );
    }
}

/// <summary>
/// Observes <see cref="AnalyzerFileReference.AnalyzerLoadFailed"/> for every
/// analyzer reference the sidecar loads, so a reference Roslyn refuses to load —
/// usually one built against a newer Roslyn than the sidecar hosts — is logged
/// as a structured warning and reported at its project instead of vanishing
/// ([DIAG-CATEGORIES-ANALYZER]). Roslyn raises the event only on the first
/// <see cref="AnalyzerFileReference.GetAnalyzers"/> call per reference, so every
/// load flows through <see cref="GetAnalyzers"/> and each failure record lives
/// exactly as long as its reference.
/// </summary>
internal static class AnalyzerLoadMonitor
{
    /// <summary>The SDK build's code for an analyzer referencing a newer compiler.</summary>
    public const string NewerCompilerCode = "CS9057";

    /// <summary>The SDK build's code for an analyzer that cannot be created or loaded.</summary>
    public const string UnloadableAnalyzerCode = "CS8032";

    private static readonly ConditionalWeakTable<AnalyzerFileReference, FailureLog> Logs = new();

    /// <summary>
    /// The analyzers of one reference, with every load failure recorded — the
    /// single loading door for project analyzer references.
    /// </summary>
    public static ImmutableArray<DiagnosticAnalyzer> GetAnalyzers(
        AnalyzerReference reference,
        string language
    )
    {
        if (reference is not AnalyzerFileReference file)
        {
            return reference.GetAnalyzers(language);
        }
        // The log subscribes to AnalyzerLoadFailed before the first load, whose
        // failure Roslyn raises once and never again.
        _ = Logs.GetValue(file, Attach);
        return FailureLog.Load(file, language);
    }

    /// <summary>
    /// Every load failure among the project's analyzer references. Each
    /// reference's load is forced, so a project pull can never miss one: a
    /// project whose analyzers failed to load never answers clean and empty.
    /// </summary>
    public static ImmutableArray<AnalyzerLoadFailure> ProjectFailures(Project project)
    {
        return
        [
            .. project
                .AnalyzerReferences.OfType<AnalyzerFileReference>()
                .SelectMany(file => Logs.GetValue(file, Attach).Force(file)),
        ];
    }

    private static FailureLog Attach(AnalyzerFileReference reference)
    {
        return new FailureLog(reference);
    }

    /// <summary>The failures of one reference, recorded for the reference's lifetime.</summary>
    private sealed class FailureLog
    {
        private readonly Lock _gate = new();
        private readonly List<AnalyzerLoadFailure> _failures = [];
        private readonly string _path;

        public FailureLog(AnalyzerFileReference reference)
        {
            _path = reference.FullPath ?? "";
            reference.AnalyzerLoadFailed += (_, args) => Record(args);
        }

        public static ImmutableArray<DiagnosticAnalyzer> Load(
            AnalyzerFileReference file,
            string language
        )
        {
            return file.GetAnalyzers(language);
        }

        public ImmutableArray<AnalyzerLoadFailure> Force(AnalyzerFileReference file)
        {
            _ = file.GetAnalyzers(LanguageNames.CSharp);
            lock (_gate)
            {
                return [.. _failures];
            }
        }

        private void Record(AnalyzerLoadFailureEventArgs args)
        {
            if (args.ErrorCode is AnalyzerLoadFailureEventArgs.FailureErrorCode.None)
            {
                return;
            }
            var failure = ToFailure(args);
            Warn(failure);
            lock (_gate)
            {
                AddUnseen(failure);
            }
        }

        private void AddUnseen(AnalyzerLoadFailure failure)
        {
            if (
                !_failures.Exists(recorded =>
                    recorded.Code == failure.Code && recorded.Message == failure.Message
                )
            )
            {
                _failures.Add(failure);
            }
        }

        private AnalyzerLoadFailure ToFailure(AnalyzerLoadFailureEventArgs args)
        {
            return
                args.ErrorCode
                == AnalyzerLoadFailureEventArgs.FailureErrorCode.ReferencesNewerCompiler
                ? NewerCompilerFailure(args)
                : UnloadableFailure(args);
        }

        private AnalyzerLoadFailure NewerCompilerFailure(AnalyzerLoadFailureEventArgs args)
        {
            var message =
                $"Analyzer assembly '{_path}' references compiler version '{args.ReferencedCompilerVersion}', newer than the running compiler version '{RunningCompilerVersion()}'; its analyzer diagnostics were not run.";
            return new AnalyzerLoadFailure(
                _path,
                NewerCompilerCode,
                args.ErrorCode.ToString(),
                message,
                args.ReferencedCompilerVersion
            );
        }

        private AnalyzerLoadFailure UnloadableFailure(AnalyzerLoadFailureEventArgs args)
        {
            var reason = args.Message is { Length: > 0 }
                ? args.Message
                : args.Exception?.Message ?? args.ErrorCode.ToString();
            var message =
                $"Analyzer assembly '{_path}' could not be loaded ({args.ErrorCode}): {reason} Its analyzer diagnostics were not run.";
            return new AnalyzerLoadFailure(
                _path,
                UnloadableAnalyzerCode,
                args.ErrorCode.ToString(),
                message,
                null
            );
        }

        private static void Warn(AnalyzerLoadFailure failure)
        {
            if (failure.ReferencedCompilerVersion is { } referenced)
            {
                Log.Warning(
                    "Analyzer reference {AnalyzerPath} references compiler {ReferencedCompilerVersion}, newer than the running compiler {RunningCompilerVersion}; its analyzer diagnostics are unavailable",
                    failure.AnalyzerPath,
                    referenced,
                    RunningCompilerVersion()
                );
            }
            else
            {
                Log.Warning(
                    "Analyzer reference {AnalyzerPath} failed to load ({FailureKind}); its analyzer diagnostics are unavailable: {Reason}",
                    failure.AnalyzerPath,
                    failure.Kind,
                    failure.Message
                );
            }
        }
    }

    private static Version RunningCompilerVersion()
    {
        return typeof(Compilation).Assembly.GetName().Version ?? new Version();
    }
}
