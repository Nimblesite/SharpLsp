//! End-to-end tests for `sharplsp/project/addCompileItem` (GitHub #493,
//! [SE-ADD-FILE-REQUEST]). The request routes to the C# sidecar, which inserts
//! the `<Compile>` item through the `MSBuild` `ProjectRootElement` API: a real
//! `sharplsp` binary, a real sidecar spawn, and a real `.fsproj` on disk.
//!
//! Asserts the exact resulting file text (formatting preservation) and the
//! compile order semantics pinned by the spec: default = before the LAST
//! Compile item so an F# entry point stays last ([SE-ADD-FILE-ORDER]).

#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
#![expect(
    clippy::indexing_slicing,
    reason = "test code — JSON indexing panics are acceptable test failures"
)]
#![expect(
    clippy::panic,
    reason = "test code — panics are the correct failure mode"
)]
#![expect(
    unused_results,
    reason = "test code — initialize() return values are intentionally discarded"
)]

use serde_json::{json, Value};
use tempfile::TempDir;

#[path = "support/lsp_client.rs"]
mod lsp_client;

use lsp_client::{require_dotnet, LspClient};

/// A realistic F# project: explicit compile order, entry point last, CRLF and
/// a comment that must survive the edit byte-for-byte.
const ORDERED_FSPROJ: &str = "<Project Sdk=\"Microsoft.NET.Sdk\">\r\n  <!-- order matters -->\r\n  <ItemGroup>\r\n    <Compile Include=\"Domain.fs\" />\r\n    <Compile Include=\"Library.fs\" />\r\n    <Compile Include=\"Program.fs\" />\r\n  </ItemGroup>\r\n</Project>\r\n";

/// Write an isolated copy of the F# fixture and return its fsproj path.
fn isolated_fsproj(tmp: &TempDir) -> String {
    let path = tmp.path().join("Order.fsproj");
    std::fs::write(&path, ORDERED_FSPROJ).unwrap();
    path.to_string_lossy().into_owned()
}

/// Send `sharplsp/project/addCompileItem` and return the response value.
fn add_compile_item(client: &mut LspClient, fsproj: &str, include: &str) -> Value {
    client.request(
        "sharplsp/project/addCompileItem",
        json!({ "projectPath": fsproj, "include": include }),
    )
}

/// Send the request with an explicit anchor + position.
fn add_compile_item_anchored(
    client: &mut LspClient,
    fsproj: &str,
    include: &str,
    anchor: &str,
    position: &str,
) -> Value {
    client.request(
        "sharplsp/project/addCompileItem",
        json!({
            "projectPath": fsproj,
            "include": include,
            "anchorInclude": anchor,
            "position": position,
        }),
    )
}

#[test]
fn add_compile_item_default_inserts_before_the_last_item() {
    if !require_dotnet() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let fsproj = isolated_fsproj(&tmp);

    let mut client = LspClient::start();
    client.initialize_with_root(tmp.path());

    let resp = add_compile_item(&mut client, fsproj.as_str(), "NewModule.fs");
    assert!(resp.get("error").is_none(), "request failed: {resp}");
    assert_eq!(
        resp["result"]["success"].as_bool(),
        Some(true),
        "insert should succeed: {resp}"
    );
    assert_eq!(
        resp["result"]["modified"].as_bool(),
        Some(true),
        "the fsproj should be modified: {resp}"
    );
    assert!(
        resp["result"]["message"].as_str().is_some(),
        "a message must be present: {resp}"
    );

    // [SE-ADD-FILE-ORDER]: default position keeps the entry point last, with
    // formatting (comment, CRLF, indentation) preserved exactly.
    let after = std::fs::read_to_string(&fsproj).unwrap();
    let expected = ORDERED_FSPROJ.replace(
        "    <Compile Include=\"Program.fs\" />\r\n",
        "    <Compile Include=\"NewModule.fs\" />\r\n    <Compile Include=\"Program.fs\" />\r\n",
    );
    assert_eq!(after, expected, "compile order + formatting must match");

    client.shutdown_and_exit();
}

