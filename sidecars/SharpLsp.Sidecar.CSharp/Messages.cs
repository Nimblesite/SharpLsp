using MessagePack;

namespace SharpLsp.Sidecar.CSharp;

// ── Existing Request/Response Types ──────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed class DidChangeRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public string NewText { get; set; } = "";
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class PositionRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int Line { get; init; }

    [Key(2)]
    public int Character { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class CompletionItem
{
    [Key(0)]
    public string Label { get; set; } = "";

    [Key(1)]
    public string Kind { get; set; } = "";

    [Key(2)]
    public string? Detail { get; init; }

    [Key(3)]
    public string? InsertText { get; init; }

    [Key(4)]
    public int Index { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class CompletionResolveRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int Index { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class CompletionResolveResult
{
    [Key(0)]
    public List<TextEditResult> AdditionalEdits { get; set; } = [];
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class HoverResult
{
    [Key(0)]
    public string Contents { get; set; } = "";

    [Key(1)]
    public int? StartLine { get; init; }

    [Key(2)]
    public int? StartCharacter { get; init; }

    [Key(3)]
    public int? EndLine { get; init; }

    [Key(4)]
    public int? EndCharacter { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class LocationResult
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int Line { get; init; }

    [Key(2)]
    public int Character { get; init; }

    [Key(3)]
    public int EndLine { get; init; }

    [Key(4)]
    public int EndCharacter { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class LocationListResult
{
    [Key(0)]
    public List<LocationResult> Locations { get; set; } = [];
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class ReferencesRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int Line { get; init; }

    [Key(2)]
    public int Character { get; init; }

    [Key(3)]
    public bool IncludeDeclaration { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class DocumentHighlightResult
{
    [Key(0)]
    public int StartLine { get; init; }

    [Key(1)]
    public int StartCharacter { get; init; }

    [Key(2)]
    public int EndLine { get; init; }

    [Key(3)]
    public int EndCharacter { get; init; }

    [Key(4)]
    public int Kind { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class DocumentHighlightListResult
{
    [Key(0)]
    public List<DocumentHighlightResult> Highlights { get; set; } = [];
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class SolutionDiagnosticsRequest
{
    [Key(0)]
    public string[] ProjectFilter { get; set; } = [];
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class DiagnosticResult
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int StartLine { get; init; }

    [Key(2)]
    public int StartCharacter { get; init; }

    [Key(3)]
    public int EndLine { get; init; }

    [Key(4)]
    public int EndCharacter { get; init; }

    [Key(5)]
    public string Message { get; set; } = "";

    [Key(6)]
    public string Severity { get; set; } = "";

    [Key(7)]
    public string Code { get; set; } = "";
}

/// <summary>
/// <c>analyzers/configure</c> request: the analyzer flags the host reads from
/// <c>sharplsp.toml</c> <c>[analyzers]</c> and pushes after <c>workspace/open</c>.
/// Mirrors the F# sidecar's <c>AnalyzerConfigRequest</c> wire layout.
/// </summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class AnalyzerConfigRequest
{
    [Key(0)]
    public bool DeadCode { get; init; }

    [Key(1)]
    public bool Monorepo { get; init; }
}

// ── Code Action Types ────────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed class CodeActionRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int StartLine { get; init; }

    [Key(2)]
    public int StartCharacter { get; init; }

    [Key(3)]
    public int EndLine { get; init; }

    [Key(4)]
    public int EndCharacter { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class CodeActionItem
{
    [Key(0)]
    public int Id { get; set; }

    [Key(1)]
    public string Title { get; set; } = "";

    [Key(2)]
    public string Kind { get; set; } = "";

    [Key(3)]
    public bool IsPreferred { get; set; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class CodeActionResolveRequest
{
    [Key(0)]
    public int Id { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class TextEditResult
{
    [Key(0)]
    public int StartLine { get; init; }

    [Key(1)]
    public int StartCharacter { get; init; }

    [Key(2)]
    public int EndLine { get; init; }

    [Key(3)]
    public int EndCharacter { get; init; }

    [Key(4)]
    public string NewText { get; set; } = "";
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class DocumentEditResult
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public List<TextEditResult> Edits { get; set; } = [];
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class WorkspaceEditResult
{
    [Key(0)]
    public List<DocumentEditResult> DocumentChanges { get; set; } = [];
}

// ── Formatting Types ─────────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed class RangeFormattingRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int StartLine { get; init; }

    [Key(2)]
    public int StartCharacter { get; init; }

    [Key(3)]
    public int EndLine { get; init; }

    [Key(4)]
    public int EndCharacter { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class OnTypeFormattingRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int Line { get; init; }

    [Key(2)]
    public int Character { get; init; }
}

// ── Semantic Tokens Types ────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed class SemanticTokensResult
{
    [Key(0)]
    public int[] Data { get; set; } = [];
}

// ── Inlay Hint Types ─────────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed class InlayHintRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int StartLine { get; init; }

    [Key(2)]
    public int EndLine { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class InlayHintResult
{
    [Key(0)]
    public int Line { get; set; }

    [Key(1)]
    public int Character { get; set; }

    [Key(2)]
    public string Label { get; set; } = "";

    [Key(3)]
    public int Kind { get; set; } // 1=Type, 2=Parameter
}

// ── Code Lens Types ──────────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed class CodeLensResult
{
    [Key(0)]
    public int Line { get; set; }

    [Key(1)]
    public int Character { get; set; }

    [Key(2)]
    public string Title { get; set; } = "";
}

// ── Call Hierarchy Types ─────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed class CallHierarchyItem
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

[MessagePackObject(AllowPrivate = true)]
internal sealed class CallHierarchyCallResult
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

// ── Type Hierarchy Types ─────────────────────────────────────────

[MessagePackObject(AllowPrivate = true)]
internal sealed class TypeHierarchyItem
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

// ── Rename Types ──────────────────────────────────────────────────

// Implements [RENAME-PREPARE] and [RENAME-APPLY]

[MessagePackObject(AllowPrivate = true)]
internal sealed class RenameRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int Line { get; init; }

    [Key(2)]
    public int Character { get; init; }

    [Key(3)]
    public string NewName { get; set; } = "";
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class PrepareRenameResult
{
    [Key(0)]
    public bool CanRename { get; init; }

    [Key(1)]
    public int StartLine { get; init; }

    [Key(2)]
    public int StartCharacter { get; init; }

    [Key(3)]
    public int EndLine { get; init; }

    [Key(4)]
    public int EndCharacter { get; init; }

    [Key(5)]
    public string Placeholder { get; set; } = "";
}

// ── Unused Package Detection ──────────────────────────────────────

// Implements [PKG-UNUSED-DETECT-CS]: assembly-level reference usage for a
// project, consumed by the Rust host's [PKG-UNUSED-MAP] package mapping.
[MessagePackObject(AllowPrivate = true)]
internal sealed class ReferenceUsageResult
{
    /// <summary>Absolute paths of assemblies actually used by the compilation.</summary>
    [Key(0)]
    public string[] UsedPaths { get; set; } = [];

    /// <summary>Absolute paths of every assembly referenced by the compilation.</summary>
    [Key(1)]
    public string[] AllPaths { get; set; } = [];

    /// <summary>NuGet global packages folder used to map assemblies to packages.</summary>
    [Key(2)]
    public string PackagesRoot { get; set; } = "";
}

// ── Package Reference Editing (GitHub #4, [NUGET-XML-DOM]) ─────────

// Add/remove a package entry in an MSBuild project file via the real MSBuild
// document model (ProjectRootElement) instead of line-oriented text splicing.
[MessagePackObject(AllowPrivate = true)]
internal sealed class PackageEditRequest
{
    /// <summary>Absolute path to the .csproj / .fsproj / .props file to edit.</summary>
    [Key(0)]
    public string FilePath { get; set; } = "";

    /// <summary>The package id (the item's <c>Include</c>).</summary>
    [Key(1)]
    public string PackageId { get; set; } = "";

    /// <summary>Version to write (ignored for removal / <c>referenceNoVersion</c>).</summary>
    [Key(2)]
    public string Version { get; set; } = "";

    /// <summary><c>reference</c> | <c>referenceNoVersion</c> | <c>version</c>.</summary>
    [Key(3)]
    public string ElementKind { get; set; } = "";
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class PackageEditResult
{
    /// <summary>Whether the file was actually changed on disk.</summary>
    [Key(0)]
    public bool Modified { get; set; }

    /// <summary>Human-readable description of what happened.</summary>
    [Key(1)]
    public string Message { get; set; } = "";
}
