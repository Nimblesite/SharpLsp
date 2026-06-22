/// Novel F# static analyzers that run on top of the FCS compiler diagnostics
/// surfaced by `workspace/diagnostics`. These go beyond what FsAutoComplete /
/// Ionide ships:
///
///   * [FS-ANALYZER-DEADCODE] — monorepo-wide dead-code detection. A symbol whose
///     only use is its own definition is dead. When the workspace is declared a
///     **monorepo** (`[analyzers] monorepo = true` in `sharplsp.toml`), the whole
///     repository is the world, so an unused *public* symbol is genuinely dead and
///     is reported as an **error**. Outside monorepo mode, public symbols are
///     assumed to be an external API and only private/internal dead code is
///     surfaced (as a warning). FSAC's unused-symbol detection is file-local and
///     never errors — this is project-wide and gate-able.
///
/// Diagnostics reuse the [DiagnosticResult] wire shape so the
/// `workspace/diagnostics` handler can merge analyzer output with the compiler
/// diagnostics with zero conversion.
module SharpLsp.Sidecar.FSharp.FSharpAnalyzers

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Symbols
open FSharp.Compiler.Text

/// Analyzer settings, populated from the `[analyzers]` section of `sharplsp.toml`
/// and pushed to the sidecar by the host via the `analyzers/configure` request.
[<NoComparison; NoEquality>]
type AnalyzerConfig =
    { /// Whether the dead-code analyzer runs at all.
      DeadCodeEnabled: bool
      /// Whether the workspace is the entire world (monorepo). When true, unused
      /// public symbols are dead-code errors; when false they are skipped.
      Monorepo: bool }

    /// Conservative defaults: dead-code on, monorepo off (public API preserved).
    static member Default = { DeadCodeEnabled = true; Monorepo = false }

    /// Build a config from the wire flags the host pushes via `analyzers/configure`.
    static member Create(deadCode: bool, monorepo: bool) =
        { DeadCodeEnabled = deadCode; Monorepo = monorepo }

/// Stable identity for a declaration site, used to test whether a symbol is
/// referenced anywhere. Two uses of the same symbol share a declaration range.
let private rangeKey (r: range) =
    (r.FileName, r.StartLine, r.StartColumn, r.EndLine, r.EndColumn)

/// True when `mfv` carries `[<EntryPoint>]` (an `main` is invoked by the runtime,
/// never by code, so it must never be flagged as dead).
let private hasEntryPointAttr (mfv: FSharpMemberOrFunctionOrValue) =
    mfv.Attributes
    |> Seq.exists (fun a -> a.AttributeType.DisplayName = "EntryPointAttribute")

/// Only module-level values, functions, and members are dead-code candidates.
/// Locals, parameters, constructors, overrides/interface impls, property
/// accessors, compiler-generated symbols, and entry points are excluded to keep
/// the signal high (those are either invoked indirectly or already handled by FCS).
let private isDeadCodeCandidate (mfv: FSharpMemberOrFunctionOrValue) =
    mfv.IsModuleValueOrMember
    && not mfv.IsCompilerGenerated
    && not mfv.IsConstructor
    && not mfv.IsOverrideOrExplicitInterfaceImplementation
    && not mfv.IsPropertyGetterMethod
    && not mfv.IsPropertySetterMethod
    && not (hasEntryPointAttr mfv)

/// Build a wire diagnostic from a 1-based FCS range (LSP positions are 0-based).
let buildDiagnostic
    (code: string)
    (severity: string)
    (message: string)
    (r: range)
    : DiagnosticResult =
    { FilePath = r.FileName
      StartLine = r.StartLine - 1
      StartCharacter = r.StartColumn
      EndLine = r.EndLine - 1
      EndCharacter = r.EndColumn
      Message = message
      Severity = severity
      Code = code }

/// Classify a dead declaration into a diagnostic, honoring the monorepo gate.
let private classifyDead
    (config: AnalyzerConfig)
    (symbol: FSharpSymbol)
    (declRange: range)
    : DiagnosticResult option =
    match symbol with
    | :? FSharpMemberOrFunctionOrValue as mfv when isDeadCodeCandidate mfv ->
        let isPublic = mfv.Accessibility.IsPublic
        // Public symbols are only dead when the monorepo is the whole world.
        if isPublic && not config.Monorepo then
            None
        else
            let severity = if config.Monorepo then "Error" else "Warning"
            let scope = if isPublic then "public " else ""
            let where =
                if config.Monorepo then "anywhere in the monorepo" else "in the project"
            let message =
                sprintf "Dead code: %s'%s' is never used %s." scope mfv.DisplayName where
            Some(buildDiagnostic "SLSPF0101" severity message declRange)
    | _ -> None

