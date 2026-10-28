/// [ANALYZERS-DEADCODE-FIX] "Remove unused 'x'": the quick fix for a dead
/// declaration the analyzer reports (`SLSPF0101`). It deletes the whole declaration,
/// with the XML documentation and attributes above it, and only when that
/// declaration stands alone on its own lines, declares nothing else, and no
/// signature file elsewhere declares it, so the deletion can never take live code
/// with it or break a signature's contract.
module SharpLsp.Sidecar.FSharp.FSharpDeadCodeFixes

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

/// A declaration the fix may delete whole: the name it declares, and its span
/// from the first line of its documentation or attributes to the end of its body.
[<NoComparison; NoEquality>]
type Declaration = private { Name: Ident; Span: range }

/// `binding`'s declaration over `r`, widened to the documentation and attributes above it.
let private declaration (SynBinding(attributes = attributes; xmlDoc = xmlDoc; headPat = pat)) (r: range) =
    let doc = xmlDoc.ToXmlDoc(false, None)
    let preamble = [ if not doc.IsEmpty then doc.Range ] @ (attributes |> List.map _.Range)
    patIdent pat
    |> Option.map (fun name -> { Name = name; Span = List.fold Range.unionRanges r preamble })

/// The members of a type that each declare one name alone.
let private typeMembers (SynTypeDefn(typeRepr = repr; members = members)) =
    let inner =
        match repr with
        | SynTypeDefnRepr.ObjectModel(members = objectMembers) -> objectMembers
        | _ -> []
    (inner @ members)
    |> List.choose (function
        | SynMemberDefn.Member(memberDefn = binding; range = r) -> declaration binding r
        | _ -> None)

/// Every module-level `let` declaring one binding, and every member, in `decls`.
let rec private declarations (decls: SynModuleDecl list) : Declaration list =
    decls
    |> List.collect (function
        | SynModuleDecl.Let(bindings = [ binding ]; range = r) -> declaration binding r |> Option.toList
        | SynModuleDecl.NestedModule(decls = inner) -> declarations inner
        | SynModuleDecl.Types(typeDefns = types) -> types |> List.collect typeMembers
        | _ -> [])

/// Every deletable declaration of an implementation file; a signature file has none.
let private fileDeclarations (input: ParsedInput) =
    match input with
    | ParsedInput.ImplFile(ParsedImplFileInput(contents = modules)) ->
        modules |> List.collect (fun (SynModuleOrNamespace(decls = decls)) -> declarations decls)
    | ParsedInput.SigFile _ -> []

/// Whether `text` holds nothing but whitespace.
let private isBlank (text: string) = String.forall System.Char.IsWhiteSpace text

/// Whether `span` occupies its lines alone: nothing before it on its first line
/// and nothing after it on its last.
let private standsAlone (line: int -> string) (span: range) =
    let first = line span.StartLine
    let last = line span.EndLine
    isBlank (first.Substring(0, min span.StartColumn first.Length))
    && isBlank (last.Substring(min span.EndColumn last.Length))

/// Whether a signature file other than `filePath` declares the symbol `name` defines:
/// deleting only its implementation would then break that signature.
let private declaredElsewhere (checkResults: FSharpCheckFileResults) (line: int -> string) filePath (name: Ident) =
    let at = name.idRange
    checkResults.GetSymbolUseAtLocation(at.StartLine, at.EndColumn, line at.StartLine, [ name.idText ])
    |> Option.bind _.Symbol.SignatureLocation
    |> Option.exists (fun signature -> not (NativePaths.AreEqual(signature.FileName, filePath)))

/// The number of the last line of `source`; a final line break ends a line, not starts one.
let private lastLineOf (source: string) =
    let lines = source.Split('\n')
    if source.EndsWith "\n" then lines.Length - 1 else lines.Length

/// The whole lines to delete for `span` in a file whose last line is `lastLine`: its
/// own, and one blank line beside them when the other side is blank too (or the file
/// starts or ends there), so the neighbours keep a single gap between them, never two.
let private deletion (line: int -> string) (lastLine: int) (span: range) =
    let blank n = n >= 1 && n <= lastLine && isBlank (line n)
    let first, last = span.StartLine, span.EndLine
    let startLine, endLine =
        if blank (last + 1) && (first = 1 || blank (first - 1)) then first, last + 1
        elif blank (first - 1) && last >= lastLine then first - 1, last
        else first, last
    FSharpQuickFix.wholeLines (Range.mkRange span.FileName (Position.mkPos startLine 0) (Position.mkPos endLine 0))

/// The deletable declarations whose names lie on 0-based lines `startLine` to
/// `endLine`. Only these can be fixed there, so where there are none the
/// project-wide dead-code analysis need not run at all.
let declaredOn (parseResults: FSharpParseFileResults) (startLine: int) (endLine: int) : Declaration list =
    fileDeclarations parseResults.ParseTree
    |> List.filter (fun candidate ->
        let at = candidate.Name.idRange
        startLine <= at.StartLine - 1 && at.StartLine - 1 <= endLine)

/// The "Remove unused" fix for one dead-code finding, when it names one of
/// `candidates` and that declaration can go whole.
let removal
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (filePath: string)
    (candidates: Declaration list)
    (finding: DiagnosticResult)
    : GeneratedAction option =
    let line = FSharpLocalAnalysis.lineGetter source
    let lastLine = lastLineOf source
    let names (candidate: Declaration) =
        let at = candidate.Name.idRange
        at.StartLine - 1 = finding.StartLine && at.StartColumn = finding.StartCharacter
    candidates
    |> List.tryFind names
    |> Option.filter (fun candidate -> standsAlone line candidate.Span)
    |> Option.filter (fun candidate -> not (declaredElsewhere checkResults line filePath candidate.Name))
    |> Option.map (fun candidate ->
        FSharpQuickFix.replace $"Remove unused '{candidate.Name.idText}'" false filePath (deletion line lastLine candidate.Span) "")
