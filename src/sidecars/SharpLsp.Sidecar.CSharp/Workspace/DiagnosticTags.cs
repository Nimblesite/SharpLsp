using Microsoft.CodeAnalysis;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// The LSP tags of a C# finding: the editor greys out unnecessary code and strikes through
/// a use of an obsolete symbol. Implements [DIAG-CATEGORIES-TAGS].
/// </summary>
internal static class DiagnosticTags
{
    /// <summary>LSP <c>DiagnosticTag.Unnecessary</c>.</summary>
    internal const int Unnecessary = 1;

    /// <summary>LSP <c>DiagnosticTag.Deprecated</c>.</summary>
    internal const int Deprecated = 2;

    /// <summary>The compiler's findings on a use of an <c>[Obsolete]</c> symbol.</summary>
    private static readonly HashSet<string> ObsoleteUses = ["CS0612", "CS0618", "CS0619"];

    /// <summary>
    /// The tags of <paramref name="diagnostic"/>: unnecessary when its rule says so through the
    /// descriptor's <see cref="WellKnownDiagnosticTags.Unnecessary"/> custom tag, deprecated
    /// when it reports a use of an obsolete symbol.
    /// </summary>
    public static List<int> Of(Diagnostic diagnostic)
    {
        return
        [
            .. diagnostic.Descriptor.CustomTags.Contains(WellKnownDiagnosticTags.Unnecessary)
                ? [Unnecessary]
                : Array.Empty<int>(),
            .. ObsoleteUses.Contains(diagnostic.Id) ? [Deprecated] : Array.Empty<int>(),
        ];
    }
}
