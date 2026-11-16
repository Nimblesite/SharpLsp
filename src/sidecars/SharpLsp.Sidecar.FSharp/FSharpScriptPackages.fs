/// `#r "nuget: …"` resolution off the request path. A script whose packages are not
/// resolved yet is given the options of its text without its package directives, so the
/// editor answers at once; the whole text resolves in the background and `Resolved` fires
/// when it lands. Implements [SCRIPT-FSX-NUGET].
module internal SharpLsp.Sidecar.FSharp.FSharpScriptPackages

open System
open System.Collections.Concurrent
open System.Threading.Tasks
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text
open Serilog
open SharpLsp.Sidecar.Common

/// The code of the notice a script carries while its packages are being restored.
[<Literal>]
let PendingCode = "SLSPF0002"

/// What a script's options are resolved from right now.
type Plan =
    /// Its whole text: it names no package, or its packages are resolved.
    | Whole
    /// Its text with the package directives blanked, while they resolve.
    | WithoutPackages of source: string

// Directive sets already resolved once: FCS's dependency manager answers them from its
// own cache from then on. Keys only, never compiler results.
let private settled = ConcurrentDictionary<string, unit>()
let private inFlight = ConcurrentDictionary<string, Lazy<Task>>()
let private resolved = Event<string>()

/// Fires with the script's path when its package directives have been resolved.
let Resolved = resolved.Publish

/// A `#r` or `#i` directive that names a package manager.
let private packageDirective (directive: ParsedHashDirective) =
    match directive with
    | ParsedHashDirective(("r" | "i"), [ ParsedHashDirectiveArgument.String(value, _, _) ], range)
        when value.TrimStart().StartsWith("nuget:", StringComparison.OrdinalIgnoreCase) -> Some(range, value)
    | _ -> None

/// The directive a declaration is, when it is one.
let private declared (declaration: SynModuleDecl) =
    match declaration with
    | SynModuleDecl.HashDirective(directive, _) -> Some directive
    | _ -> None

/// The package directives of `source`, from its syntax tree: those that open the file
/// and those among its declarations.
let private directives (checker: FSharpChecker) (scriptPath: string) (source: string) =
    task {
        let options = { FSharpParsingOptions.Default with SourceFiles = [| scriptPath |]; IsInteractive = true }
        let! parsed = checker.ParseFile(scriptPath, SourceText.ofString source, options) |> Async.StartAsTask
        return
            match parsed.ParseTree with
            | ParsedInput.ImplFile(ParsedImplFileInput(hashDirectives = leading; contents = modules)) ->
                let inner = modules |> List.collect (fun (SynModuleOrNamespace(decls = declarations)) -> declarations |> List.choose declared)
                leading @ inner |> List.choose packageDirective |> List.distinct
            | ParsedInput.SigFile _ -> []
    }

/// `source` with every range in `ranges` blanked, so every other position is unchanged.
let private blank (source: string) (ranges: range list) =
    let lines = source.Split('\n')
    for range in ranges do
        for line in range.StartLine .. range.EndLine do
            let text = lines[line - 1]
            let first = if line = range.StartLine then range.StartColumn else 0
            let last = if line = range.EndLine then min range.EndColumn text.Length else text.Length
            let kept = text.TrimEnd('\r').Length
            let last = min last kept
            if last > first then
                lines[line - 1] <- text.Substring(0, first) + String(' ', last - first) + text.Substring(last)
    String.Join("\n", lines)

let private keyOf (scriptPath: string) (found: (range * string) list) =
    String.Join("\n", NativePaths.NormalizeFullPath scriptPath :: (found |> List.map snd))

/// Resolve the whole text once, then let every later request use it.
let private settle (key: string) (scriptPath: string) (resolve: unit -> Task) : Task =
    task {
        try
            try
                do! resolve ()
            with ex ->
                Log.Warning(ex, "F# script package resolution failed for {Script}", scriptPath)
        finally
            settled[key] <- ()
            inFlight.TryRemove key |> ignore
            Log.Information("F# script packages resolved for {Script}", scriptPath)
            resolved.Trigger scriptPath
    }

/// Decide what `source` is resolved from, starting the background resolution of its
/// packages when they are not resolved yet. `resolve` resolves the whole text.
let plan (checker: FSharpChecker) (scriptPath: string) (source: string) (resolve: unit -> Task) =
    task {
        let! found = directives checker scriptPath source
        let key = keyOf scriptPath found
        if found.IsEmpty || settled.ContainsKey key then
            return Whole
        else
            let start = Lazy<Task>(fun () -> Task.Run<unit>(fun () -> task { do! settle key scriptPath resolve }) :> Task)
            inFlight.GetOrAdd(key, start).Value |> ignore
            return WithoutPackages(blank source (found |> List.map fst))
    }
