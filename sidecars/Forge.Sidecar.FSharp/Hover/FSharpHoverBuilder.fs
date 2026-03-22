/// Builds rich Markdown hover content for F# symbols using FSharp.Compiler.Service.
module Forge.Sidecar.FSharp.Hover.FSharpHoverBuilder

open FSharp.Compiler.EditorServices
open FSharp.Compiler.Symbols
open FSharp.Compiler.Text
open Forge.Sidecar.Common.Hover

/// Render a ToolTipText result into Markdown hover content.
let renderToolTip (tip: ToolTipText) : string option =
    match tip with
    | ToolTipText.ToolTipElement(elements) when elements.Length > 0 ->
        elements
        |> List.choose renderElement
        |> function
            | [] -> None
            | parts -> Some(System.String.Join("\n\n---\n\n", parts))
    | _ -> None

/// Render a single ToolTipElement to Markdown.
and private renderElement (element: ToolTipElement) : string option =
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

/// Render a single ToolTipElementData item.
and private renderGroupItem (item: ToolTipElementData) : string option =
    let sb = System.Text.StringBuilder()

    // Signature in code block.
    let mainText = layoutToString item.MainDescription
    if System.String.IsNullOrWhiteSpace mainText then
        None
    else
        sb.AppendLine("```fsharp") |> ignore
        sb.AppendLine(mainText) |> ignore
        sb.AppendLine("```") |> ignore

        // XML documentation.
        match item.XmlDoc with
        | FSharpXmlDoc.FromXmlText xmlDoc ->
            let xmlText = xmlDoc.GetXmlText()
            let rendered = XmlDocRenderer.Render(xmlText)
            if rendered.Length > 0 then
                sb.AppendLine() |> ignore
                sb.Append(rendered) |> ignore
        | _ -> ()

        // Remarks (fully qualified name).
        let remarks = layoutToString item.Remarks
        if not (System.String.IsNullOrWhiteSpace remarks) then
            sb.AppendLine() |> ignore
            sb.Append("*") |> ignore
            sb.Append(remarks) |> ignore
            sb.Append("*") |> ignore

        Some(sb.ToString().TrimEnd())

/// Convert a TaggedText layout to a plain string.
and private layoutToString (layout: TaggedText[]) : string =
    layout
    |> Array.map (fun t -> t.Text)
    |> System.String.Concat
