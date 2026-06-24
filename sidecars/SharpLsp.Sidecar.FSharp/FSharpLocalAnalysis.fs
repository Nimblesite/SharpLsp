/// Shared file-local FCS analysis: unused `open` declarations and simplifiable
/// (redundantly-qualified) names. Compiled before both consumers so they share a
/// single FCS call site:
///   * [FSharpCodeFixes] turns the findings into "Remove unused open" /
///     "Simplify name" code fixes ([FS-CODEFIX-UNUSEDOPEN]/[FS-CODEFIX-SIMPLIFYNAME]);
///   * [FSharpAnalyzers] turns them into always-on diagnostic hints
///     ([FS-ANALYZER-UNUSEDOPEN]/[FS-ANALYZER-SIMPLIFYNAME]).
/// Keeping one source of truth means hints and fixes can never disagree.
module SharpLsp.Sidecar.FSharp.FSharpLocalAnalysis

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Text

/// A 1-based line accessor over file source (FCS line numbers are 1-based).
let lineGetter (source: string) : int -> string =
    let lines = source.Replace("\r\n", "\n").Split('\n')

    fun lineNumber ->
        if lineNumber >= 1 && lineNumber <= lines.Length then
            lines.[lineNumber - 1]
        else
            ""

/// Raw file-local analyzer findings, before any diagnostic/edit conversion.
[<NoComparison; NoEquality>]
type FileAnalyzerFindings =
    { /// Ranges of `open` declarations that nothing in the file uses.
      UnusedOpens: range list
      /// Redundant qualifiers paired with the shorter relative name they reduce to.
      SimplifiableNames: (range * string) list }

/// Run FCS's file-local analyzers (`UnusedOpens`, `SimplifyNames`) once and return
/// the raw findings. Both the code-fix and diagnostics layers build on this.
let getFileAnalyzerFindings
    (check: FSharpCheckFileResults)
    (source: string)
    : Async<FileAnalyzerFindings> =
    async {
        let getLine = lineGetter source
        let! unusedOpens = UnusedOpens.getUnusedOpens (check, getLine)
        let! simplifiable = SimplifyNames.getSimplifiableNames (check, getLine)

        let simplifyItems =
            simplifiable |> Seq.map (fun s -> (s.Range, s.RelativeName)) |> List.ofSeq

        return
            { UnusedOpens = unusedOpens
              SimplifiableNames = simplifyItems }
    }
