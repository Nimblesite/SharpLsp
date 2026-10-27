/// The shapes every F# quick fix takes: one edit replacing a range, or one new
/// line inserted before a line. Implements [ANALYZERS-FSAC-CODEFIX-COMPILER].
module SharpLsp.Sidecar.FSharp.FSharpQuickFix

open FSharp.Compiler.Text
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

/// A quick fix whose one edit replaces `r` with `text`.
let replace (title: string) (isPreferred: bool) (filePath: string) (r: range) (text: string) : GeneratedAction =
    { Title = title
      Kind = "quickfix"
      IsPreferred = isPreferred
      Edits = [ rangeEdit filePath r text ] }

/// A quick fix inserting `text` as a whole line before 1-based line `at.Line`,
/// indented to `at.Column`.
let insertLine (title: string) (filePath: string) (at: pos) (text: string) : GeneratedAction =
    let start = Position.mkPos at.Line 0
    let indent = String.replicate at.Column " "
    replace title false filePath (Range.mkRange filePath start start) $"{indent}{text}\n"

/// The whole lines `r` touches, from the start of its first through the start
/// of the line after its last.
let wholeLines (r: range) : range =
    Range.mkRange r.FileName (Position.mkPos r.StartLine 0) (Position.mkPos (r.EndLine + 1) 0)
