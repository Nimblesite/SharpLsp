/// MessagePack wire-contract types for diagnostics and the code actions that
/// fix them, shared by the analyzers, the quick fixes and the sidecar's
/// handlers. Positional [<Key(n)>] layouts mirror the C# sidecar's.
namespace SharpLsp.Sidecar.FSharp

open MessagePack

// ── Code Action Types (wire-compatible with C# sidecar) ─────────

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CodeActionRequest =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] StartLine: int
      [<Key(2)>] StartCharacter: int
      [<Key(3)>] EndLine: int
      [<Key(4)>] EndCharacter: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CodeActionItemResult =
    { [<Key(0)>] Id: int
      [<Key(1)>] Title: string
      [<Key(2)>] Kind: string
      [<Key(3)>] IsPreferred: bool
      /// The reference the action adds before its open; null for an edit action. [REFACTOR-IMPORT-REFERENCE]
      [<Key(4)>] Reference: SharpLsp.Sidecar.Common.Messages.ReferenceImport | null }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CodeActionResolveRequest =
    { [<Key(0)>] Id: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type TextEditResult =
    { [<Key(0)>] StartLine: int
      [<Key(1)>] StartCharacter: int
      [<Key(2)>] EndLine: int
      [<Key(3)>] EndCharacter: int
      [<Key(4)>] NewText: string }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type DocumentEditResult =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] Edits: TextEditResult array }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type WorkspaceEditResult =
    { [<Key(0)>] DocumentChanges: DocumentEditResult array }

// ── Diagnostics Types (wire-compatible with C# sidecar) ─────────

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type DiagnosticResult =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] StartLine: int
      [<Key(2)>] StartCharacter: int
      [<Key(3)>] EndLine: int
      [<Key(4)>] EndCharacter: int
      [<Key(5)>] Message: string
      [<Key(6)>] Severity: string
      [<Key(7)>] Code: string
      /// The rule's documentation page (FSharpLint rules only), if any;
      /// empty for compiler and built-in analyzer diagnostics ([DIAG-CATEGORIES-ANALYZER]).
      [<Key(8)>] HelpLink: string }

/// `analyzers/configure` request: analyzer flags the host reads from
/// `sharplsp.toml` `[analyzers]` and pushes to the sidecar after `workspace/open`.
[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type AnalyzerConfigRequest =
    { [<Key(0)>] DeadCode: bool
      [<Key(1)>] Monorepo: bool }
