/// F# quick fixes that repair a name FCS rejected: "Replace with" and
/// "Add 'open X'" for an undefined identifier (FS0039), "Add 'new'" for a
/// disposable constructor call (FS0760) and "Prefix with _" for an unused
/// value (FS1182). The name is the source a diagnostic's range covers; the
/// candidates, the constructor call and the `open` position come from FCS's
/// declarations in scope and the untyped AST — never from message text.
/// Implements [ANALYZERS-FSAC-CODEFIX-TYPO] / [ANALYZERS-FSAC-CODEFIX-ADD-NEW].
module SharpLsp.Sidecar.FSharp.FSharpNameFixes

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

/// The similarity a name in scope needs to be offered as the intended one.
let private SUGGESTION_THRESHOLD = 0.85

/// The most replacements offered for one misspelling.
let private MAX_SUGGESTIONS = 3

// ── Similarity ──────────────────────────────────────────────────

/// The `(i, j)` pairs matching `a[i]` to `b[j]` within the Jaro window, in `a` order.
let private jaroMatches (a: string) (b: string) : (int * int) list =
    let window = max 0 (max a.Length b.Length / 2 - 1)

    ((Set.empty, []), [ 0 .. a.Length - 1 ])
    ||> List.fold (fun (used: Set<int>, pairs) i ->
        [ max 0 (i - window) .. min (b.Length - 1) (i + window) ]
        |> List.tryFind (fun j -> not (used.Contains j) && a[i] = b[j])
        |> Option.map (fun j -> used.Add j, (i, j) :: pairs)
        |> Option.defaultValue (used, pairs))
    |> snd
    |> List.rev

/// Jaro similarity: matched characters, discounted by half the transpositions.
let private jaro (a: string) (b: string) : float =
    match jaroMatches a b with
    | [] -> 0.0
    | pairs ->
        let m = float pairs.Length
        let inA = pairs |> List.map (fun (i, _) -> a[i])
        let inB = pairs |> List.map snd |> List.sort |> List.map (fun j -> b[j])
        let transposed = List.zip inA inB |> List.filter (fun (x, y) -> x <> y) |> List.length
        (m / float a.Length + m / float b.Length + (m - float transposed / 2.0) / m) / 3.0

/// Jaro–Winkler similarity: 0 for unrelated names, 1 for equal ones, with a
/// bonus for a shared prefix of up to four characters.
let private similarity (a: string) (b: string) : float =
    let score = jaro a b
    let prefix = Seq.zip a b |> Seq.truncate 4 |> Seq.takeWhile (fun (x, y) -> x = y) |> Seq.length
    score + float prefix * 0.1 * (1.0 - score)

/// Levenshtein distance: the fewest single-character edits turning `a` into `b`.
let private editDistance (a: string) (b: string) : int =
    let row (previous: int array) (ca: char) =
        (previous[0] + 1, [ 1 .. b.Length ])
        ||> List.scan (fun left j -> min (min (left + 1) (previous[j] + 1)) (previous[j - 1] + (if ca = b[j - 1] then 0 else 1)))
        |> List.toArray

    (Array.init (b.Length + 1) id, a) ||> Seq.fold row |> Array.last

/// FCS's own edit budget for a suggestion: about a quarter of the name.
let private editBudget (length: int) : int =
    if length < 5 then 1 elif length < 7 then 2 else length / 4 + 1

/// How close `candidate` is to the misspelled `name`, ignoring case — when it
/// is both highly similar and within the edit budget, as FCS's own "Maybe you
/// want one of the following" hints require. A shared prefix alone (`Some` for
/// `SomeUnknownThing`) is not enough.
let private closeness (name: string) (candidate: string) : float option =
    let a, b = name.ToUpperInvariant(), candidate.ToUpperInvariant()
    let score = similarity a b

    if score >= SUGGESTION_THRESHOLD && editDistance a b <= editBudget a.Length then Some score else None

// ── FS0039: replace with the intended name ──────────────────────

/// The name a diagnostic's range covers.
let private flaggedText (line: int -> string) (r: range) : string option =
    FSharpLocalAnalysis.textOf line r |> Option.filter ((<>) "")

/// The names in scope closest to `name`, best first.
let private closestNames (name: string) (items: DeclarationListItem array) : string list =
    items
    |> Array.filter (fun item -> item.NameInList <> name)
    |> Array.choose (fun item -> closeness name item.NameInList |> Option.map (fun score -> score, item.NameInCode))
    |> Array.sortByDescending fst
    |> Array.map snd
    |> Array.distinct
    |> Array.truncate MAX_SUGGESTIONS
    |> Array.toList

