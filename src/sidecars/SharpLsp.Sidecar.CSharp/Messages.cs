using MessagePack;
using SharpLsp.Sidecar.Common.Messages;

namespace SharpLsp.Sidecar.CSharp;

// ── Existing Request/Response Types ──────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed record DidChangeRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] string NewText
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record PositionRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] int Line,
    [property: Key(2)] int Character
);

/// <param name="Label">The item's display label.</param>
/// <param name="Kind">The item's kind, as the host maps it to an LSP <c>CompletionItemKind</c>.</param>
/// <param name="Detail">The item's detail line, such as an import hint or a signature.</param>
/// <param name="InsertText">The text the editor inserts when the item is accepted.</param>
/// <param name="Index">The item's position in the completion list, for <c>completionItem/resolve</c>.</param>
/// <param name="TextEdit">
/// Edit that REPLACES the identifier span at the caret when the item is
/// accepted. Without it the editor appends <see cref="InsertText"/> to the
/// trigger text, duplicating the member name (GitHub #178).
/// Implements [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT].
/// </param>
/// <param name="Documentation">Markdown documentation for the item, when it has any. [RAZOR-FEATURES-COMPLETION]</param>
/// <param name="SortText">The order an editor sorts the item in, when it is not the label's.</param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record CompletionItem(
    [property: Key(0)] string Label,
    [property: Key(1)] string Kind,
    [property: Key(2)] string? Detail,
    [property: Key(3)] string? InsertText,
    [property: Key(4)] int Index,
    [property: Key(5)] TextEditResult? TextEdit,
    [property: Key(6)] string? Documentation,
    [property: Key(7)] string? SortText
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record CompletionResolveRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] int Index
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record CompletionResolveResult(
    [property: Key(0)] List<TextEditResult> AdditionalEdits
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record HoverResult(
    [property: Key(0)] string Contents,
    [property: Key(1)] int? StartLine,
    [property: Key(2)] int? StartCharacter,
    [property: Key(3)] int? EndLine,
    [property: Key(4)] int? EndCharacter
);

/// <param name="FilePath">Absolute path of the file the location is in.</param>
/// <param name="Line">Zero-based start line.</param>
/// <param name="Character">Zero-based start character.</param>
/// <param name="EndLine">Zero-based end line.</param>
/// <param name="EndCharacter">Zero-based end character.</param>
/// <param name="Symbol">
/// For decompiled source of a symbol an F# project declares, the symbol's identity, so the
/// host can ask the F# sidecar for its F# declaration. [DEFINITION-CROSSLANG-IDENTITY]
/// </param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record LocationResult(
    [property: Key(0)] string FilePath,
    [property: Key(1)] int Line,
    [property: Key(2)] int Character,
    [property: Key(3)] int EndLine,
    [property: Key(4)] int EndCharacter,
    [property: Key(5)] RenameIdentityResultWire? Symbol
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record LocationListResult([property: Key(0)] List<LocationResult> Locations);

[MessagePackObject(AllowPrivate = true)]
internal sealed record ReferencesRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] int Line,
    [property: Key(2)] int Character,
    [property: Key(3)] bool IncludeDeclaration
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record DocumentHighlightResult(
    [property: Key(0)] int StartLine,
    [property: Key(1)] int StartCharacter,
    [property: Key(2)] int EndLine,
    [property: Key(3)] int EndCharacter,
    [property: Key(4)] int Kind
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record DocumentHighlightListResult(
    [property: Key(0)] List<DocumentHighlightResult> Highlights
);

/// <param name="FilePath">Absolute path of the file the diagnostic is in.</param>
/// <param name="StartLine">Zero-based start line.</param>
/// <param name="StartCharacter">Zero-based start character.</param>
/// <param name="EndLine">Zero-based end line.</param>
/// <param name="EndCharacter">Zero-based end character.</param>
/// <param name="Message">The diagnostic's message.</param>
/// <param name="Severity">The diagnostic's severity: <c>Error</c>, <c>Warning</c>, <c>Info</c> or <c>Hint</c>.</param>
/// <param name="Code">The rule id that reported the diagnostic.</param>
/// <param name="HelpLink">The rule's documentation link (descriptor <c>HelpLinkUri</c>), if any.</param>
/// <param name="Tags">LSP <c>DiagnosticTag</c> numbers: unnecessary, deprecated. [DIAG-CATEGORIES-TAGS]</param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record DiagnosticResult(
    [property: Key(0)] string FilePath,
    [property: Key(1)] int StartLine,
    [property: Key(2)] int StartCharacter,
    [property: Key(3)] int EndLine,
    [property: Key(4)] int EndCharacter,
    [property: Key(5)] string Message,
    [property: Key(6)] string Severity,
    [property: Key(7)] string Code,
    [property: Key(8)] string HelpLink,
    [property: Key(9)] List<int> Tags
);

