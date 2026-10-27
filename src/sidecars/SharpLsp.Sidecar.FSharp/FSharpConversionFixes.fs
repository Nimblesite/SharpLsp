/// F# quick fix for a primitive type mismatch (FS0001): wrap the expression in
/// the conversion that bridges the two types. The types come from FCS's typed
/// diagnostic data, displayed as F# writes them — never parsed out of the
/// message. Implements [ANALYZERS-FSAC-CODEFIX-COMPILER].
module SharpLsp.Sidecar.FSharp.FSharpConversionFixes

// FS0057: TypeMismatchDiagnosticExtendedData, FCS's structured data for FS0001,
// is still flagged experimental. The only alternative is parsing the message,
// which FCS localizes. A change to the API breaks this file's build, loudly.
#nowarn "57"

open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Diagnostics.ExtendedData
open FSharp.Compiler.Text
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

/// The conversion function that turns `actual` into `expected`, when one does.
let private conversionFunction =
    function
    | "float", "int"
    | "float", "decimal" -> Some "float"
    | "int", "float" -> Some "int"
    | "string", _ -> Some "string"
    | "float32", "float" -> Some "float32"
    | "float", "float32" -> Some "float"
    | "int64", "int"
    | "int64", "float" -> Some "int64"
    | "int", "int64" -> Some "int"
    | _ -> None

/// The expected and actual types of a mismatch, as F# displays them.
let private mismatchTypes (diagnostic: FSharpDiagnostic) : (string * string) option =
    diagnostic.ExtendedData
    |> Option.bind (box >> tryUnbox<TypeMismatchDiagnosticExtendedData>)
    |> Option.map (fun mismatch ->
        mismatch.ExpectedType.Format mismatch.DisplayContext, mismatch.ActualType.Format mismatch.DisplayContext)

/// "Convert to T using 'f'" for the expression FS0001 rejected.
let conversions source filePath (diagnostic: FSharpDiagnostic) : GeneratedAction list =
    let r = diagnostic.Range
    let expression = FSharpLocalAnalysis.textOf (FSharpLocalAnalysis.lineGetter source) r

    (mismatchTypes diagnostic, expression |> Option.filter ((<>) ""))
    ||> Option.map2 (fun types text -> types, text)
    |> Option.bind (fun ((expected, actual), text) ->
        conversionFunction (expected, actual)
        |> Option.map (fun conversion ->
            FSharpQuickFix.replace $"Convert to {expected} using '{conversion}'" false filePath r $"({conversion} {text})"))
    |> Option.toList
