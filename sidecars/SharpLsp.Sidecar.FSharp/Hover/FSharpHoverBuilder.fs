/// Builds rich Markdown hover content for F# symbols using FSharp.Compiler.Service.
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

        // XML documentation.
        // FCS returns raw XML (e.g. <summary>...</summary>) without a wrapper element,
        // unlike Roslyn which wraps in <member>. Wrap in <doc> so the shared renderer
        // can find child elements like <summary> consistently.
        match item.XmlDoc with
        | FSharpXmlDoc.FromXmlText xmlDoc ->
            let xmlText = $"<doc>{xmlDoc.GetXmlText()}</doc>"
            let rendered = XmlDocRenderer.Render(xmlText)
            if rendered.Length > 0 then
                sb.AppendLine() |> ignore
                sb.Append(rendered) |> ignore
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