/// <summary>
/// <c>analyzers/configure</c> request: the analyzer flags the host reads from
/// <c>sharplsp.toml</c> <c>[analyzers]</c> and pushes after <c>workspace/open</c>.
/// Mirrors the F# sidecar's <c>AnalyzerConfigRequest</c> wire layout.
/// </summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed record AnalyzerConfigRequest(
    [property: Key(0)] bool DeadCode,
    [property: Key(1)] bool Monorepo
);

// ── Code Action Types ────────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed record CodeActionRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] int StartLine,
    [property: Key(2)] int StartCharacter,
    [property: Key(3)] int EndLine,
    [property: Key(4)] int EndCharacter
);

/// <param name="Id">The action's index in the offered list, for <c>codeAction/resolve</c>.</param>
/// <param name="Title">The title the editor shows.</param>
/// <param name="Kind">The LSP <c>CodeActionKind</c>, such as <c>quickfix</c> or <c>refactor</c>.</param>
/// <param name="IsPreferred">Whether the editor highlights the action as the preferred fix.</param>
/// <param name="Reference">
/// The reference the action adds before its import; null for an edit action.
/// [REFACTOR-IMPORT-REFERENCE]
/// </param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record CodeActionItem(
    [property: Key(0)] int Id,
    [property: Key(1)] string Title,
    [property: Key(2)] string Kind,
    [property: Key(3)] bool IsPreferred,
    [property: Key(4)] ReferenceImport? Reference
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record CodeActionResolveRequest([property: Key(0)] int Id);

[MessagePackObject(AllowPrivate = true)]
internal sealed record TextEditResult(
    [property: Key(0)] int StartLine,
    [property: Key(1)] int StartCharacter,
    [property: Key(2)] int EndLine,
    [property: Key(3)] int EndCharacter,
    [property: Key(4)] string NewText
);

/// <param name="FilePath">Absolute path of the file the edits apply to.</param>
/// <param name="Edits">The edits to apply to the file.</param>
/// <param name="Create">Whether the edit creates the file: it holds the new file's whole text. [RAZOR-CODE-ACTIONS]</param>
/// <param name="RenameTo">The new absolute path when this edit renames the file. [REFACTOR-MOVE-TYPE-RENAME-FILE]</param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record DocumentEditResult(
    [property: Key(0)] string FilePath,
    [property: Key(1)] List<TextEditResult> Edits,
    [property: Key(2)] bool Create,
    [property: Key(3)] string? RenameTo
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record WorkspaceEditResult(
    [property: Key(0)] List<DocumentEditResult> DocumentChanges
);

// ── Formatting Types ─────────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed record RangeFormattingRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] int StartLine,
    [property: Key(2)] int StartCharacter,
    [property: Key(3)] int EndLine,
    [property: Key(4)] int EndCharacter
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record OnTypeFormattingRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] int Line,
    [property: Key(2)] int Character
);

// ── Semantic Tokens Types ────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed record SemanticTokensResult([property: Key(0)] int[] Data);

// ── Inlay Hint Types ─────────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed record InlayHintRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] int StartLine,
    [property: Key(2)] int EndLine
);

/// <param name="Line">Zero-based line the hint sits on.</param>
/// <param name="Character">Zero-based character the hint sits at.</param>
/// <param name="Label">The hint's text, such as <c>name:</c> or <c>: int</c>.</param>
/// <param name="Kind">The hint's kind: 1=Type, 2=Parameter.</param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record InlayHintResult(
    [property: Key(0)] int Line,
    [property: Key(1)] int Character,
    [property: Key(2)] string Label,
    [property: Key(3)] int Kind
);

// ── Code Lens Types ──────────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed record CodeLensResult(
    [property: Key(0)] int Line,
    [property: Key(1)] int Character,
    [property: Key(2)] string Title
);

// ── Hierarchy Types (call + type hierarchy share this layout) ────

/// <summary>
/// One call- or type-hierarchy item. Both hierarchies answer `prepare` with the
/// same positional shape, so one type serves both — as `HierarchyItemResult`
/// does in the F# sidecar.
/// </summary>
[MessagePackObject(AllowPrivate = true)]
internal class HierarchyItem
{
    [Key(0)]
    public string Name { get; set; } = "";

