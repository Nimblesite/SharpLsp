/// Minimal structured JSON output. The single JSON object printed to stdout is
/// the tool's result protocol, not a log. Source file contents are never
/// emitted.
module LintSourceBuild.Json

open System.IO
open System.Text
open System.Text.Json

let private encode (w: Utf8JsonWriter) (key: string) (value: obj) : unit =
    match value with
    | :? int as i -> w.WriteNumber(key, i)
    | v -> w.WriteString(key, string v)

/// Render a flat object of primitive values; escapes all strings.
let writeObject (pairs: (string * obj) array) : string =
    use stream = new MemoryStream()
    use writer = new Utf8JsonWriter(stream)
    writer.WriteStartObject()
    for key, value in pairs do encode writer key value
    writer.WriteEndObject()
    writer.Flush()
    Encoding.UTF8.GetString(stream.ToArray())
