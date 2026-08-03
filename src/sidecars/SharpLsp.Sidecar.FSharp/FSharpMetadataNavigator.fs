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

/// (assemblyFile, typeFullName, declName, searchPattern) for an external symbol,
/// or None when it is not a decompilable metadata symbol.
let private describe (symbol: FSharpSymbol) : (string * string * string * string) option =
    let forEntity (ent: FSharpEntity) (declName: string) (pattern: string) =
        match ent.Assembly.FileName, ent.TryFullName with
        | Some file, Some fullName when not (String.IsNullOrEmpty file) ->
            Some(file, fullName, declName, pattern)
        | _ -> None

    match symbol with
    | :? FSharpEntity as ent -> forEntity ent ent.CompiledName $" {ent.CompiledName}"
    | :? FSharpMemberOrFunctionOrValue as mfv ->
        match mfv.DeclaringEntity with
        | Some ent ->
            let name = mfv.CompiledName
            // The plain-name fallback in MetadataDecompiler.FindDeclaration covers
            // any pattern that does not match, so an approximate pattern is fine.
            let pattern =
                if mfv.IsConstructor then $"{ent.CompiledName}("
                elif mfv.IsProperty || mfv.IsPropertyGetterMethod then $" {name} "
                else $" {name}("
            forEntity ent name pattern
        | None -> None
    | :? FSharpField as field ->
        match field.DeclaringEntity with
        | Some ent -> forEntity ent field.Name $" {field.Name}"
        | None -> None
    | _ -> None

/// Resolve an external (metadata) symbol to a decompiled source location.
/// Returns (filePath, startLine, startCharacter, endLine, endCharacter), or None
/// when the symbol is not external or decompilation fails.
let tryResolve (symbol: FSharpSymbol) : (string * int * int * int * int) option =
    match describe symbol with
    | None -> None
    | Some(assemblyFile, typeFullName, declName, pattern) ->
        match
            MetadataDecompiler.DecompileTypeToFile(assemblyFile, typeFullName, typeFullName)
            |> Option.ofObj
        with
        | None -> None
        | Some filePath ->
            let position = MetadataDecompiler.FindDeclaration(filePath, declName, pattern)
            Some(
                filePath,
                position.Line,
                position.Character,
                position.Line,
                position.Character + declName.Length
            )
