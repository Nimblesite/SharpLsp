/// F# projects that reference F# projects. A referenced project reaches the one that
/// uses it as an FCS in-memory reference to its CURRENT options — never its built
/// DLL — so an unsaved edit crosses the reference, navigation lands in the referenced
/// source, and a solution nobody built still checks clean. A reference into the other
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

/// True when `flag` references a file named like one of `names`.
let private referencesOneOf (names: Set<string>) (flag: string) =
    valueOf [ "-r:"; "--reference:" ] flag
    |> Option.exists (fileKey >> names.Contains)

/// `options` referencing each of `references` in memory. A `-r:` to a file of the same
/// name — the DLL MSBuild resolved for that project reference — gives way to it.
let withReferences (options: FSharpProjectOptions) (references: FSharpProjectOptions list) =
    let outputs = references |> List.map outputOf
    let names = outputs |> List.map fileKey |> Set.ofList

    { options with
        OtherOptions =
            Array.append
                (options.OtherOptions |> Array.filter (referencesOneOf names >> not))
                (outputs |> List.map (fun output -> $"-r:{output}") |> Array.ofList)
        ReferencedProjects =
            Array.append
                options.ReferencedProjects
                (List.map2 (fun output referenced -> FSharpReferencedProject.FSharpReference(output, referenced)) outputs references
                 |> Array.ofList) }

/// `options` with every F# project it references wired in, transitively. `current` is a
/// loaded project's own options and `referencesOf` its F# references; a cycle — which
/// MSBuild refuses anyway — stops at the project already being wired.
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
        with
        | [] -> options
        | references -> withReferences options (references |> List.map (wireFrom trail))

    wireFrom [] options
