/// Runtime plumbing for overlay-aware FSharp.Compiler.Service checks.
module SharpLsp.Sidecar.FSharp.FSharpWorkspaceRuntime

open System
open System.Collections.Concurrent
open System.IO
open System.Reflection
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Text
open SharpLsp.Sidecar.Common

let overlayComparer: StringComparer =
    if OperatingSystem.IsWindows() then
        StringComparer.OrdinalIgnoreCase
    else
        StringComparer.Ordinal

let overlayKey (filePath: string) : string = NativePaths.NormalizeFullPath filePath

let tryReadSource (overlays: ConcurrentDictionary<string, string>) (filePath: string) : string option =
    let normalizedPath = overlayKey filePath

    match overlays.TryGetValue normalizedPath with
    | true, text -> Some text
    | _ when File.Exists normalizedPath -> Some(File.ReadAllText normalizedPath)
    | _ -> None

let tryProjectSourcePath (options: FSharpProjectOptions) (filePath: string) : string option =
    let normalizedPath = overlayKey filePath

    options.SourceFiles
    |> Array.tryFind (fun sourceFile -> NativePaths.AreEqual(sourceFile, normalizedPath))

let projectSourcePath (options: FSharpProjectOptions) (filePath: string) : string =
    tryProjectSourcePath options filePath
    |> Option.defaultValue (overlayKey filePath)

let private requiredFcs (message: string) (value: 'T | null) : 'T =
    match value with
    | null -> invalidOp message
    | value -> value

let private publicStatic = BindingFlags.Public ||| BindingFlags.Static

let private documentSourceType () =
    typeof<FSharpChecker>.Assembly.GetType("FSharp.Compiler.CodeAnalysis.DocumentSource", true)
    |> requiredFcs "FCS DocumentSource type was not found."

let private isCustomFactory
    (sourceType: Type)
    (readDocument: string -> Async<ISourceText option>)
    (methodInfo: MethodInfo)
    =
    let parameters = methodInfo.GetParameters()

    methodInfo.Name = "NewCustom"
    && methodInfo.ReturnType = sourceType
    && parameters.Length = 1
    && parameters[0].ParameterType.IsAssignableFrom(readDocument.GetType())

let private customFactory (sourceType: Type) (readDocument: string -> Async<ISourceText option>) =
    sourceType.GetMethods(publicStatic)
    |> Array.tryFind (isCustomFactory sourceType readDocument)
    |> Option.defaultWith (fun () -> invalidOp "FCS DocumentSource.Custom factory was not found.")

let private createDocumentSource sourceType (readDocument: string -> Async<ISourceText option>) =
    customFactory sourceType readDocument
    |> fun factory -> factory.Invoke(null, [| box readDocument |])
    |> requiredFcs "FCS DocumentSource.Custom returned null."

let private isSomeFactory (sourceType: Type) (optionType: Type) (methodInfo: MethodInfo) =
    let parameters = methodInfo.GetParameters()

    methodInfo.Name = "Some"
    && methodInfo.ReturnType = optionType
    && parameters.Length = 1
    && parameters[0].ParameterType = sourceType

let private wrapDocumentSource (sourceType: Type) (documentSource: obj) =
    let optionType = typedefof<option<_>>.MakeGenericType sourceType

    let factory =
        optionType.GetMethods(publicStatic)
        |> Array.tryFind (isSomeFactory sourceType optionType)
        |> Option.defaultWith (fun () -> invalidOp "FCS DocumentSource option factory was not found.")

    let value =
        factory.Invoke(null, [| documentSource |])
        |> requiredFcs "FCS DocumentSource option factory returned null."

    optionType, value

let private hasNamedParameter name parameterType (parameters: ParameterInfo array) =
    parameters
    |> Array.exists (fun parameter -> parameter.Name = name && parameter.ParameterType = parameterType)

let private isCheckerFactory (documentSourceOptionType: Type) (methodInfo: MethodInfo) =
    let parameters = methodInfo.GetParameters()

    methodInfo.Name = "Create"
    && methodInfo.ReturnType = typeof<FSharpChecker>
    && parameters.Length = 14
    && hasNamedParameter "keepAssemblyContents" typeof<bool option> parameters
    && hasNamedParameter "documentSource" documentSourceOptionType parameters

let private checkerFactory (documentSourceOptionType: Type) =
    typeof<FSharpChecker>.GetMethods(publicStatic)
    |> Array.tryFind (isCheckerFactory documentSourceOptionType)
    |> Option.defaultWith (fun () -> invalidOp "Overlay-aware FSharpChecker.Create overload was not found.")

let private setArgument (parameters: ParameterInfo array) (arguments: objnull array) name value =
    let index =
        parameters
        |> Array.tryFindIndex (fun parameter -> parameter.Name = name)
        |> Option.defaultWith (fun () -> invalidOp $"FSharpChecker.Create parameter '{name}' was not found.")

    arguments[index] <- value

let private checkerArguments (factory: MethodInfo) (documentSourceOption: obj) =
    let parameters = factory.GetParameters()
    let arguments = Array.zeroCreate<objnull> parameters.Length
    setArgument parameters arguments "keepAssemblyContents" (box (Some true))
    setArgument parameters arguments "documentSource" documentSourceOption
    arguments

/// Create a checker whose project-wide reads honor in-memory editor overlays.
let createOverlayAwareChecker (readDocument: string -> Async<ISourceText option>) : FSharpChecker =
    let sourceType = documentSourceType ()
    let documentSource = createDocumentSource sourceType readDocument
    let optionType, documentSourceOption = wrapDocumentSource sourceType documentSource
    let factory = checkerFactory optionType

    factory.Invoke(null, checkerArguments factory documentSourceOption)
    |> requiredFcs "FSharpChecker.Create returned null."
    :?> FSharpChecker

let private isNotifyMethod (methodInfo: MethodInfo) =
    let parameters = methodInfo.GetParameters()

    methodInfo.Name = "NotifyFileChanged"
    && methodInfo.ReturnType = typeof<Async<unit>>
    && parameters.Length = 3
    && parameters[0].ParameterType = typeof<string>
    && parameters[1].ParameterType = typeof<FSharpProjectOptions>
    && parameters[2].ParameterType = typeof<string option>

let private notifyMethod () =
    typeof<FSharpChecker>.GetMethods(BindingFlags.Public ||| BindingFlags.Instance)
    |> Array.tryFind isNotifyMethod
    |> Option.defaultWith (fun () -> invalidOp "FSharpChecker.NotifyFileChanged was not found.")

/// Notify a custom-document-source checker without exposing experimental APIs.
let notifyFileChanged (checker: FSharpChecker) (filePath: string) (options: FSharpProjectOptions) =
    let arguments: objnull array = [| box filePath; box options; null |]

    (notifyMethod ()).Invoke(checker, arguments)
    |> requiredFcs "FSharpChecker.NotifyFileChanged returned null."
    :?> Async<unit>
    |> Async.RunSynchronously
