/// F# sidecar: hosts FSharp.Compiler.Service.
/// Registers handlers for workspace loading, hover, etc.
namespace SharpLsp.Sidecar.FSharp

open System
open System.Threading
open System.Threading.Tasks
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.Common.Solutions
open MessagePack

type FSharpSidecar() =
    inherit SidecarHost("fsharp")

    let workspace = FSharpWorkspace.create ()
    let codeFixState = FSharpCodeFixes.createState ()
    let mutable analyzerConfig = FSharpAnalyzers.AnalyzerConfig.Default

    do
        // Analyzer configuration push from the host ([analyzers] in sharplsp.toml).
        base.Register("analyzers/configure", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            try
                let req = MessagePackSerializer.Deserialize<AnalyzerConfigRequest>(payload, cancellationToken = ct)
                analyzerConfig <- FSharpAnalyzers.AnalyzerConfig.Create(req.DeadCode, req.Monorepo)
                Task.FromResult<ByteResult>(Helpers.serializeOk "ok" ct)
            with ex ->
                Task.FromResult<ByteResult>(ByteResult.Failure(ex.Message))))
        base.Register("workspace/open", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let path = MessagePackSerializer.Deserialize<string>(payload, cancellationToken = ct)
                    let! result = FSharpWorkspace.loadProjectWithCancellation workspace path ct
                    match result with
                    | Ok () ->
                        return Helpers.serializeOk "ok" ct
                    | Error msg ->
                        return ByteResult.Failure(msg)
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        base.Register("solution/read", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let path = MessagePackSerializer.Deserialize<string>(payload, cancellationToken = ct)
                    let! result = SolutionFileReader.ReadAsync(path, ct)
                    if result.IsError then
                        return ByteResult.Failure(result.Match((fun _ -> String.Empty), (fun err -> err)))
                    else
                        let model = result.Match((fun value -> value), (fun err -> invalidOp err))
                        return Helpers.serializeOk model ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        base.Register("workspace/status", Func<byte[], CancellationToken, Task<ByteResult>>(fun _payload ct ->
            try
                let status = if workspace.IsLoaded then "loaded" else "not_loaded"
                Task.FromResult<ByteResult>(Helpers.serializeOk status ct)
            with ex ->
                Task.FromResult<ByteResult>(ByteResult.Failure(ex.Message))))

        base.Register("textDocument/hover", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! hover = FSharpWorkspace.getHover workspace request.FilePath request.Line request.Character
                    match hover with
                    | Some (markdown, sl, sc, el, ec) ->
                        let result =
                            { Contents = markdown
                              StartLine = Nullable sl
                              StartCharacter = Nullable sc
                              EndLine = Nullable el
                              EndCharacter = Nullable ec }
                        return Helpers.serializeOk result ct
                    | None ->
                        // Return MessagePack nil (0xC0) for no hover result.
                        let bytes = [| 0xC0uy |]
                        return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Records the editor's in-memory buffer so per-file analyses (hover,
        // completion, …) reflect unsaved edits instead of stale on-disk text.
        // Mirrors the C# sidecar's didChange overlay. [FS-DIDCHANGE-OVERLAY]
        base.Register("textDocument/didChange", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<DidChangeRequest>(payload, cancellationToken = ct)
                    FSharpWorkspace.applyDidChange workspace request.FilePath request.NewText
                    return Helpers.serializeOk "ok" ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Unused-package detection [PKG-UNUSED-DETECT-FS].
        base.Register("project/unusedPackages", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let projectPath = MessagePackSerializer.Deserialize<string>(payload, cancellationToken = ct)
                    let! usage = FSharpPackages.getReferenceUsage workspace projectPath
                    let result =
                        { UsedPaths = usage.Used
                          AllPaths = usage.All
                          PackagesRoot = usage.Root }
                    return Helpers.serializeOk result ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        base.Register("textDocument/definition", Helpers.locationOptionHandler workspace FSharpWorkspace.getDefinition)
        base.Register("textDocument/typeDefinition", Helpers.locationOptionHandler workspace FSharpWorkspace.getTypeDefinition)
        base.Register("textDocument/declaration", Helpers.locationOptionHandler workspace FSharpWorkspace.getDeclaration)
        base.Register("textDocument/implementation", Helpers.locationListHandler workspace FSharpWorkspace.getImplementations)

        // References
        base.Register("textDocument/references", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<ReferencesRequest>(payload, cancellationToken = ct)
                    let! results =
                        FSharpReferences.getReferences
                            workspace request.FilePath request.Line
                            request.Character request.IncludeDeclaration
                    let locations =
                        results
                        |> List.map Helpers.toLocationResult
                        |> Array.ofList
                    return Helpers.serializeOk { Locations = locations } ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Document highlights
        base.Register("textDocument/documentHighlight", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! results =
                        FSharpReferences.getDocumentHighlights
                            workspace request.FilePath request.Line request.Character
                    let highlights =
                        results
                        |> List.map (fun h ->
                            { DocumentHighlightResult.StartLine = h.StartLine
                              StartCharacter = h.StartCharacter
                              EndLine = h.EndLine
                              EndCharacter = h.EndCharacter
                              Kind = h.Kind })
                        |> Array.ofList
                    return Helpers.serializeOk { Highlights = highlights } ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Formatting via Fantomas
        base.Register("textDocument/formatting", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! edits = FSharpFeatures.formatDocument request.FilePath
                    let bytes = MessagePackSerializer.Serialize(edits, cancellationToken = ct)
                    return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Range formatting via Fantomas
        base.Register("textDocument/rangeFormatting", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<RangeRequest>(payload, cancellationToken = ct)
                    let! edits = FSharpFeatures.formatRange request.FilePath request.StartLine request.StartCharacter request.EndLine request.EndCharacter
                    let bytes = MessagePackSerializer.Serialize(edits, cancellationToken = ct)
                    return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Semantic tokens
        base.Register("textDocument/semanticTokens/full", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! data = FSharpFeatures.getSemanticTokens workspace request.FilePath
                    let bytes = MessagePackSerializer.Serialize({ Data = data }, cancellationToken = ct)
                    return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Semantic tokens range
        base.Register("textDocument/semanticTokens/range", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<RangeRequest>(payload, cancellationToken = ct)
                    let! data = FSharpFeatures.getSemanticTokensRange workspace request.FilePath request.StartLine request.EndLine
                    let bytes = MessagePackSerializer.Serialize({ Data = data }, cancellationToken = ct)
                    return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Code actions (F# code fixes via FCS diagnostics)
        base.Register("textDocument/codeAction", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<CodeActionRequest>(payload, cancellationToken = ct)
                    let! actions =
                        FSharpCodeFixes.getCodeActions
                            codeFixState workspace
                            request.FilePath
                            request.StartLine request.StartCharacter
                            request.EndLine request.EndCharacter
                    let results =
                        actions
                        |> List.map (fun a ->
                            { Id = a.Id; Title = a.Title
                              Kind = a.Kind; IsPreferred = a.IsPreferred })
                        |> Array.ofList
                    return Helpers.serializeOk results ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Code action resolve
        base.Register("codeAction/resolve", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            try
                let request = MessagePackSerializer.Deserialize<CodeActionResolveRequest>(payload, cancellationToken = ct)
                match FSharpCodeFixes.resolveCodeAction codeFixState request.Id with
                | Some edit ->
                    let result =
                        { DocumentChanges =
                            edit.DocumentChanges
                            |> List.map (fun dc ->
                                { FilePath = dc.FilePath
                                  Edits =
                                    dc.Edits
                                    |> List.map (fun e ->
                                        { StartLine = e.StartLine
                                          StartCharacter = e.StartCharacter
                                          EndLine = e.EndLine
                                          EndCharacter = e.EndCharacter
                                          NewText = e.NewText })
                                    |> Array.ofList })
                            |> Array.ofList }
                    Task.FromResult<ByteResult>(Helpers.serializeOk result ct)
                | None ->
                    let empty = { DocumentChanges = [||] }
                    Task.FromResult<ByteResult>(Helpers.serializeOk empty ct)
            with ex ->
                Task.FromResult<ByteResult>(ByteResult.Failure(ex.Message))))

        // Inlay hints
        base.Register("textDocument/inlayHint", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<InlayHintRequest>(payload, cancellationToken = ct)
                    let! hints = FSharpFeatures.getInlayHints workspace request.FilePath request.StartLine request.EndLine
                    let bytes = MessagePackSerializer.Serialize(hints |> List.toArray, cancellationToken = ct)
                    return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Diagnostics (FCS compiler errors + FSharpLint warnings)
        base.Register("workspace/diagnostics", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let filePath = MessagePackSerializer.Deserialize<string>(payload, cancellationToken = ct)
                    let mutable results = ResizeArray<DiagnosticResult>()
                    // FCS compiler diagnostics.
                    if workspace.IsLoaded then
                        let source = System.IO.File.ReadAllText(filePath)
                        let sourceText = FSharp.Compiler.Text.SourceText.ofString source
                        let! _parse, checkAnswer =
                            workspace.Checker.ParseAndCheckFileInProject(
                                filePath, 0, sourceText, workspace.ProjectOptions.Value)
                        match checkAnswer with
                        | FSharp.Compiler.CodeAnalysis.FSharpCheckFileAnswer.Succeeded check ->
                            for d in check.Diagnostics do
                                let severity =
                                    match d.Severity with
                                    | FSharp.Compiler.Diagnostics.FSharpDiagnosticSeverity.Error -> "Error"
                                    | FSharp.Compiler.Diagnostics.FSharpDiagnosticSeverity.Warning -> "Warning"
                                    | FSharp.Compiler.Diagnostics.FSharpDiagnosticSeverity.Info -> "Info"
                                    | _ -> "Hint"
                                let r = d.Range
                                results.Add(
                                    { FilePath = filePath
                                      StartLine = r.StartLine - 1
                                      StartCharacter = r.StartColumn
                                      EndLine = r.EndLine - 1
                                      EndCharacter = r.EndColumn
                                      Message = d.Message
                                      Severity = severity
                                      Code = $"FS{d.ErrorNumber:D4}" })
                            // [FS-ANALYZER-UNUSEDOPEN]/[FS-ANALYZER-SIMPLIFYNAME]
                            // FSAC-parity file-local analyzers (always-on hints).
                            let! fileDiags = FSharpAnalyzers.fileAnalyzerDiagnostics check source
                            fileDiags |> List.iter results.Add
                        | FSharp.Compiler.CodeAnalysis.FSharpCheckFileAnswer.Aborted -> ()
                    // [FS-ANALYZER-DEADCODE] Merge project-wide dead-code diagnostics
                    // for this file (monorepo mode promotes public deadness to errors).
                    if workspace.IsLoaded && analyzerConfig.DeadCodeEnabled then
                        let! proj = FSharpWorkspace.checkProject workspace
                        match proj with
                        | Some projResults ->
                            let allUses = projResults.GetAllUsesOfAllSymbols()
                            FSharpAnalyzers.deadCodeDiagnosticsForFile analyzerConfig allUses filePath
                            |> List.iter results.Add
                        | None -> ()
                    return Helpers.serializeOk (results.ToArray()) ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Formatting preview (Fantomas diff)
        base.Register("textDocument/formattingPreview", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! preview = FSharpFeatures.formatPreview request.FilePath
                    match preview with
                    | Some result ->
                        return Helpers.serializeOk { Original = result.Original; Formatted = result.Formatted } ct
                    | None ->
                        let bytes = [| 0xC0uy |]
                        return Outcome.Result<byte[], string>.Ok<byte[], string>(bytes) :> ByteResult
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Completion [FS-COMPLETION]
        base.Register("textDocument/completion", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! items =
                        FSharpCompletion.getCompletions
                            workspace request.FilePath request.Line request.Character
                    let results = items |> List.map Helpers.toCompletionItem |> Array.ofList
                    return Helpers.serializeOk results ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Completion resolve [FS-COMPLETION-RESOLVE] — no extra edits yet (see plan).
        base.Register("completionItem/resolve", Func<byte[], CancellationToken, Task<ByteResult>>(fun _payload ct ->
            let result: CompletionResolveResultWire = { AdditionalEdits = [||] }
            Task.FromResult<ByteResult>(Helpers.serializeOk result ct)))

        // Code lens [FS-CODELENS]
        base.Register("textDocument/codeLens", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<FileRequest>(payload, cancellationToken = ct)
                    let! lenses = FSharpCodeLens.getCodeLenses workspace request.FilePath
                    let results =
                        lenses
                        |> List.map (fun (lens: FSharpCodeLens.CodeLensEntry) ->
                            { CodeLensItemResult.Line = lens.Line
                              Character = lens.Character
                              Title = lens.Title })
                        |> Array.ofList
                    return Helpers.serializeOk results ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Document symbols [FS-DOCSYMBOL]
        base.Register("textDocument/documentSymbol", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<FileRequest>(payload, cancellationToken = ct)
                    let! symbols = FSharpSymbols.documentSymbols workspace request.FilePath
                    let results = symbols |> List.map Helpers.toDocumentSymbol |> Array.ofList
                    return Helpers.serializeOk results ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Signature help [FS-SIGHELP]
        base.Register("textDocument/signatureHelp", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! help =
                        FSharpSignature.signatureHelp
                            workspace request.FilePath request.Line request.Character
                    match help with
                    | Some h -> return Helpers.serializeOk (Helpers.toSignatureHelp h) ct
                    | None -> return Helpers.nilResult ()
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Prepare rename [FS-RENAME-PREPARE]
        base.Register("textDocument/prepareRename", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! result =
                        FSharpRename.prepareRename
                            workspace request.FilePath request.Line request.Character
                    let wire =
                        match result with
                        | Some pr ->
                            { PrepareRenameResultWire.CanRename = true
                              StartLine = pr.StartLine
                              StartCharacter = pr.StartCharacter
                              EndLine = pr.EndLine
                              EndCharacter = pr.EndCharacter
                              Placeholder = pr.Placeholder }
                        | None ->
                            { PrepareRenameResultWire.CanRename = false
                              StartLine = 0
                              StartCharacter = 0
                              EndLine = 0
                              EndCharacter = 0
                              Placeholder = "" }
                    return Helpers.serializeOk wire ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Rename [FS-RENAME-APPLY]
        base.Register("textDocument/rename", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<RenameRequest>(payload, cancellationToken = ct)
                    let! edits =
                        FSharpRename.rename
                            workspace request.FilePath request.Line request.Character request.NewName
                    return Helpers.serializeOk (Helpers.toWorkspaceEdit edits) ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Call hierarchy [FS-CALLHIER-PREPARE]
        base.Register("textDocument/prepareCallHierarchy", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! item =
                        FSharpHierarchy.prepareCall
                            workspace request.FilePath request.Line request.Character
                    match item with
                    | Some i -> return Helpers.serializeOk (Helpers.toHierItem i) ct
                    | None -> return Helpers.nilResult ()
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Call hierarchy [FS-CALLHIER-INCOMING]
        base.Register("callHierarchy/incomingCalls", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! items =
                        FSharpHierarchy.incomingCalls
                            workspace request.FilePath request.Line request.Character
                    let results = items |> List.map Helpers.toHierItem |> Array.ofList
                    return Helpers.serializeOk results ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Call hierarchy [FS-CALLHIER-OUTGOING]
        base.Register("callHierarchy/outgoingCalls", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! items =
                        FSharpHierarchy.outgoingCalls
                            workspace request.FilePath request.Line request.Character
                    let results = items |> List.map Helpers.toHierItem |> Array.ofList
                    return Helpers.serializeOk results ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Type hierarchy [FS-TYPEHIER-PREPARE]
        base.Register("textDocument/prepareTypeHierarchy", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! item =
                        FSharpHierarchy.prepareType
                            workspace request.FilePath request.Line request.Character
                    match item with
                    | Some i -> return Helpers.serializeOk (Helpers.toHierItem i) ct
                    | None -> return Helpers.nilResult ()
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Type hierarchy [FS-TYPEHIER-SUPER]
        base.Register("typeHierarchy/supertypes", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! items =
                        FSharpHierarchy.supertypes
                            workspace request.FilePath request.Line request.Character
                    let results = items |> List.map Helpers.toHierItem |> Array.ofList
                    return Helpers.serializeOk results ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))

        // Type hierarchy [FS-TYPEHIER-SUB]
        base.Register("typeHierarchy/subtypes", Func<byte[], CancellationToken, Task<ByteResult>>(fun payload ct ->
            task {
                try
                    let request = MessagePackSerializer.Deserialize<PositionRequest>(payload, cancellationToken = ct)
                    let! items =
                        FSharpHierarchy.subtypes
                            workspace request.FilePath request.Line request.Character
                    let results = items |> List.map Helpers.toHierItem |> Array.ofList
                    return Helpers.serializeOk results ct
                with ex ->
                    return ByteResult.Failure(ex.Message)
            }))