    [Key(1)]
    public string Kind { get; set; } = "";

    [Key(2)]
    public string FilePath { get; set; } = "";

    [Key(3)]
    public int Line { get; set; }

    [Key(4)]
    public int Character { get; set; }

    [Key(5)]
    public int EndLine { get; set; }

    [Key(6)]
    public int EndCharacter { get; set; }
}

/// <summary>One range at which a call appears, inside the item that reports it.</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed record CallSiteResult(
    [property: Key(0)] int Line,
    [property: Key(1)] int Character,
    [property: Key(2)] int EndLine,
    [property: Key(3)] int EndCharacter
);

/// <summary>
/// One incoming or outgoing call: the <see cref="HierarchyItem"/> at keys 0-6,
/// then the ranges the call appears at.
/// </summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class CallHierarchyCallResult : HierarchyItem
{
    /// <summary>
    /// Every range at which the call appears, per LSP 3.17 `fromRanges`.
    /// </summary>
    [Key(7)]
    public List<CallSiteResult> FromRanges { get; set; } = [];
}

// ── Rename Types ──────────────────────────────────────────────────

// Implements [RENAME-PREPARE] and [RENAME-APPLY]

[MessagePackObject(AllowPrivate = true)]
internal sealed record RenameRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] int Line,
    [property: Key(2)] int Character,
    [property: Key(3)] string NewName
);

[MessagePackObject(AllowPrivate = true)]
internal sealed record PrepareRenameResult(
    [property: Key(0)] bool CanRename,
    [property: Key(1)] int StartLine,
    [property: Key(2)] int StartCharacter,
    [property: Key(3)] int EndLine,
    [property: Key(4)] int EndCharacter,
    [property: Key(5)] string Placeholder
);

// ── Unused Package Detection ──────────────────────────────────────

// Implements [PKG-UNUSED-DETECT-CS]: assembly-level reference usage for a
// project, consumed by the Rust host's [PKG-UNUSED-MAP] package mapping.
/// <param name="UsedPaths">Absolute paths of assemblies actually used by the compilation.</param>
/// <param name="AllPaths">Absolute paths of every assembly referenced by the compilation.</param>
/// <param name="PackagesRoot">NuGet global packages folder used to map assemblies to packages.</param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record ReferenceUsageResult(
    [property: Key(0)] string[] UsedPaths,
    [property: Key(1)] string[] AllPaths,
    [property: Key(2)] string PackagesRoot
);

// ── Package Reference Editing (GitHub #4, [NUGET-XML-DOM]) ─────────

// Add/remove a package entry in an MSBuild project file via the real MSBuild
// document model (ProjectRootElement) instead of line-oriented text splicing.
/// <param name="FilePath">Absolute path to the .csproj / .fsproj / .props file to edit.</param>
/// <param name="PackageId">The package id (the item's <c>Include</c>).</param>
/// <param name="Version">Version to write (ignored for removal / <c>referenceNoVersion</c>).</param>
/// <param name="ElementKind"><c>reference</c> | <c>referenceNoVersion</c> | <c>version</c>.</param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record PackageEditRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] string PackageId,
    [property: Key(2)] string Version,
    [property: Key(3)] string ElementKind
);

/// <param name="Modified">Whether the file was actually changed on disk.</param>
/// <param name="Message">Human-readable description of what happened.</param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record PackageEditResult(
    [property: Key(0)] bool Modified,
    [property: Key(1)] string Message
)
{
    /// <summary>A result that changed the file on disk.</summary>
    internal static PackageEditResult Changed(string message)
    {
        return new PackageEditResult(Modified: true, Message: message);
    }

    /// <summary>A result describing why the file was left untouched.</summary>
    internal static PackageEditResult Unchanged(string message)
    {
        return new PackageEditResult(Modified: false, Message: message);
    }
}

// ── Compile Item Insertion (GitHub #493, [SE-ADD-FILE-REQUEST]) ─────

// Insert a <Compile Include="..." /> item into an MSBuild project file at a
// chosen position in compile order. Shares PackageEditResult as its wire
// result: the same modified/message contract as the package edit.
/// <param name="FilePath">Absolute path to the .csproj / .fsproj file to edit.</param>
/// <param name="Include">Project-relative include of the new source file.</param>
/// <param name="AnchorInclude">Existing Compile include to anchor to (empty for the default position).</param>
/// <param name="Position"><c>default</c> (before the last Compile item) | <c>before</c> | <c>after</c> the anchor.</param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record CompileInsertRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] string Include,
    [property: Key(2)] string AnchorInclude,
    [property: Key(3)] string Position
);
