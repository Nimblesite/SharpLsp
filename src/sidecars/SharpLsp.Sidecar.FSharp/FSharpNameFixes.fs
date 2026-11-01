/// F# quick fixes that repair a name FCS rejected: "Replace with" and the
/// explicit import rows for an undefined identifier (FS0039), "Add 'new'" for a
/// disposable constructor call (FS0760) and "Prefix with _" for an unused
/// value (FS1182). The name is the source a diagnostic's range covers; the
/// candidates, the constructor call and the `open` position come from FCS's
/// declarations in scope and the untyped AST — never from message text.
/// Implements [ANALYZERS-FSAC-CODEFIX-TYPO] / [ANALYZERS-FSAC-CODEFIX-ADD-NEW].
module SharpLsp.Sidecar.FSharp.FSharpNameFixes

open System
open System.Globalization
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
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

/// The unresolved identifier, sliced by its FCS range rather than its message.
/// [REFACTOR-IMPORT-FSHARP]
let flaggedName source (r: range) =
    flaggedText (FSharpLocalAnalysis.lineGetter source) r

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
        FSharpLocalAnalysis.declarationsAt parseResults checkResults (fun () -> []) (line r.StartLine) (r.StartLine - 1) r.EndColumn
        |> snd
        |> closestNames name)
    |> Option.defaultValue []
    |> List.mapi (fun index replacement ->
        FSharpQuickFix.replace $"Replace with '{replacement}'" (index = 0) filePath r replacement)

// ── FS0039: open the namespace ──────────────────────────────────

/// The suffix an attribute's type name carries and its uses may leave off.
[<Literal>]
let private ATTRIBUTE = "Attribute"

/// Whether an entity of kind `entity` can stand where the code expects `expected`:
/// a type where a type is expected (an attribute is one), an attribute where an
/// attribute is, and anything where a value is or the position is unknown.
let private fits (expected: EntityKind option) (entity: EntityKind) =
    match expected, entity with
    | Some EntityKind.Attribute, EntityKind.Attribute
    | Some EntityKind.Type, (EntityKind.Type | EntityKind.Attribute)
    | Some(EntityKind.FunctionOrValue _), _
    | None, _ -> true
    | _ -> false

/// The full names an entity answers to: its own, and an attribute's without its suffix.
let private spellings (entity: AssemblySymbol) : string array list =
    let idents = entity.CleanedIdents
    let last = Array.last idents
    [ idents
      if last.EndsWith ATTRIBUTE && last.Length > ATTRIBUTE.Length then
          Array.append idents[.. idents.Length - 2] [| last.Substring(0, last.Length - ATTRIBUTE.Length) |] ]

/// The entities whose `open` or full name brings `name` into scope at `r`.
/// FCS's insertion context decides AutoOpen and RequireQualifiedAccess cases.
/// [REFACTOR-IMPORT-FSHARP]
let private candidatesFor (parseResults: FSharpParseFileResults) (entities: AssemblySymbol list) (r: range) (name: string) =
    let expected = ParsedInput.GetEntityKind(r.Start, parseResults.ParseTree)
    let candidates =
        ParsedInput.TryFindInsertionContext
            r.StartLine parseResults.ParseTree [| { Ident = name; Resolved = false } |] OpenStatementInsertionPoint.Nearest
    entities
    |> List.filter (fun entity -> fits expected (entity.Kind LookupType.Precise))
    |> List.collect (fun entity ->
        spellings entity
        |> List.filter (fun idents -> Array.last idents = name)
        |> List.collect (fun idents ->
            candidates (entity.TopRequireQualifiedAccessParent, entity.AutoOpenParent, entity.Namespace, idents)
            |> Array.toList
            |> List.map (fun insertion -> insertion, idents)))

let private namespaceNames (candidates: ((InsertionContextEntity * InsertionContext) * string array) list) =
    candidates
    |> List.choose (fun ((target, _), _) -> target.Namespace)
    |> List.distinct
    |> List.sort
    |> List.truncate MAX_SUGGESTIONS

let private qualifiedNames (candidates: ((InsertionContextEntity * InsertionContext) * string array) list) =
    candidates
    |> List.map (fun (_, idents) -> String.concat "." idents)
    |> List.distinct
    |> List.sort

let private openAction (parseResults: FSharpParseFileResults) line filePath (r: range) (namespaceName: string) =
    let at = FSharpQuickFix.openPosition parseResults line r.StartLine (namespaceName.Split '.')
    let title = $"Add 'open {namespaceName}' — imports every type and module in namespace {namespaceName}"
    FSharpQuickFix.insertLine title filePath at $"open {namespaceName}"

let private qualifyAction filePath (r: range) name fullName =
    let title = $"Change '{name}' to '{fullName}' — qualifies this one use; no open added"
    FSharpQuickFix.replace title false filePath r fullName

let private hasMember rights name (entity: FSharpEntity) =
    entity.MembersFunctionsAndValues
    |> Seq.exists (fun m ->
        m.DisplayName = name && m.IsAccessible(rights) && m.IsMember && not m.IsInstanceMember)

let private hasNested rights name (entity: FSharpEntity) =
    entity.NestedEntities
    |> Seq.exists (fun nested -> nested.DisplayName = name && nested.IsAccessible(rights))

let private accessibleType rights (entity: FSharpEntity) =
    not entity.IsNamespace && not entity.IsFSharpModule && entity.IsAccessible(rights)

let private staticTypes (checkResults: FSharpCheckFileResults) name =
    let rights = checkResults.ProjectContext.AccessibilityRights
    FSharpEntityIndex.types checkResults
    |> List.filter (fun entity ->
        accessibleType rights entity && (hasMember rights name entity || hasNested rights name entity))
    |> List.choose (fun entity -> entity.TryFullName)
    |> List.distinct
    |> List.sort
    |> List.truncate MAX_SUGGESTIONS

let private supportsOpenType (checkResults: FSharpCheckFileResults) =
    checkResults.ProjectContext.ProjectOptions.OtherOptions
    |> Array.tryPick (FSharpProjectLoading.flagValue [ "--langversion:" ] >> Option.map snd)
    |> Option.map (fun version ->
        match Double.TryParse(version, NumberStyles.Float, CultureInfo.InvariantCulture) with
        | true, number -> number >= 5.0
        | _ -> true)
    |> Option.defaultValue true

let private staticActions parseResults checkResults line filePath (r: range) name =
    if not (supportsOpenType checkResults) then []
    else
        staticTypes checkResults name
        |> List.map (fun fullName ->
            let at = FSharpQuickFix.openPosition parseResults line r.StartLine (fullName.Split '.')
            let title = $"Add 'open type {fullName}' — imports the static members and nested types of {fullName}"
            FSharpQuickFix.insertLine title filePath at $"open type {fullName}")

/// Every in-reach FS0039 import: namespace opens, full qualification, and
/// `open type` for accessible static members or nested types.
/// [REFACTOR-IMPORT-FSHARP]
let imports workspace parseResults (checkResults: FSharpCheckFileResults) source filePath (r: range) =
    let line = FSharpLocalAnalysis.lineGetter source
    match flaggedText line r with
    | None -> []
    | Some name ->
        let candidates = candidatesFor parseResults (FSharpEntityIndex.entities workspace checkResults ()) r name
        (namespaceNames candidates |> List.map (openAction parseResults line filePath r))
        @ (qualifiedNames candidates |> List.map (qualifyAction filePath r name))
        @ staticActions parseResults checkResults line filePath r name

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
