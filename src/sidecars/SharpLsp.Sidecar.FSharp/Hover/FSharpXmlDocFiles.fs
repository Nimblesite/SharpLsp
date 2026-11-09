/// The XML documentation of .NET symbols for F# hover. FCS names a referenced
/// assembly and the member's documentation id. A package documents its members
/// in the `.xml` file beside its assembly; the runtime's implementation
/// assemblies, which the sidecar compiles against, ship none, so their members
/// are documented by the matching reference pack's files. Implements
/// [HOVER-FSHARP-RENDERING] (GitHub #388).
module SharpLsp.Sidecar.FSharp.Hover.FSharpXmlDocFiles

open System
open System.Collections.Concurrent
open System.Collections.Generic
open System.IO
open System.Xml
open Serilog
open SharpLsp.Sidecar.Common

/// Documentation files are untrusted input: never a DTD.
let private settings =
    XmlReaderSettings(DtdProcessing = DtdProcessing.Prohibit, IgnoreWhitespace = true)

/// Every `<member>` of the documentation file `xmlPath` as `(id, xml)`, streamed in
/// order; a member's XML is read only when `wanted` accepts its id.
let private members (wanted: string -> bool) (xmlPath: string) =
    seq {
        use reader = XmlReader.Create(xmlPath, settings)

        while not reader.EOF do
            match reader.NodeType, reader.Name, reader.GetAttribute "name" with
            | XmlNodeType.Element, "member", NonNull id when wanted id -> yield id, Some(reader.ReadOuterXml())
            | XmlNodeType.Element, "member", NonNull id ->
                yield id, None
                reader.Skip()
            | _ -> reader.Read() |> ignore
    }

/// Every member's XML of the documentation file `xmlPath`, by id.
let private documentationOf (xmlPath: string) : IReadOnlyDictionary<string, string> =
    let documentation = Dictionary<string, string>(StringComparer.Ordinal)

    for id, xml in members (fun _ -> true) xmlPath do
        xml |> Option.iter (fun xml -> documentation.TryAdd(id, xml) |> ignore)

    documentation

/// Each documentation file's members, read once, on the first hover that needs
/// one: a hover on each overload of a `System.String` method would otherwise
/// stream the 7.6 MB `System.Runtime.xml` again.
let private files = ConcurrentDictionary<string, Lazy<IReadOnlyDictionary<string, string>>>()

/// The `<member>` XML of `memberId` in the documentation file `xmlPath`.
let private memberIn (memberId: string) (xmlPath: string) =
    if File.Exists xmlPath then
        let documentation = files.GetOrAdd(NativePaths.IdentityOf xmlPath, fun _ -> lazy documentationOf xmlPath)

        match documentation.Value.TryGetValue memberId with
        | true, xml -> Some xml
        | false, _ -> None
    else
        None

/// The reference-pack documentation directory of a shared-framework assembly:
/// `<dotnet>/shared/<framework>/<version>/` is documented by
/// `<dotnet>/packs/<framework>.Ref/<version>/ref/<tfm>/`.
let private referencePackOf (assembly: string) =
    let version = NativePaths.DirectoryOf assembly
    let framework = NativePaths.DirectoryOf version
    let shared = NativePaths.DirectoryOf framework
    let packs = NativePaths.Resolve(NativePaths.DirectoryOf shared, "packs")
    let refs = NativePaths.Resolve(packs, $"{NativePaths.NameOf framework}.Ref", NativePaths.NameOf version, "ref")

    if NativePaths.SameName(NativePaths.NameOf shared, "shared") && Directory.Exists refs then
        Directory.GetDirectories refs |> Array.sortDescending |> Array.tryHead
    else
        None

/// Which file of the documentation directory `directory` documents each member id.
let private indexOf (directory: string) : IReadOnlyDictionary<string, string> =
    let index = Dictionary<string, string>(StringComparer.Ordinal)

    for file in Directory.GetFiles(directory, "*.xml") |> Array.sort do
        for id, _ in members (fun _ -> false) file do
            index.TryAdd(id, file) |> ignore

    index

/// Each reference pack's index, built once, on the first hover that needs it.
let private indexes = ConcurrentDictionary<string, Lazy<IReadOnlyDictionary<string, string>>>()

/// The `<member>` XML of `memberId` among the documentation files of `directory`.
let private memberInPack (memberId: string) (directory: string) =
    let index = indexes.GetOrAdd(NativePaths.IdentityOf directory, fun _ -> lazy indexOf directory)

    match index.Value.TryGetValue memberId with
    | true, file -> memberIn memberId file
    | false, _ -> None

/// The `<member>` documentation of `memberId`, a symbol of the assembly `assembly`.
let tryMember (assembly: string) (memberId: string) : string option =
    try
        memberIn memberId (NativePaths.WithExtension(assembly, ".xml"))
        |> Option.orElseWith (fun () -> referencePackOf assembly |> Option.bind (memberInPack memberId))
    with ex ->
        Log.Debug(ex, "[F# Hover] documentation unreadable for {Assembly}", assembly)
        None
