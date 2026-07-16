//! Session request/assert helpers shared by the F# feature tests and the
//! user-session tests. Promoted out of fsharp.rs so no module grows a private
//! copy.

use super::*;

/// Send `method` with position params built from a real `uri`.
pub fn position_request(client: &mut LspClient, method: &str, uri: &str, pos: (u32, u32)) -> Value {
    client.request(
        method,
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": pos.0, "character": pos.1 }
        }),
    )
}

/// Send a `{ textDocument: { uri } }`-only request (documentSymbol, codeLens, …).
pub fn document_request(client: &mut LspClient, method: &str, uri: &str) -> Value {
    client.request(method, json!({ "textDocument": { "uri": uri } }))
}

/// Assert a response is well-formed JSON-RPC 2.0 with an id and no error.
pub fn assert_rpc_ok(resp: &Value, label: &str) {
    assert_eq!(resp["jsonrpc"], "2.0", "{label}: must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "{label}: must have request id");
    assert!(
        resp.get("error").is_none(),
        "{label}: must not return an error: {resp}"
    );
}

/// Send a rename request and return the response.
pub fn rename_request(
    client: &mut LspClient,
    uri: &str,
    line: u32,
    character: u32,
    new_name: &str,
) -> Value {
    client.request(
        "textDocument/rename",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
            "newName": new_name
        }),
    )
}

/// Assert `uri` is a well-formed RFC 8089 `file://` URI — the regression guard
/// for #110's unparseable `file://C:\...` shape. [GitHub #110]
pub fn assert_wellformed_file_uri(uri: &str, label: &str) {
    assert!(
        uri.starts_with("file:///"),
        "{label}: URI must start with file:///, got: {uri}"
    );
    assert!(
        !uri.contains('\\'),
        "{label}: URI must not contain backslashes, got: {uri}"
    );
    let parsed = url::Url::parse(uri)
        .unwrap_or_else(|err| panic!("{label}: URI must parse as a URL ({err}): {uri}"));
    assert_eq!(
        parsed.scheme(),
        "file",
        "{label}: scheme must be file: {uri}"
    );
}

/// Collect `(uri, start_line)` pairs from a `Location[]` result.
pub fn location_entries(result: &Value) -> Vec<(String, u64)> {
    result
        .as_array()
        .map(|locs| {
            locs.iter()
                .map(|loc| {
                    (
                        loc["uri"]
                            .as_str()
                            .expect("location must have uri")
                            .to_string(),
                        loc["range"]["start"]["line"]
                            .as_u64()
                            .expect("location must have start line"),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Assert `locations` includes at least one URI ending in `suffix`.
pub fn assert_has_location_in(locations: &[(String, u64)], suffix: &str, label: &str) {
    assert!(
        locations.iter().any(|(uri, _)| uri.ends_with(suffix)),
        "{label}: no location in a file ending with `{suffix}`: {locations:?}"
    );
}

/// Depth-first search a `DocumentSymbol[]` tree for a symbol named `name`.
pub fn find_symbol<'a>(symbols: &'a Value, name: &str) -> Option<&'a Value> {
    symbols.as_array()?.iter().find_map(|symbol| {
        if symbol["name"] == name {
            Some(symbol)
        } else {
            find_symbol(&symbol["children"], name)
        }
    })
}

/// Pull diagnostics for `uri` and return only the Error-severity items.
pub fn pull_error_diagnostics(client: &mut LspClient, uri: &str, label: &str) -> Vec<Value> {
    let resp = document_request(client, "textDocument/diagnostic", uri);
    assert_rpc_ok(&resp, label);
    let items = resp["result"]["items"]
        .as_array()
        .unwrap_or_else(|| panic!("{label}: diagnostic report must carry items: {resp}"))
        .clone();
    items.into_iter().filter(|d| d["severity"] == 1).collect()
}
