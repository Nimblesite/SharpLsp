/// F# projects that reference F# projects. A reference the project's options do not
/// already carry — hand-built options never carry an F# one — reaches it as an FCS
/// in-memory reference to the referenced project's CURRENT options, never its built
/// DLL. So an unsaved edit crosses the reference, navigation lands in the referenced
/// source, and a solution nobody built still checks clean. A reference MSBuild already
/// resolved stands: a multi-targeted project's design-time command line names the
/// build of the referenced project ITS framework compiles against, which the
/// referenced project's own active framework need not be. A reference into the other
/// language stays a binary reference ([DEFINITION-CROSSLANG]).
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

/// `options` with every F# project it references, and its options do not, wired in
/// transitively. `current` is a loaded project's own options and `referencesOf` its F#
/// references; a cycle — which MSBuild refuses anyway — stops at the project already
/// being wired.
let wire
    (current: string -> FSharpProjectOptions option)
    (referencesOf: string -> string list)
    (options: FSharpProjectOptions)
    =
    let rec wireFrom (trail: string list) (options: FSharpProjectOptions) =
        let trail = options.ProjectFileName :: trail

        match
            referencesOf options.ProjectFileName
            |> List.filter (fun reference -> not (trail |> List.exists (fun seen -> NativePaths.AreEqual(seen, reference))))
            |> List.choose current
            |> List.filter (alreadyReferences options >> not)
        with
        | [] -> options
        | references -> withReferences options (references |> List.map (wireFrom trail))

    wireFrom [] options
