using Microsoft.CodeAnalysis.CodeActions;
using SharpLsp.Sidecar.Common.Messages;

namespace SharpLsp.Sidecar.CSharp.Workspace.ImportFixes;

/// <summary>
/// One import quick fix: the action that makes the source edit, the reference the host adds
/// first (null when the name is in reach), and whether it is the preferred fix.
/// [REFACTOR-IMPORT]
/// </summary>
internal sealed record ImportFix(CodeAction Action, ReferenceImport? Reference, bool Preferred)
{
    /// <summary>A fix whose edit alone brings the name into scope.</summary>
    public static ImportFix InReach(CodeAction action, bool preferred = false)
    {
        return new ImportFix(action, null, preferred);
    }
}
