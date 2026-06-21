/// Signature help for the F# sidecar via FCS GetMethods.
/// Resolves the method/constructor call enclosing the caret and surfaces its
/// overloads as LSP SignatureInformation. Implements [FS-SIGHELP].
module SharpLsp.Sidecar.FSharp.FSharpSignature

open FSharp.Compiler.EditorServices
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

/// True for characters that can appear in a (possibly qualified) F# identifier.
let private isNamePart (c: char) : bool =
    System.Char.IsLetterOrDigit c || c = '_' || c = '\'' || c = '.'

/// From a line and a 0-based caret, find the call the caret sits inside: the
/// nearest unmatched '(' to the left and the qualified identifier before it.
/// Returns the column at the end of that identifier and its dotted name parts.
/// Public for direct unit testing of the pure parsing logic.
let nameBeforeParen (lineText: string) (caret: int) : (int * string list) option =
    let upper = min (caret - 1) (lineText.Length - 1)
    if upper < 0 then
        None
    else
        // Walk left tracking paren depth; stop at the '(' that opened the call.
        let mutable depth = 0
        let mutable i = upper
        let mutable openIdx = -1
        while i >= 0 && openIdx < 0 do
            match lineText[i] with
            | ')' -> depth <- depth + 1
            | '(' -> if depth = 0 then openIdx <- i else depth <- depth - 1
            | _ -> ()
            i <- i - 1
        if openIdx < 0 then
            None
        else
            // Collect the identifier immediately preceding the '('.
            let mutable nameEnd = openIdx
            while nameEnd > 0 && lineText[nameEnd - 1] = ' ' do
                nameEnd <- nameEnd - 1
            let mutable nameStart = nameEnd
            while nameStart > 0 && isNamePart lineText[nameStart - 1] do
                nameStart <- nameStart - 1
            if nameStart >= nameEnd then
                None
            else
                let raw = lineText.Substring(nameStart, nameEnd - nameStart)
                let parts = raw.Split('.') |> Array.filter (fun p -> p <> "") |> Array.toList
                if parts.IsEmpty then None else Some(nameEnd, parts)

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

/// Pure resolution of signature help from a checked file. Extracted so
/// `signatureHelp`'s `task` is a single bind + single return (FS3511).
let private resolveSignatures
    (checkData: (FSharp.Compiler.CodeAnalysis.FSharpParseFileResults * FSharp.Compiler.CodeAnalysis.FSharpCheckFileResults * string) option)
    (line: int)
    (character: int)
    : SignatureHelp option =
    match checkData with
    | None -> None
    | Some(_parseResults, checkResults, source) ->
        let lines = source.Replace("\r\n", "\n").Split('\n')
        if line < 0 || line >= lines.Length then
            None
        else
            let lineText = lines[line]
            match nameBeforeParen lineText character with
            | None -> None
            | Some(endCol, names) ->
                let methods = checkResults.GetMethods(line + 1, endCol, lineText, Some names)
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
                          ActiveParameter = 0 }

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
