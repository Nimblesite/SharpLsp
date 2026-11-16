/// [RENAME-ERRORS] The compiler judges a rename. The edits of the file that declares the
/// symbol are applied to its text and that file is checked again: an error the renamed text
/// has that the original lacked — a name its module already declares is FS0037 — refuses
/// the rename with the compiler's own message. A later file is never the judge: it would
/// see the new name before its declaration changed.
module SharpLsp.Sidecar.FSharp.FSharpRenameVerification

open System.Collections.Generic
open System.Threading
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Symbols
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp.FSharpCodeActions

/// The offset each line of `source` starts at.
let private lineStarts (source: string) =
    [| yield 0
       for index in 0 .. source.Length - 1 do
           if source[index] = '\n' then
               yield index + 1 |]

/// `source` with `edits` applied, last edit first so earlier offsets stay true.
let internal applyEdits (source: string) (edits: RawEdit list) =
    let starts = lineStarts source

    edits
    |> List.sortByDescending (fun edit -> edit.StartLine, edit.StartCharacter)
    |> List.fold
        (fun (text: string) edit ->
            let first = starts[edit.StartLine] + edit.StartCharacter
            let last = starts[edit.EndLine] + edit.EndCharacter
            text.Substring(0, first) + edit.NewText + text.Substring(last))
        source

let private errorsOf (check: FSharpCheckFileResults) =
    check.Diagnostics |> Array.filter (fun diagnostic -> diagnostic.Severity = FSharpDiagnosticSeverity.Error)

/// The first error of `after` that `before` did not have, by error number and count.
let private introduced (before: FSharpDiagnostic array) (after: FSharpDiagnostic array) =
    let known = List<int>(before |> Array.map _.ErrorNumber)
    after |> Array.tryFind (fun diagnostic -> not (known.Remove diagnostic.ErrorNumber))

let private checkedErrors state (filePath: string) (source: string) (ct: CancellationToken) =
    task {
        let! checkedFile = FSharpWorkspace.checkFileWithSource state filePath source ct
        return checkedFile |> Option.map (fun (_, check, _) -> errorsOf check)
    }

/// The file that declares `symbol`, when the rename edits it.
let private declaringFile (symbol: FSharpSymbol) (edits: RawEdit list) =
    symbol.DeclarationLocation
    |> Option.map _.FileName
    |> Option.filter (fun file -> edits |> List.exists (fun edit -> NativePaths.AreEqual(edit.FilePath, file)))

/// The compiler error the rename's `edits` would introduce in the file declaring `symbol`.
let introducedError state (symbol: FSharpSymbol) (edits: RawEdit list) (ct: CancellationToken) =
    task {
        match declaringFile symbol edits with
        | None -> return None
        | Some file ->
            let! source = FSharpWorkspace.readSourceWithCancellation state file ct
            let own = edits |> List.filter (fun edit -> NativePaths.AreEqual(edit.FilePath, file))
            let! before = checkedErrors state file source ct
            let! after = checkedErrors state file (applyEdits source own) ct

            return
                Option.map2 introduced before after
                |> Option.flatten
                |> Option.map (fun diagnostic -> $"FS{diagnostic.ErrorNumber:D4}: {diagnostic.Message}")
    }
