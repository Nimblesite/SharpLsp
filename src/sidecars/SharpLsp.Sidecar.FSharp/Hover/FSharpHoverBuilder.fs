/// Builds rich Markdown hover content for F# symbols using FSharp.Compiler.Service. [HOVER-FSHARP-RENDERING]
module SharpLsp.Sidecar.FSharp.Hover.FSharpHoverBuilder

open System.Text
open FSharp.Compiler.EditorServices
open FSharp.Compiler.Symbols
open FSharp.Compiler.Text
open SharpLsp.Sidecar.Common.Hover

/// Convert a TaggedText layout to a plain string.
let private layoutToString (layout: TaggedText seq) : string =
    layout
    |> Seq.map (fun t -> t.Text)
    |> String.concat ""

/// A symbol's XML documentation, rooted for the shared renderer. FCS hands a source
/// symbol's `///` text without a wrapper element, so it is wrapped in `<doc>`; a .NET
/// symbol's comes from its assembly's documentation file as a `<member>` element.
let private documentation (xmlDoc: FSharpXmlDoc) : string option =
    match xmlDoc with
    | FSharpXmlDoc.FromXmlText text -> Some $"<doc>{text.GetXmlText()}</doc>"
    | FSharpXmlDoc.FromXmlFile(assembly, memberId) -> FSharpXmlDocFiles.tryMember assembly memberId
    | FSharpXmlDoc.None -> None

/// Render a single ToolTipElementData item to Markdown.
let private renderGroupItem (item: ToolTipElementData) : string option =
    let mainText = layoutToString item.MainDescription
    if System.String.IsNullOrWhiteSpace mainText then
        None
    else
        let sb = StringBuilder()
        sb.AppendLine("```fsharp") |> ignore
        sb.AppendLine(mainText) |> ignore
        sb.AppendLine("```") |> ignore

        match documentation item.XmlDoc |> Option.map XmlDocRenderer.Render with
        | Some rendered when rendered.Length > 0 -> sb.AppendLine().Append(rendered) |> ignore
        | _ -> ()

        // Remarks (fully qualified name).
        match item.Remarks with
        | Some remarks ->
            let text = layoutToString remarks
            if not (System.String.IsNullOrWhiteSpace text) then
                sb.AppendLine() |> ignore
                sb.Append("*") |> ignore
                sb.Append(text) |> ignore
                sb.Append("*") |> ignore
        | None -> ()

        Some(sb.ToString().TrimEnd())

/// Render a single ToolTipElement to Markdown.
let private renderElement (element: ToolTipElement) : string option =
    match element with
    | ToolTipElement.Group items when items.Length > 0 ->
        items
        |> List.choose renderGroupItem
        |> function
            | [] -> None
            | parts -> Some(System.String.Join("\n\n", parts))
    | ToolTipElement.CompositionError msg ->
        Some $"*Error: {msg}*"
    | _ -> None

/// Render a ToolTipText result into Markdown hover content.
let renderToolTip (tip: ToolTipText) : string option =
    match tip with
    | ToolTipText.ToolTipText elements when elements.Length > 0 ->
        elements
        |> List.choose renderElement
        |> function
            | [] -> None
            | parts -> Some(System.String.Join("\n\n---\n\n", parts))
    | _ -> None
