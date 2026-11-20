namespace SharpLsp.Sidecar.Common;

/// <summary>
/// Where each SharpLsp-owned analyzer rule is documented: the diagnostic's
/// <c>codeDescription.href</c>, so the editor links the code to its explanation.
/// One place for both sidecars. [ANALYZERS-DIAGNOSTICS]
/// </summary>
public static class RuleDocumentation
{
    /// <summary>The dead-code rules <c>SLSPC0101</c> (C#) and <c>SLSPF0101</c> (F#).</summary>
    public const string DeadCode = "https://sharplsp.dev/docs/diagnostics/#dead-code";

    /// <summary>The documentation of <paramref name="code"/>; empty for a rule with none.</summary>
    public static string For(string code)
    {
        return code is "SLSPC0101" or "SLSPF0101" ? DeadCode : "";
    }
}
