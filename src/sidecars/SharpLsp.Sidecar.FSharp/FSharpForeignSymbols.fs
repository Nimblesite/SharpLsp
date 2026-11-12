/// Symbols the other language's sidecar names by identity: the assembly that declares
/// them and their XML doc signature, the only names both compilers give a symbol. The
/// C# sidecar names an F# symbol this way when C# or Razor uses it, and these are its
/// F# declarations and uses. Implements [DEFINITION-CROSSLANG-IDENTITY],
/// [REFERENCES-CROSS-LANGUAGE] and [RENAME-CROSSLANGUAGE].
module SharpLsp.Sidecar.FSharp.FSharpForeignSymbols

open System
open System.Threading
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
let internal usesInFile state assemblyName xmlDocSig filePath (ct: CancellationToken) =
    task {
        let! fileCheck = FSharpWorkspace.checkFileWithCancellation state filePath ct
        let checkResults, _ = requireCheckedFile filePath fileCheck
        return
            checkResults.GetAllUsesOfAllSymbolsInFile()
            |> Seq.filter (matches assemblyName xmlDocSig)
            |> Seq.toArray
    }

/// Every use in `files` of the symbol `assemblyName` and `xmlDocSig` name, file by file.
let internal usesIn state assemblyName xmlDocSig (files: string array) (ct: CancellationToken) =
    task {
        let collected = ResizeArray<FSharpSymbolUse>()
        for filePath in files do
            ct.ThrowIfCancellationRequested()
            let! uses = usesInFile state assemblyName xmlDocSig filePath ct
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
            let! uses = usesIn state identity.AssemblyName identity.XmlDocSig files System.Threading.CancellationToken.None
            return FSharpReferences.nameLocations state (query uses)
    }

let private isDefinition (symbolUse: FSharpSymbolUse) = symbolUse.IsFromDefinition

/// `signature` without its parameter list.
let private withoutParameters (signature: string) =
    match signature.IndexOf '(' with
    | -1 -> signature
    | at -> signature[.. at - 1]

/// The types enclosing `name`, innermost first.
let rec private enclosingTypes (name: string) =
    match name.LastIndexOf '.' with
    | -1 -> []
    | at -> $"T:{name[.. at - 1]}" :: enclosingTypes name[.. at - 1]

/// The types enclosing the member `signature` names. Every member F# generates (`Equals`,
/// `Tag`, `Data0`) is declared nowhere but in its type. A type that F# does not declare has
/// no such fallback: it is simply not F#'s.
let private enclosingTypesOfMember (signature: string) =
    if signature.StartsWith("T:", StringComparison.Ordinal) then []
    else enclosingTypes ((withoutParameters signature).Substring 2)

/// The names C# reads an F# union case by: its property and `Is` test, and its factory.
let private compiledCaseNames (case: FSharpUnionCase) =
    let union = (case.ReturnType.TypeDefinition.XmlDocSig).Substring 2
    [ $"P:{union}.{case.Name}"; $"P:{union}.Is{case.Name}"; $"M:{union}.New{case.Name}" ]

/// The signature C# reads an F# field by, where FCS's differs: a union field's names its
/// case, and an enum member's calls it a property.
let private compiledFieldNames (field: FSharpField) =
    match field.DeclaringUnionCase with
    | Some case -> [ $"P:{case.XmlDocSig.Substring 2}.{field.Name}" ]
    | None when field.DeclaringEntity |> Option.exists _.IsEnum -> [ $"F:{field.XmlDocSig.Substring 2}" ]
    | None -> []

/// The signature FCS names a declaration by, except a union field's, which is its case's,
/// and a namespace's, which declares no symbol anyone navigates to.
let private declaredName (symbol: FSharpSymbol) =
    match symbol with
    | :? FSharpField as field when field.DeclaringUnionCase.IsSome -> ""
    | :? FSharpEntity as entity when entity.IsNamespace -> ""
    | _ -> xmlDocSignature symbol

/// The signatures C# compiles `symbol` to, beside the one both compilers share.
let private compiledNames (symbol: FSharpSymbol) =
    match symbol with
    | :? FSharpUnionCase as case -> compiledCaseNames case
    | :? FSharpField as field -> compiledFieldNames field
    | _ -> []

/// Of `definitions`, those the signature names: the declaration itself, else the F# construct
/// C# reads under a compiled name, else the nearest enclosing type.
let private declaredBy (signature: string) (definitions: FSharpSymbolUse seq) =
    let named test = definitions |> Seq.filter (fun definition -> test definition.Symbol) |> Seq.toArray
    let exact = named (fun symbol -> declaredName symbol = signature)
    if exact.Length > 0 then
        exact
    else
        let compiled = named (compiledNames >> List.contains (withoutParameters signature))
        if compiled.Length > 0 then
            compiled
        else
            enclosingTypesOfMember signature
            |> List.tryPick (fun enclosing ->
                match named (fun symbol -> declaredName symbol = enclosing) with
                | [||] -> None
                | found -> Some found)
            |> Option.defaultValue [||]

/// Every declaration of the assembly `assemblyName` in `files`.
let private definitionsIn state assemblyName (files: string array) =
    task {
        let collected = ResizeArray<FSharpSymbolUse>()
        for filePath in files do
            let! fileCheck = FSharpWorkspace.checkFile state filePath
            let checkResults, _ = requireCheckedFile filePath fileCheck
            checkResults.GetAllUsesOfAllSymbolsInFile()
            |> Seq.filter (fun symbolUse ->
                isDefinition symbolUse
                && String.Equals(assemblyNameOf symbolUse.Symbol, assemblyName, StringComparison.Ordinal))
            |> collected.AddRange
        return collected.ToArray()
    }

/// Where F# declares the symbol `identity` names, by the name of each declaration, however
/// the compiler compiled it. Never decompiled source while the source is here. A symbol no
/// loaded F# project declares has none. [DEFINITION-CROSSLANG-IDENTITY]
let declarations (state: FSharpWorkspace.FSharpWorkspaceState) identity (_: bool) =
    task {
        if not state.IsLoaded
           || String.IsNullOrWhiteSpace identity.AssemblyName
           || String.IsNullOrWhiteSpace identity.XmlDocSig then
            return []
        else
            let files = scopeOf state identity.AssemblyName
            let! definitions = definitionsIn state identity.AssemblyName files
            return FSharpReferences.nameLocations state (declaredBy identity.XmlDocSig definitions)
    }

/// Every F# use of the symbol `identity` names, and its F# declaration when
/// `includeDeclaration` asks for it. [REFERENCES-CROSS-LANGUAGE]
let uses state identity includeDeclaration =
    inScope state identity (Seq.filter (fun symbolUse -> includeDeclaration || not (isDefinition symbolUse)))
