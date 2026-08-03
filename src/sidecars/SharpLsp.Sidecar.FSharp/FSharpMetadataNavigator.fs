/// Metadata-as-source navigation for the F# sidecar.
///
/// When a resolved symbol is defined in another assembly — the BCL, a NuGet
/// package, or (for cross-language go-to-definition) a referenced C# project —
/// it has no F# source declaration, so FCS reports it as an external symbol.
/// This decompiles the containing type via the shared [MetadataDecompiler] and
/// locates the declaration, mirroring the C# sidecar's [MetadataNavigator] so
/// both engines produce metadata-as-source the same way.
/// Implements [DEFINITION-CROSSLANG].
module SharpLsp.Sidecar.FSharp.FSharpMetadataNavigator

open System
open FSharp.Compiler.Symbols
open SharpLsp.Sidecar.Common

let private symbolDescription (symbol: FSharpSymbol) : (FSharpEntity * string * string) option =
    match symbol with
    | :? FSharpEntity as ent -> Some(ent, ent.CompiledName, $" {ent.CompiledName}")
    | :? FSharpMemberOrFunctionOrValue as mfv ->
        // FindDeclaration also has a plain-name fallback, so this pattern only
        // needs to distinguish constructors, properties, and callable members.
        mfv.DeclaringEntity
        |> Option.map (fun ent ->
            let name = mfv.CompiledName
            let pattern = if mfv.IsConstructor then $"{ent.CompiledName}(" elif mfv.IsProperty || mfv.IsPropertyGetterMethod then $" {name} " else $" {name}("
            ent, name, pattern)
    | :? FSharpField as field ->
        field.DeclaringEntity |> Option.map (fun ent -> ent, field.Name, $" {field.Name}")
    | _ -> None

/// (assemblyFile, typeFullName, declName, searchPattern) for an external symbol,
/// or None when it is not a decompilable metadata symbol.
let private describe symbol =
    symbolDescription symbol
    |> Option.bind (fun (ent, declName, pattern) ->
        match ent.Assembly.FileName, ent.TryFullName with
        | Some file, Some fullName when not (String.IsNullOrEmpty file) ->
            Some(file, fullName, declName, pattern)
        | _ -> None)

/// Resolve an external (metadata) symbol to a decompiled source location.
/// Returns (filePath, startLine, startCharacter, endLine, endCharacter), or None
/// when the symbol is not external or decompilation fails.
let tryResolve (symbol: FSharpSymbol) : (string * int * int * int * int) option =
    describe symbol
    |> Option.bind (fun (assemblyFile, typeFullName, declName, pattern) ->
        MetadataDecompiler.DecompileTypeToFile(assemblyFile, typeFullName, typeFullName)
        |> Option.ofObj
        |> Option.map (fun filePath ->
            let position = MetadataDecompiler.FindDeclaration(filePath, declName, pattern)
            filePath, position.Line, position.Character, position.Line, position.Character + declName.Length))
