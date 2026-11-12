/// Go to implementation for F#: the overrides and interface implementations of an
/// abstract member, and the types that derive from or implement a type, in every
/// project that can see the symbol. Implements [DEFINITION-FSHARP-IMPLEMENTATION].
module SharpLsp.Sidecar.FSharp.FSharpImplementations

open FSharp.Compiler.Symbols
open Serilog

/// Whether `ty` names the type `target`.
let private names (target: FSharpEntity) (ty: FSharpType) =
    ty.HasTypeDefinition && target.IsEffectivelySameAs(ty.TypeDefinition :> FSharpSymbol)

/// Whether `candidate` directly derives from or implements `target`.
let internal derivesFrom (target: FSharpEntity) (candidate: FSharpEntity) =
    candidate.BaseType |> Option.exists (names target)
    || candidate.DeclaredInterfaces |> Seq.exists (names target)

/// Whether `candidate` overrides or implements the abstract slot `slot`.
let private implementsSlot (slot: FSharpMemberOrFunctionOrValue) (candidate: FSharpMemberOrFunctionOrValue) =
    let isSlot (signature: FSharpAbstractSignature) =
        signature.Name = slot.CompiledName
        && slot.DeclaringEntity |> Option.exists (fun declaring -> names declaring signature.DeclaringType)

    candidate.IsOverrideOrExplicitInterfaceImplementation
    && candidate.ImplementedAbstractSignatures |> Seq.exists isSlot

/// Whether the symbol `candidate` defines implements `target`.
let private implements (target: FSharpSymbol) (candidate: FSharpSymbol) =
    match target, candidate with
    | (:? FSharpMemberOrFunctionOrValue as slot), (:? FSharpMemberOrFunctionOrValue as overriding) ->
        implementsSlot slot overriding
    | (:? FSharpEntity as baseType), (:? FSharpEntity as derived) -> derivesFrom baseType derived
    | _ -> false

/// The names of the definitions that implement `target`, in its project and its readers.
let private implementationsOf (state: FSharpWorkspace.FSharpWorkspaceState) filePath (target: FSharpSymbol) ct =
    task {
        let anchor = FSharpWorkspace.anchorOf state target filePath
        let! projects = FSharpWorkspace.checkAllWithCancellation state (FSharpWorkspace.queryScope state anchor) ct

        return
            projects
            |> Seq.collect _.GetAllUsesOfAllSymbols()
            |> Seq.filter (fun symbolUse -> symbolUse.IsFromDefinition && implements target symbolUse.Symbol)
            |> FSharpReferences.nameLocations state
    }

/// The implementations of the symbol at a position. A symbol nothing implements is its
/// own implementation, as in C#: a concrete member or a sealed type navigates to itself.
let getImplementations (state: FSharpWorkspace.FSharpWorkspaceState) filePath line character ct =
    task {
        try
            match! FSharpWorkspace.checkFileWithCancellation state filePath ct with
            | None -> return []
            | Some(checkResults, source) ->
                match FSharpWorkspace.getSymbolUse checkResults source line character with
                | None -> return []
                | Some symbolUse ->
                    match! implementationsOf state filePath symbolUse.Symbol ct with
                    | [] ->
                        ct.ThrowIfCancellationRequested()
                        let! itself = FSharpWorkspace.getDefinition state filePath line character
                        return Option.toList itself
                    | found -> return found
        with ex ->
            Log.Debug(ex, "[F# Implementation] failed")
            return []
    }
