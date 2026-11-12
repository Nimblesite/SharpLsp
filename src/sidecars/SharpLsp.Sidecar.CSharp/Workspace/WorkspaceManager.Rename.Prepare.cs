using Microsoft.CodeAnalysis.Text;
using PrepareRenameQueryResult = Outcome.Result<
    SharpLsp.Sidecar.CSharp.PrepareRenameResult,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    private static PrepareRenameResult PrepareResult(RenameTarget? target)
    {
        if (target is null)
        {
            return new PrepareRenameResult(false, 0, 0, 0, 0, "");
        }

        var span = target.Value.Text.Lines.GetLinePositionSpan(target.Value.Token.Span);
        return CreatePrepareResult(target.Value.Token.Text, span);
    }

    private static PrepareRenameResult CreatePrepareResult(string placeholder, LinePositionSpan span)
    {
        return new PrepareRenameResult(
            true, span.Start.Line, span.Start.Character, span.End.Line, span.End.Character, placeholder
        );
    }

    private static PrepareRenameQueryResult PrepareSuccess(PrepareRenameResult result)
    {
        return new PrepareRenameQueryResult.Ok<PrepareRenameResult, string>(result);
    }
}
