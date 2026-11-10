/// Signature help for the F# sidecar via FCS GetMethods. Implements [FS-SIGHELP].
/// Resolves the method/constructor call enclosing the caret and surfaces its
/// overloads as LSP SignatureInformation; the signature-help portion of
/// [SHARPLSP-FEATURES-INTELLIGENCE].
module SharpLsp.Sidecar.FSharp.FSharpSignature

open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Text
open FSharp.Compiler.Syntax
open Serilog

/// One signature (overload) in the sidecar's neutral domain shape.
type SignatureInfo =
    { Label: string
      Parameters: string list }

/// A signature-help response: the overloads plus the active indices.
type SignatureHelp =
    { Signatures: SignatureInfo list
      ActiveSignature: int
      ActiveParameter: int }

/// Confirm the opener is a real parenthesized expression, including incomplete calls.
let private hasOpener (parseResults: FSharpParseFileResults) opener =
    let visitor =
        { new SyntaxVisitorBase<bool>() with
            member _.VisitExpr(_, _, defaultTraverse, expression) =
                match expression with
                | SynExpr.Paren(leftParenRange = range)
                | SynExpr.Const(SynConst.Unit, range) when Position.posEq opener range.Start -> Some true
                | _ -> defaultTraverse expression }
    SyntaxTraversal.Traverse(opener, parseResults.ParseTree, visitor) |> Option.defaultValue false

/// Resolve the enclosing parenthesized call from the cached syntax tree.
let nameBeforeParen (parseResults: FSharpParseFileResults) (caret: pos) =
    parseResults.FindParameterLocations(caret)
    |> Option.filter (fun locations -> hasOpener parseResults locations.OpenParenLocation)
    |> Option.filter (fun locations ->
        not locations.IsThereACloseParen
        || (locations.TupleEndLocations
            |> Array.tryLast
            |> Option.forall (fun ending -> Position.posLt caret ending)))
    |> Option.map (fun locations -> locations.LongIdEndLocation, locations.LongId)

/// Render a method-group parameter to a display label (name when available).
let private paramLabel (p: MethodGroupItemParameter) : string =
    if System.String.IsNullOrEmpty p.ParameterName then
        p.Display |> Array.map (fun t -> t.Text) |> String.concat ""
    else
        p.ParameterName

/// Map one FCS method/overload to a domain signature.
let private toSignature (methodName: string) (m: MethodGroupItem) : SignatureInfo =
    let parameters = m.Parameters |> Array.map paramLabel |> Array.toList
    let joined = System.String.Join(", ", parameters)
    { Label = $"{methodName}({joined})"
      Parameters = parameters }

/// Named arguments select their declaration's parameter; positional arguments follow commas.
let private activeParameter
    (parseResults: FSharpParseFileResults) caret (parameters: string list) =
    parseResults.FindParameterLocations(caret)
    |> Option.map (fun locations ->
        let argument =
            locations.TupleEndLocations
            // The final endpoint ends the call, including an unfinished argument.
            |> Array.truncate (max 0 (locations.TupleEndLocations.Length - 1))
            |> Array.takeWhile (fun ending -> Position.posGeq caret ending)
            |> Array.length
        locations.NamedParamNames
        |> Array.tryItem argument
        |> Option.flatten
        |> Option.bind (fun name -> parameters |> List.tryFindIndex ((=) name))
        |> Option.defaultValue (min argument (max 0 (parameters.Length - 1))))
    |> Option.defaultValue 0

/// Pure resolution of signature help from a checked file. Extracted so
/// `signatureHelp`'s `task` is a single bind + single return (FS3511).
let private resolveSignatures
    (checkData: (FSharp.Compiler.CodeAnalysis.FSharpParseFileResults * FSharp.Compiler.CodeAnalysis.FSharpCheckFileResults * string) option)
    (line: int)
    (character: int)
    : SignatureHelp option =
    match checkData with
    | None -> None
    | Some(parseResults, checkResults, source) ->
        let lines = source.Replace("\r\n", "\n").Split('\n')
        if line < 0 || line >= lines.Length then
            None
        else
            let caret = Position.mkPos (line + 1) character
            match nameBeforeParen parseResults caret with
            | None -> None
            | Some(callee, names) ->
                let methods = checkResults.GetMethods(callee.Line, callee.Column, lines[callee.Line - 1], Some names)
                if methods.Methods.Length = 0 then
                    None
                else
                    let signatures =
                        methods.Methods
                        |> Array.map (toSignature methods.MethodName)
                        |> Array.toList
                    Some
                        { Signatures = signatures
                          ActiveSignature = 0
                          ActiveParameter =
                            signatures
                            |> List.tryHead
                            |> Option.map (fun signature ->
                                activeParameter parseResults (Position.mkPos (line + 1) character) signature.Parameters)
                            |> Option.defaultValue 0 }

/// Signature help at a 0-based position in an F# file.
let signatureHelp
    (state: FSharpWorkspace.FSharpWorkspaceState)
    (filePath: string)
    (line: int)
    (character: int)
    =
    task {
        try
            let! checkData = FSharpWorkspace.checkFileWithParse state filePath
            return resolveSignatures checkData line character
        with ex ->
            Log.Debug(ex, "[F# SignatureHelp] failed")
            return None
    }
