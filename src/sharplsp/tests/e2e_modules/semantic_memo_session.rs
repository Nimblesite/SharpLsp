//! One editing session over the semantic memo and its request lifetimes:
//! repeats are answered from the memo, an edit never leaves a stale answer,
//! an edit supersedes the requests asked before it, and `$/cancelRequest`
//! ends one. [DEFINITION-CACHE] [REFERENCES-SALSA] [HOVER-CACHING]
//! [SHARPLSP-ARCHITECTURE-ROUTING]

use super::*;

/// LSP `ContentModified`.
const CONTENT_MODIFIED: i64 = -32801;
/// LSP `RequestCancelled`.
const REQUEST_CANCELLED: i64 = -32800;

/// Send `method` at a position under the caller's own request id.
fn ask(client: &mut LspClient, id: i64, method: &str, uri: &str, at: (u32, u32)) {
    let mut params = hover_params(uri, at.0, at.1);
    if method == "textDocument/references" {
        params["context"] = json!({ "includeDeclaration": true });
    }
    client.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
}

/// The responses to `ids`, in whatever order the server sends them.
fn answers(client: &mut LspClient, ids: &[i64]) -> Vec<Value> {
    let mut found: Vec<Option<Value>> = vec![None; ids.len()];
    while found.iter().any(Option::is_none) {
        let message = client.recv();
        let slot = message["id"]
            .as_i64()
            .and_then(|id| ids.iter().position(|each| *each == id));
        if let Some(slot) = slot.filter(|_| message.get("method").is_none()) {
            found[slot] = Some(message);
        }
    }
    found.into_iter().flatten().collect()
}

/// The line a definition answer points at.
fn target_line(response: &Value) -> u64 {
    assert_nav_ok(response);
    first_location(&response["result"])["range"]["start"]["line"]
        .as_u64()
        .expect("definition answers a location")
}

/// The median of `count` round trips of the same definition request, each
/// asserted to answer `expected`.
fn median_repeat(client: &mut LspClient, uri: &str, expected: &Value, count: usize) -> Duration {
    let mut times: Vec<Duration> = (0..count)
        .map(|_| {
            let started = Instant::now();
            let response = definition(client, uri, 14, 23);
            let elapsed = started.elapsed();
            assert_nav_ok(&response);
            assert_eq!(&first_location(&response["result"]), expected);
            elapsed
        })
        .collect();
    times.sort();
    times[count.midpoint(0)]
}

