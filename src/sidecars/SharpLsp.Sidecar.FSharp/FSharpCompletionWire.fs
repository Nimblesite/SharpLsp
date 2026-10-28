/// MessagePack wire-contract types for completion and its resolve: positional
/// [<Key(n)>] layouts mirror the Rust host's `SidecarCompletionItem` and its
/// resolve request and result.
namespace SharpLsp.Sidecar.FSharp

open MessagePack

// ── Completion Types (wire-compatible with the Rust host) ───────

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CompletionItemResult =
    { [<Key(0)>] Label: string
      [<Key(1)>] Kind: string
      [<Key(2)>] Detail: string
      [<Key(3)>] InsertText: string
      [<Key(4)>] Index: int
      /// Edit that REPLACES the identifier span at the caret so acceptance does
      /// not append the member name to the trigger text (GitHub #178).
      [<Key(5)>] TextEdit: TextEditResult }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CompletionResolveRequest =
    { [<Key(0)>] FilePath: string
      [<Key(1)>] Index: int }

[<MessagePackObject(AllowPrivate = true)>]
[<NoComparison; NoEquality>]
type CompletionResolveResultWire =
    { [<Key(0)>] AdditionalEdits: TextEditResult array }