/// "Replace with 'name'" for each name in scope close to the one FS0039
/// rejected, the closest preferred. [ANALYZERS-FSAC-CODEFIX-TYPO]
let typos parseResults checkResults source filePath (r: range) : GeneratedAction list =
    let line = FSharpLocalAnalysis.lineGetter source

    flaggedText line r
    |> Option.map (fun name ->
        FSharpLocalAnalysis.declarationsAt parseResults checkResults (line r.StartLine) (r.StartLine - 1) r.EndColumn
        |> snd
        |> closestNames name)
    |> Option.defaultValue []
    |> List.mapi (fun index replacement ->
        FSharpQuickFix.replace $"Replace with '{replacement}'" (index = 0) filePath r replacement)

// ── FS0039: open the namespace ──────────────────────────────────

/// The namespace of a well-known framework type FS0039 reports undefined.
let private namespaceOf (name: string) : string list option =
    match name with
    | "Path" | "File" | "Directory" -> Some [ "System"; "IO" ]
    | "Task" -> Some [ "System"; "Threading"; "Tasks" ]
    | "Regex" -> Some [ "System"; "Text"; "RegularExpressions" ]
    | "Dictionary" -> Some [ "System"; "Collections"; "Generic" ]
    | _ -> None

/// `at` moved down past blank lines, up to `lastLine`: an `open` joins the
/// declarations it serves rather than its scope's header line.
let rec private pastBlankLines (line: int -> string) (lastLine: int) (at: pos) : pos =
    if at.Line < lastLine && System.String.IsNullOrWhiteSpace(line at.Line) then
        pastBlankLines line lastLine (Position.mkPos (at.Line + 1) at.Column)
    else
        at

/// Where FCS places an `open` serving the code at `r`: the nearest scope's
/// opens, at that scope's indentation (1-based line), below any blank lines.
let private openPosition (parseResults: FSharpParseFileResults) (line: int -> string) (r: range) namespaceParts : pos =
    let context =
        ParsedInput.FindNearestPointToInsertOpenDeclaration
            r.StartLine parseResults.ParseTree (List.toArray namespaceParts) OpenStatementInsertionPoint.Nearest
    let file = parseResults.ParseTree.Range
    // AdjustInsertionPoint reads lines by 0-based index.
    ParsedInput.AdjustInsertionPoint (fun index -> line (index + 1)) context
    |> pastBlankLines line file.EndLine

/// "Add 'open X'" for a well-known framework type FS0039 reports undefined.
let opens parseResults source filePath (r: range) : GeneratedAction list =
    let line = FSharpLocalAnalysis.lineGetter source

    flaggedText line r
    |> Option.bind namespaceOf
    |> Option.map (fun parts ->
        let namespaceName = String.concat "." parts
        FSharpQuickFix.insertLine $"Add 'open {namespaceName}'" filePath (openPosition parseResults line r parts) $"open {namespaceName}")
    |> Option.toList

// ── FS1182: mark the unused value ───────────────────────────────

/// "Prefix 'x' with _" for the value FS1182 reports unused.
let unused source filePath (r: range) : GeneratedAction list =
    flaggedText (FSharpLocalAnalysis.lineGetter source) r
    |> Option.map (fun name -> FSharpQuickFix.replace $"Prefix '{name}' with _" true filePath r $"_{name}")
    |> Option.toList

// ── FS0760: add new ─────────────────────────────────────────────

/// True when `r` is exactly a constructor application, `Type(args)`. A
/// constructor used as a function value carries the same warning, but `new`
/// cannot prefix a function value.
let private isConstructorCall (parseResults: FSharpParseFileResults) (r: range) : bool =
    let visitor =
        { new SyntaxVisitorBase<unit>() with
            member _.VisitExpr(_, _, defaultTraverse, expr) =
                match expr with
                | SynExpr.App(range = applied) when Range.equals applied r -> Some()
                | _ -> defaultTraverse expr }

    (SyntaxTraversal.Traverse(r.Start, parseResults.ParseTree, visitor)).IsSome

/// "Add 'new'" in front of the constructor call FS0760 flags. [ANALYZERS-FSAC-CODEFIX-ADD-NEW]
let addNew (parseResults: FSharpParseFileResults) filePath (r: range) : GeneratedAction list =
    if isConstructorCall parseResults r then
        [ FSharpQuickFix.replace "Add 'new'" true filePath (Range.mkRange r.FileName r.Start r.Start) "new " ]
    else
        []