/// [FS-ANALYZER-DEADCODE] Project-wide dead-code diagnostics. A declaration is
/// dead when no *non-definition* use of the same symbol exists in the project.
/// `allUses` comes from `FSharpCheckProjectResults.GetAllUsesOfAllSymbols()`.
let deadCodeDiagnostics
    (config: AnalyzerConfig)
    (allUses: FSharpSymbolUse[])
    : DiagnosticResult list =
    if not config.DeadCodeEnabled then
        []
    else
        let referenced =
            allUses
            |> Array.choose (fun su ->
                if su.IsFromDefinition then None
                else su.Symbol.DeclarationLocation |> Option.map rangeKey)
            |> Set.ofArray
        allUses
        |> Array.choose (fun su ->
            if not su.IsFromDefinition then
                None
            else
                match su.Symbol.DeclarationLocation with
                | Some declRange when not (referenced.Contains(rangeKey declRange)) ->
                    classifyDead config su.Symbol declRange
                | _ -> None)
        |> Array.toList
        |> List.distinctBy (fun d -> (d.FilePath, d.StartLine, d.StartCharacter))

/// Compare two paths for identity, tolerant of casing and relative segments.
let samePath (a: string) (b: string) =
    try
        System.String.Equals(
            System.IO.Path.GetFullPath a,
            System.IO.Path.GetFullPath b,
            System.StringComparison.OrdinalIgnoreCase
        )
    with _ ->
        System.String.Equals(a, b, System.StringComparison.OrdinalIgnoreCase)

/// Dead-code diagnostics scoped to a single file. The analysis itself is
/// project-wide, but `workspace/diagnostics` is pulled per file, so only the
/// declarations that physically live in `filePath` are returned.
let deadCodeDiagnosticsForFile
    (config: AnalyzerConfig)
    (allUses: FSharpSymbolUse[])
    (filePath: string)
    : DiagnosticResult list =
    deadCodeDiagnostics config allUses
    |> List.filter (fun d -> samePath d.FilePath filePath)

// ── File-local FCS analyzers (FSAC parity) ──────────────────────────

/// A 1-based line accessor over file source (FCS line numbers are 1-based).
let lineGetter (source: string) : int -> string =
    let lines = source.Replace("\r\n", "\n").Split('\n')
    fun lineNumber ->
        if lineNumber >= 1 && lineNumber <= lines.Length then
            lines.[lineNumber - 1]
        else
            ""

/// [FS-ANALYZER-UNUSEDOPEN] Unused `open` declarations, surfaced as hints so the
/// editor can grey them out and offer removal (FSAC's "remove unused open").
let unusedOpenDiagnostics (ranges: range list) : DiagnosticResult list =
    ranges
    |> List.map (buildDiagnostic "SLSPF0102" "Hint" "Unused 'open' statement; safe to remove.")

/// [FS-ANALYZER-SIMPLIFYNAME] Redundant qualifiers that can be shortened (FSAC's
/// "simplify name" / "remove redundant qualifier").
let simplifyNameDiagnostics (items: (range * string) list) : DiagnosticResult list =
    items
    |> List.map (fun (r, relativeName) ->
        let message =
            sprintf "Redundant qualifier; '%s' is sufficient here." relativeName
        buildDiagnostic "SLSPF0103" "Hint" message r)

/// Run the file-local FCS analyzers (unused opens, simplifiable names) and return
/// their diagnostics. These are always-on hints, independent of the dead-code gate.
let fileAnalyzerDiagnostics
    (check: FSharpCheckFileResults)
    (source: string)
    : Async<DiagnosticResult list> =
    async {
        let getLine = lineGetter source
        let! unusedOpens = UnusedOpens.getUnusedOpens(check, getLine)
        let! simplifiable = SimplifyNames.getSimplifiableNames(check, getLine)
        let simplifyItems =
            simplifiable
            |> Seq.map (fun s -> (s.Range, s.RelativeName))
            |> List.ofSeq
        return unusedOpenDiagnostics unusedOpens @ simplifyNameDiagnostics simplifyItems
    }
