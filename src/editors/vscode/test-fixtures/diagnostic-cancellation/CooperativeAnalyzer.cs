using System.Collections.Immutable;
using System.Globalization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

// Real project analyzer fixture for [DIAG-ANALYSIS-CANCELLATION].
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class CooperativeAnalyzer : DiagnosticAnalyzer
{
    private static int entered;
    private static readonly DiagnosticDescriptor Rule = new(
        "CANCEL0001", "Cooperative analysis", "Cooperative analysis", "Testing",
        DiagnosticSeverity.Warning, isEnabledByDefault: true);

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => [Rule];

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();
        context.RegisterSemanticModelAction(Check);
    }

    private static void Check(SemanticModelAnalysisContext context)
    {
        var marker = SignalPath(context);
        if (marker is null) return;
        var process = Environment.ProcessId.ToString(CultureInfo.InvariantCulture);
        Signal(marker + ".observed", process);
        if (!File.Exists(marker + ".arm") || Interlocked.Exchange(ref entered, 1) != 0) return;
        Signal(marker + ".entered", process);
        while (!context.CancellationToken.WaitHandle.WaitOne(20))
        {
            if (File.Exists(marker + ".release")) return;
        }
        Signal(marker + ".cancelled", process);
        context.CancellationToken.ThrowIfCancellationRequested();
    }

    private static void Signal(string target, string process)
    {
        var temporary = target + "." + Guid.NewGuid().ToString("N");
        File.WriteAllText(temporary, process);
        File.Move(temporary, target, overwrite: true);
    }

    private static string? SignalPath(SemanticModelAnalysisContext context)
    {
        var options = context.Options.AnalyzerConfigOptionsProvider.GetOptions(context.SemanticModel.SyntaxTree);
        return options.TryGetValue("sharplsp_cancellation_marker", out var marker)
            ? marker : Environment.GetEnvironmentVariable("SHARPLSP_ANALYZER_CANCELLATION_SIGNAL");
    }
}
