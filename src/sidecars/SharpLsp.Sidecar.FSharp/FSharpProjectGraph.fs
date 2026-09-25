/// F# projects that reference F# projects. Every such reference reaches the referenced
/// project as an FCS in-memory reference, never its built DLL: an unsaved edit crosses the
/// reference, navigation lands in the referenced source, and a solution nobody built still
/// checks clean. A reference MSBuild resolved reads the build of the referenced project
/// MSBuild picked for it — a multi-targeted project's framework names that build, which
/// the referenced project's own active framework need not be — under the `-r:` MSBuild
/// wrote. A reference the options do not carry — hand-built options never carry an F# one
/// — reads the referenced project's CURRENT options. A reference into the other language
/// stays a binary reference ([DEFINITION-CROSSLANG]).
/// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES] (GitHub #165).
module SharpLsp.Sidecar.FSharp.FSharpProjectGraph

open System
open System.IO
open FSharp.Compiler.CodeAnalysis
open SharpLsp.Sidecar.Common

/// The F# projects `fsprojPath` references, as absolute project paths.
let fsharpReferences (fsprojPath: string) : string list =
    FSharpProjectLoading.referencedProjects ".fsproj" fsprojPath |> List.ofSeq

/// The value of `flag` when it is one of `prefixes`.
let private valueOf (prefixes: string list) (flag: string) =
    FSharpProjectLoading.flagValue prefixes flag |> Option.map snd

/// Where `options` writes its assembly, absolute: the file a referencing `-r:` names.
let outputOf (options: FSharpProjectOptions) =
    let directory = Path.GetDirectoryName options.ProjectFileName |> string
    let stem = Path.GetFileNameWithoutExtension options.ProjectFileName |> string

    options.OtherOptions
    |> Array.tryPick (valueOf [ "--out:"; "-o:" ])
    |> Option.defaultValue $"{stem}.dll"
    |> fun output -> Path.GetFullPath(Path.Combine(directory, output))

/// A file name compared the way the file system compares it.
let private fileKey (path: string) =
    let name = Path.GetFileName path |> string
    if OperatingSystem.IsWindows() then name.ToUpperInvariant() else name

/// True when `options` already reference `referenced`'s assembly by name: MSBuild
/// resolved that project reference itself.
let private alreadyReferences (options: FSharpProjectOptions) (referenced: FSharpProjectOptions) =
    let name = fileKey (outputOf referenced)

    options.OtherOptions
    |> Array.exists (valueOf [ "-r:"; "--reference:" ] >> Option.exists (fun path -> fileKey path = name))

/// `options` referencing each of `references` in memory.
let withReferences (options: FSharpProjectOptions) (references: FSharpProjectOptions list) =
    let outputs = references |> List.map outputOf

    { options with
        OtherOptions = Array.append options.OtherOptions (outputs |> List.map (fun output -> $"-r:{output}") |> Array.ofList)
        ReferencedProjects =
            Array.append
                options.ReferencedProjects
                (List.map2 (fun output referenced -> FSharpReferencedProject.FSharpReference(output, referenced)) outputs references
                 |> Array.ofList) }

/// A build of a referenced F# project, and the assembly path a referencing `-r:` names it by.
[<NoComparison; NoEquality>]
type ReferencedBuild =
    { Reference: string
      Options: FSharpProjectOptions }

/// The value of `options`' own `-r:` naming `path`. FCS reads an in-memory reference in
/// place of the `-r:` whose value is that reference's file name, character for character.
let private argumentNaming (options: FSharpProjectOptions) (path: string) =
    options.OtherOptions
    |> Array.tryPick (valueOf [ "-r:"; "--reference:" ] >> Option.filter (fun value -> NativePaths.AreEqual(value, path)))

/// `options` reading each build in memory under the `-r:` value that already names it.
let private readingBuilds (options: FSharpProjectOptions) (builds: (string * FSharpProjectOptions) list) =
    { options with
        ReferencedProjects =
            Array.append options.ReferencedProjects (builds |> List.map FSharpReferencedProject.FSharpReference |> Array.ofList) }

/// `options` with every F# project it references wired in memory, transitively: a
/// reference MSBuild resolved to the build `builtFor` names for it, one the options do not
/// carry to the referenced project's `current` options. `referencesOf` is a project's F#
/// references. A cycle — which MSBuild refuses anyway — stops at the project already
/// being wired.
let wireAll
    (current: string -> FSharpProjectOptions option)
    (referencesOf: string -> string list)
    (builtFor: FSharpProjectOptions -> ReferencedBuild list)
    (options: FSharpProjectOptions)
    =
    let rec wireFrom (trail: string list) (options: FSharpProjectOptions) =
        let trail = options.ProjectFileName :: trail
        let unseen (project: string) = trail |> List.exists (fun seen -> NativePaths.AreEqual(seen, project)) |> not

        let resolved =
            builtFor options
            |> List.filter (fun build -> unseen build.Options.ProjectFileName)
            |> List.choose (fun build -> argumentNaming options build.Reference |> Option.map (fun argument -> argument, wireFrom trail build.Options))

        let dropped =
            referencesOf options.ProjectFileName |> List.filter unseen |> List.choose current |> List.filter (alreadyReferences options >> not)

        match resolved, dropped with
        | [], [] -> options
        | _ -> withReferences (readingBuilds options resolved) (dropped |> List.map (wireFrom trail))

    wireFrom [] options

/// `options` wired with nothing known of the builds MSBuild picked: a reference it
/// resolved stands, and one the options do not carry reads its project's `current` options.
let wire (current: string -> FSharpProjectOptions option) (referencesOf: string -> string list) (options: FSharpProjectOptions) =
    wireAll current referencesOf (fun _ -> []) options
