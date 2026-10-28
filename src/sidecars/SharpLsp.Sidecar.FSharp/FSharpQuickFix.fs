/// The shapes every F# quick fix takes: one edit replacing a range, or one new
/// line inserted before a line. Implements [ANALYZERS-FSAC-CODEFIX-COMPILER].
module SharpLsp.Sidecar.FSharp.FSharpQuickFix

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Text
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

/// A quick fix made of its one `edit`.
let private quickFix (title: string) (isPreferred: bool) (edit: RawEdit) : GeneratedAction =
    { Title = title
      Kind = "quickfix"
      IsPreferred = isPreferred
      Edits = [ edit ] }

/// A quick fix whose one edit replaces `r` with `text`.
let replace (title: string) (isPreferred: bool) (filePath: string) (r: range) (text: string) : GeneratedAction =
    quickFix title isPreferred (rangeEdit filePath r text)

/// The edit inserting `text` as a whole line before 1-based line `at.Line`,
/// indented to `at.Column`.
let lineInsertion (filePath: string) (at: pos) (text: string) : RawEdit =
    let start = Position.mkPos at.Line 0
    let indent = String.replicate at.Column " "
    rangeEdit filePath (Range.mkRange filePath start start) $"{indent}{text}\n"

/// A quick fix inserting `text` as a whole line before 1-based line `at.Line`,
/// indented to `at.Column`.
let insertLine (title: string) (filePath: string) (at: pos) (text: string) : GeneratedAction =
    quickFix title false (lineInsertion filePath at text)

/// `at` moved down past blank lines, up to `lastLine`: an `open` joins the
/// declarations it serves rather than its scope's header line.
let rec private pastBlankLines (line: int -> string) (lastLine: int) (at: pos) : pos =
    if at.Line < lastLine && System.String.IsNullOrWhiteSpace(line at.Line) then
        pastBlankLines line lastLine (Position.mkPos (at.Line + 1) at.Column)
    else
        at

/// Where FCS places an `open` of `namespaceParts` serving the code on 1-based
/// `codeLine`: the nearest scope's opens, at that scope's indentation, below
/// any blank lines.
let openPosition (parseResults: FSharpParseFileResults) (line: int -> string) (codeLine: int) (namespaceParts: string array) : pos =
    let context =
        ParsedInput.FindNearestPointToInsertOpenDeclaration
            codeLine parseResults.ParseTree namespaceParts OpenStatementInsertionPoint.Nearest
    let file = parseResults.ParseTree.Range
    // AdjustInsertionPoint reads lines by 0-based index.
    ParsedInput.AdjustInsertionPoint (fun index -> line (index + 1)) context
    |> pastBlankLines line file.EndLine

/// The whole lines `r` touches, from the start of its first through the start
/// of the line after its last.
let wholeLines (r: range) : range =
    Range.mkRange r.FileName (Position.mkPos r.StartLine 0) (Position.mkPos (r.EndLine + 1) 0)
