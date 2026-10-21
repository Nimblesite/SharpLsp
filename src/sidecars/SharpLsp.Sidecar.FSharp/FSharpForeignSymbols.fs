/// Symbols the other language's sidecar names by identity: the assembly that declares
/// them and their XML doc signature, the only names both compilers give a symbol. The
/// C# sidecar names an F# symbol this way when C# or Razor uses it, and these are its
/// F# declarations and uses. Implements [DEFINITION-CROSSLANG-IDENTITY],
/// [REFERENCES-CROSS-LANGUAGE] and [RENAME-CROSSLANGUAGE].
module SharpLsp.Sidecar.FSharp.FSharpForeignSymbols

open System
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Symbols
open SharpLsp.Sidecar.Common

/// A symbol as both compilers name it.
[<NoComparison; NoEquality>]
type SymbolIdentity =
    { AssemblyName: string
      XmlDocSig: string }

/// The XML doc signature FCS gives `symbol`; empty for a symbol that has none.
let internal xmlDocSignature (symbol: FSharpSymbol) =
    match symbol with
    | :? FSharpEntity as entity -> entity.XmlDocSig
    | :? FSharpMemberOrFunctionOrValue as memberValue -> memberValue.XmlDocSig
    | :? FSharpField as field -> field.XmlDocSig
    | :? FSharpUnionCase as unionCase -> unionCase.XmlDocSig
    | _ -> ""

/// The simple name of the assembly that declares `symbol`; empty when FCS cannot say.
let internal assemblyNameOf (symbol: FSharpSymbol) =
    try symbol.Assembly.SimpleName |> string
    with _ -> ""

/// `symbol`'s identity, when it has both an assembly and a signature.
let internal identityOf (symbol: FSharpSymbol) =
    let assemblyName = assemblyNameOf symbol
    let xmlDocSig = xmlDocSignature symbol
    if String.IsNullOrWhiteSpace(assemblyName) || String.IsNullOrWhiteSpace(xmlDocSig) then None
    else Some { AssemblyName = assemblyName; XmlDocSig = xmlDocSig }

/// Whether `symbolUse` is a use of the symbol `assemblyName` and `xmlDocSig` name.
let internal matches assemblyName xmlDocSig (symbolUse: FSharpSymbolUse) =
    String.Equals(assemblyNameOf symbolUse.Symbol, assemblyName, StringComparison.Ordinal)
    && String.Equals(xmlDocSignature symbolUse.Symbol, xmlDocSig, StringComparison.Ordinal)

/// The check results of `filePath`; FCS failing to check a project file is an error.
let internal requireCheckedFile filePath checkedFile =
    checkedFile
    |> Option.defaultWith (fun () -> raise (InvalidOperationException($"FCS could not check {filePath}")))

/// Every use in `filePath` of the symbol `assemblyName` and `xmlDocSig` name.
let internal usesInFile state assemblyName xmlDocSig filePath =
    task {
        let! fileCheck = FSharpWorkspace.checkFile state filePath
        let checkResults, _ = requireCheckedFile filePath fileCheck
        return
            checkResults.GetAllUsesOfAllSymbolsInFile()
            |> Seq.filter (matches assemblyName xmlDocSig)
            |> Seq.toArray
    }

/// Every use in `files` of the symbol `assemblyName` and `xmlDocSig` name, file by file.
let internal usesIn state assemblyName xmlDocSig (files: string array) =
    task {
        let collected = ResizeArray<FSharpSymbolUse>()
        for filePath in files do
            let! uses = usesInFile state assemblyName xmlDocSig filePath
            collected.AddRange(uses)
        return collected.ToArray()
    }

/// Whether `entry` builds the assembly named `assemblyName`.
let private builds assemblyName (entry: FSharpDesignTime.FSharpProjectEntry) =
    String.Equals(FSharpWorkspace.parseFsprojAssemblyName entry.Path, assemblyName, StringComparison.Ordinal)

/// Whether `entry` references an assembly named `assemblyName` in any framework.
let private references assemblyName (entry: FSharpDesignTime.FSharpProjectEntry) =
    entry.Resolved.Values
    |> Seq.concat
    |> Seq.exists (fun reference ->
        String.Equals(NativePaths.StemOf reference.Assembly, assemblyName, StringComparison.Ordinal))

/// The files of `entries`' query scopes ([SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES]).
let private scopesOf state (entries: FSharpDesignTime.FSharpProjectEntry seq) =
    entries
    |> Seq.choose (fun entry -> entry.Options.SourceFiles |> Array.tryHead)
    |> Seq.collect (FSharpWorkspace.scopeSourceFiles state)
    |> Seq.distinctBy NativePaths.NormalizeFullPath
    |> Array.ofSeq

/// The files that can hold a use of a symbol of `assemblyName`: the F# project that builds
/// that assembly and every project reading it in memory; for an assembly no F# project
/// builds, the F# projects that reference it. Never every file of the workspace.
let internal scopeOf (state: FSharpWorkspace.FSharpWorkspaceState) assemblyName =
    let owners = state.Projects.Values |> Seq.filter (builds assemblyName) |> List.ofSeq
    if List.isEmpty owners then
        state.Projects.Values |> Seq.filter (references assemblyName) |> scopesOf state
    else
        scopesOf state owners

/// The names of the uses `query` keeps, of those in scope of the symbol `identity` names; an
/// unloaded workspace or an empty identity has none.
let private inScope (state: FSharpWorkspace.FSharpWorkspaceState) (identity: SymbolIdentity) query =
    task {
        if not state.IsLoaded
           || String.IsNullOrWhiteSpace identity.AssemblyName
           || String.IsNullOrWhiteSpace identity.XmlDocSig then
            return []
        else
            let files = scopeOf state identity.AssemblyName
            let! uses = usesIn state identity.AssemblyName identity.XmlDocSig files
            return FSharpReferences.nameLocations state (query uses)
    }

let private isDefinition (symbolUse: FSharpSymbolUse) = symbolUse.IsFromDefinition

/// Where F# declares the symbol `identity` names: the name of each defining use. A symbol
/// no loaded F# project declares has none. [DEFINITION-CROSSLANG-IDENTITY]
let declarations state identity (_: bool) =
    inScope state identity (Seq.filter isDefinition)

/// Every F# use of the symbol `identity` names, and its F# declaration when
/// `includeDeclaration` asks for it. [REFERENCES-CROSS-LANGUAGE]
let uses state identity includeDeclaration =
    inScope state identity (Seq.filter (fun symbolUse -> includeDeclaration || not (isDefinition symbolUse)))