#[test]
fn add_compile_item_before_and_after_anchor() {
    if !require_dotnet() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let fsproj = isolated_fsproj(&tmp);

    let mut client = LspClient::start();
    client.initialize_with_root(tmp.path());

    let before = add_compile_item_anchored(
        &mut client,
        fsproj.as_str(),
        "NearBefore.fs",
        "Library.fs",
        "before",
    );
    assert_eq!(
        before["result"]["success"].as_bool(),
        Some(true),
        "{before}"
    );

    let after = add_compile_item_anchored(
        &mut client,
        fsproj.as_str(),
        "NearAfter.fs",
        "Domain.fs",
        "after",
    );
    assert_eq!(after["result"]["success"].as_bool(), Some(true), "{after}");

    let text = std::fs::read_to_string(&fsproj).unwrap();
    let positions = ["NearBefore.fs", "Library.fs", "NearAfter.fs"]
        .iter()
        .map(|needle| {
            text.find(&format!("Include=\"{needle}\""))
                .unwrap_or_else(|| panic!("{needle} missing from {text}"))
        })
        .collect::<Vec<_>>();
    assert!(
        positions[0] < positions[1],
        "NearBefore must precede Library: {text}"
    );
    // Domain.fs hosts the 'after' insert: NearAfter sits right after Domain.
    let domain = text.find("Include=\"Domain.fs\"").unwrap();
    assert!(
        domain < positions[2],
        "NearAfter must follow Domain: {text}"
    );

    client.shutdown_and_exit();
}

#[test]
fn add_compile_item_existing_include_is_reported_unmodified() {
    if !require_dotnet() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let fsproj = isolated_fsproj(&tmp);

    let mut client = LspClient::start();
    client.initialize_with_root(tmp.path());

    let resp = add_compile_item(&mut client, fsproj.as_str(), "Library.fs");
    assert!(resp.get("error").is_none(), "request failed: {resp}");
    assert_eq!(resp["result"]["success"].as_bool(), Some(true), "{resp}");
    assert_eq!(
        resp["result"]["modified"].as_bool(),
        Some(false),
        "an existing include must be a no-op: {resp}"
    );
    assert_eq!(
        std::fs::read_to_string(&fsproj).unwrap(),
        ORDERED_FSPROJ,
        "a no-op must not touch the file"
    );

    client.shutdown_and_exit();
}

#[test]
fn add_compile_item_missing_anchor_fails_with_a_message() {
    if !require_dotnet() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let fsproj = isolated_fsproj(&tmp);

    let mut client = LspClient::start();
    client.initialize_with_root(tmp.path());

    let resp = add_compile_item_anchored(
        &mut client,
        fsproj.as_str(),
        "NewModule.fs",
        "Nope.fs",
        "before",
    );
    assert!(
        resp.get("error").is_none(),
        "a missing anchor is a domain failure, not a protocol error: {resp}"
    );
    assert_eq!(
        resp["result"]["success"].as_bool(),
        Some(false),
        "missing anchor must fail: {resp}"
    );
    assert!(
        resp["result"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("Nope.fs")),
        "the failure must name the anchor: {resp}"
    );
    assert_eq!(
        std::fs::read_to_string(&fsproj).unwrap(),
        ORDERED_FSPROJ,
        "a failed insert must not touch the file"
    );

    client.shutdown_and_exit();
}

#[test]
fn add_compile_item_without_a_sidecar_reports_it() {
    let tmp = TempDir::new().unwrap();
    let fsproj = isolated_fsproj(&tmp);
    // "Nothing loaded" must mean no sidecar: since [SCRIPT-ROUTE-LAZY] merely
    // omitting the workspace root no longer achieves that, the precondition
    // comes from config (the same trick as the nuget suite).
    std::fs::write(
        tmp.path().join("sharplsp.toml"),
        "[csharp]\nenabled = false\n\n[fsharp]\nenabled = false\n",
    )
    .unwrap();

    let mut client = LspClient::start_in(Some(tmp.path()));
    client.initialize();

    let resp = add_compile_item(&mut client, fsproj.as_str(), "NewModule.fs");
    assert!(resp.get("error").is_none(), "request failed: {resp}");
    assert_eq!(
        resp["result"]["success"].as_bool(),
        Some(false),
        "no sidecar → unsuccessful response: {resp}"
    );
    assert!(
        resp["result"]["message"]
            .as_str()
            .is_some_and(|m| m.to_lowercase().contains("sidecar")),
        "the message must point at the missing sidecar: {resp}"
    );
    assert_eq!(
        std::fs::read_to_string(&fsproj).unwrap(),
        ORDERED_FSPROJ,
        "nothing may be written without a sidecar"
    );

    client.shutdown_and_exit();
}