#[test]
fn semantic_memo_repeats_answers_and_edits_end_the_requests_before_them() {
    require_dotnet();
    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // 1. A repeat is the memo's answer: identical, and far inside the
    //    compiler's latency budget. `AnimalBase` in `class Dog : AnimalBase`.
    let first =
        poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));
    assert_location_shape(&first);
    assert_eq!(
        first["range"]["start"]["line"], 8,
        "AnimalBase is declared on line 8"
    );
    let median = median_repeat(&mut client, &file_uri, &first, 21);
    assert!(
        median < Duration::from_millis(50),
        "a memoized definition answers at once, took {median:?}"
    );
    let hovered = hover(&mut client, &file_uri, 14, 23);
    assert_hover_ok(&hovered);
    assert!(hovered["result"]["contents"]["value"]
        .as_str()
        .is_some_and(|text| text.contains("AnimalBase")));
    assert_eq!(
        hover(&mut client, &file_uri, 14, 23)["result"],
        hovered["result"]
    );
    let with_declaration = references(&mut client, &file_uri, 14, 23, true);
    let without = references(&mut client, &file_uri, 14, 23, false);
    let count = |response: &Value| response["result"].as_array().map_or(0, Vec::len);
    assert_eq!(
        count(&with_declaration),
        count(&without) + 1,
        "separate questions"
    );
    assert_eq!(
        references(&mut client, &file_uri, 14, 23, true)["result"],
        with_declaration["result"]
    );

    // 2. An edit never leaves a stale answer: every line moves down one.
    let moved = format!("// moved\n{source}");
    client.change_document(&file_uri, 2, &moved);
    assert_eq!(target_line(&definition(&mut client, &file_uri, 15, 23)), 9);
    // The position asked before the edit now sits on a blank line, which the
    // compiler reads on into the line below: the answer is today's, never the
    // one memoized for this position before the edit.
    let old_position = definition(&mut client, &file_uri, 14, 23);
    assert_ne!(
        target_line(&old_position),
        8,
        "not the answer from before the edit"
    );
    assert_eq!(target_line(&old_position), 9);
    assert_eq!(target_line(&definition(&mut client, &file_uri, 15, 23)), 9);

    // 3. An edit supersedes the requests asked before it. The first edit
    //    opens the debounce window they wait in; the second ends them.
    client.change_document(&file_uri, 3, &moved);
    ask(
        &mut client,
        990_001,
        "textDocument/definition",
        &file_uri,
        (15, 23),
    );
    ask(
        &mut client,
        990_002,
        "textDocument/hover",
        &file_uri,
        (15, 23),
    );
    ask(
        &mut client,
        990_003,
        "textDocument/references",
        &file_uri,
        (15, 23),
    );
    client.change_document(&file_uri, 4, &moved);
    for response in answers(&mut client, &[990_001, 990_002, 990_003]) {
        assert_eq!(response["error"]["code"], CONTENT_MODIFIED, "{response}");
        assert!(
            response.get("result").is_none(),
            "no answer for old content"
        );
    }
    assert_eq!(target_line(&definition(&mut client, &file_uri, 15, 23)), 9);

    // 4. `$/cancelRequest` ends a request, and only that one.
    client.change_document(&file_uri, 5, &moved);
    ask(
        &mut client,
        990_004,
        "textDocument/references",
        &file_uri,
        (15, 23),
    );
    ask(
        &mut client,
        990_005,
        "textDocument/definition",
        &file_uri,
        (15, 23),
    );
    client.notify("$/cancelRequest", json!({ "id": 990_004 }));
    let ended = answers(&mut client, &[990_004, 990_005]);
    assert_eq!(ended[0]["error"]["code"], REQUEST_CANCELLED, "{}", ended[0]);
    assert_eq!(target_line(&ended[1]), 9, "the other request is answered");
    let after = references(&mut client, &file_uri, 15, 23, true);
    assert_eq!(
        count(&after),
        count(&with_declaration),
        "and it can be asked again"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// The definition workspace's source with `calls` more calls of `Dog.Speak`.
fn with_many_calls(source: &str, calls: usize) -> String {
    let lines = "        dog.Speak(),\n".repeat(calls);
    format!(
        "{source}\n\npublic static class Many\n{{\n    public static string[] All(Dog dog) => new[]\n    {{\n{lines}    }};\n}}\n"
    )
}

/// A `textDocument/references` answer asked under `token`: the partial
/// results sent for it, then its response.
fn references_under_token(
    client: &mut LspClient,
    id: i64,
    uri: &str,
    at: (u32, u32),
    token: &str,
) -> (Vec<Value>, Value) {
    let mut params = hover_params(uri, at.0, at.1);
    params["context"] = json!({ "includeDeclaration": true });
    params["partialResultToken"] = json!(token);
    client.send(&json!({
        "jsonrpc": "2.0", "id": id, "method": "textDocument/references", "params": params
    }));
    let mut partials = Vec::new();
    loop {
        let message = client.recv();
        if message["method"] == "$/progress" && message["params"]["token"] == token {
            partials.push(message["params"]["value"].clone());
        } else if message["id"].as_i64() == Some(id) && message.get("method").is_none() {
            return (partials, message);
        }
    }
}

#[test]
fn a_large_references_answer_streams_as_partial_results() {
    require_dotnet();
    let (_tmp, root_uri, file_uri, source) = create_definition_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);
    let _ = poll_definition_until_ready(&mut client, &file_uri, 14, 23, Duration::from_secs(90));
    client.change_document(&file_uri, 2, &with_many_calls(&source, 450));

    // 1. `Dog.Speak` (line 17) has 450 calls: they arrive in chunks, and the
    //    response itself is empty. [REFERENCES-PERFORMANCE]
    let (partials, response) =
        references_under_token(&mut client, 991_001, &file_uri, (17, 27), "refs");
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(
        response["result"],
        json!([]),
        "everything went out as partials"
    );
    let sizes: Vec<usize> = partials
        .iter()
        .map(|chunk| chunk.as_array().map_or(0, Vec::len))
        .collect();
    let total: usize = sizes.iter().sum();
    assert!(total >= 451, "the declaration and 450 calls, found {total}");
    assert_eq!(
        sizes.len(),
        total.div_ceil(200),
        "chunks of at most 200: {sizes:?}"
    );
    assert!(
        sizes.iter().rev().skip(1).all(|size| *size == 200),
        "{sizes:?}"
    );
    let streamed: Vec<Value> = partials
        .iter()
        .flat_map(|chunk| chunk.as_array().cloned().unwrap_or_default())
        .collect();
    streamed.iter().for_each(assert_location_shape);

    // 2. Without a token the same answer is the response, in the same order.
    let whole = references(&mut client, &file_uri, 17, 27, true);
    assert_nav_ok(&whole);
    assert_eq!(
        whole["result"],
        Value::Array(streamed),
        "partials lose nothing"
    );

    // 3. A small answer under a token is not streamed. `Cat` (line 20).
    let (none, small) = references_under_token(&mut client, 991_002, &file_uri, (20, 13), "few");
    assert!(none.is_empty(), "a small answer needs no partial results");
    let few = small["result"].as_array().map_or(0, Vec::len);
    assert!(
        (1..=200).contains(&few),
        "Cat's own references, found {few}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
