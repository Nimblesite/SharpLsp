//! Full-stack E2E tests for Fix All + Rule Enforcement ([FIXALL-ENFORCE],
//! [FIXALL-LSP], [PKG-VULN-TESTS]; GitHub #577, #578).

use std::process::Command;

use super::*;

/// Apply a `documentChanges` payload returned by `codeAction/resolve` to disk
/// (handling `create` and whole-file text edits) so `dotnet build` can verify it.
fn apply_document_changes_to_disk(resp: &Value) {
    let ops = resp["result"]["edit"]["documentChanges"]
        .as_array()
        .unwrap_or_else(|| panic!("expected documentChanges array: {resp}"));
    for op in ops {
        if op.get("kind").and_then(Value::as_str) == Some("create") {
            let uri = op["uri"].as_str().expect("create uri");
            let path = uri_to_local_path(uri);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create parent dir");
            }
            if !path.exists() {
                std::fs::write(&path, "").expect("create file");
            }
        } else if let Some(uri) = op["textDocument"]["uri"].as_str() {
            let path = uri_to_local_path(uri);
            let mut content = std::fs::read_to_string(&path).unwrap_or_default();
            let edits = op["edits"].as_array().expect("edits array");
            // Apply whole-file replacements (config files) or line/char edits back-to-front.
            let mut sorted: Vec<&Value> = edits.iter().collect();
            sorted.sort_by_key(|e| {
                let s = &e["range"]["start"];
                std::cmp::Reverse((
                    s["line"].as_u64().unwrap_or(0),
                    s["character"].as_u64().unwrap_or(0),
                ))
            });
            for edit in sorted {
                let start = &edit["range"]["start"];
                let end = &edit["range"]["end"];
                let new_text = edit["newText"].as_str().unwrap_or_default();
                let sl = usize::try_from(start["line"].as_u64().unwrap_or(0)).unwrap_or(0);
                let sc = usize::try_from(start["character"].as_u64().unwrap_or(0)).unwrap_or(0);
                let el = usize::try_from(end["line"].as_u64().unwrap_or(0)).unwrap_or(0);
                let ec = usize::try_from(end["character"].as_u64().unwrap_or(0)).unwrap_or(0);
                let line_count = content.lines().count();
                if sl == 0 && sc == 0 && el >= line_count {
                    content = new_text.to_string();
                } else {
                    content = apply_lsp_text_edit(&content, sl, sc, el, ec, new_text);
                }
            }
            std::fs::write(&path, content).expect("write edited file");
        }
    }
}

fn uri_to_local_path(uri: &str) -> std::path::PathBuf {
    let url = url::Url::parse(uri).expect("valid file URI");
    url.to_file_path().expect("file URI to path")
}

fn apply_lsp_text_edit(
    text: &str,
    sl: usize,
    sc: usize,
    el: usize,
    ec: usize,
    replacement: &str,
) -> String {
    let mut line_starts = vec![0usize];
    for (idx, ch) in text.char_indices() {
        if ch == '\n' {
            line_starts.push(idx + 1);
        }
    }
    let byte_of = |line: usize, col: usize| -> usize {
        let start = *line_starts.get(line).unwrap_or(&text.len());
        text.get(start..)
            .and_then(|s| s.char_indices().nth(col).map(|(off, _)| start + off))
            .unwrap_or(text.len())
    };
    let a = byte_of(sl, sc);
    let b = byte_of(el, ec);
    let prefix = text.get(..a).unwrap_or_default();
    let suffix = text.get(b..).unwrap_or_default();
    format!("{prefix}{replacement}{suffix}")
}

/// Full-stack C# Fix All + Enforce (`IDE0007`): resolves code fixes +
/// `.editorconfig` + `Directory.Build.props` in one annotated `WorkspaceEdit`,
/// preserves existing comments, disables opposing `IDE0008`, and makes a new
/// explicit local type fail `dotnet build`. [FIXALL-ENFORCE] [FIXALL-TESTS]
#[test]
fn fix_all_and_enforce_ide0007_fails_dotnet_build_on_new_explicit_type() {
    require_dotnet();
    let ws = create_fixall_workspace();
    // Seed a comment in `.editorconfig` to prove lossless CST preservation.
    let ec_path = ws.root.join(".editorconfig");
    let seeded = format!(
        "# preserve-this-comment\n{}",
        std::fs::read_to_string(&ec_path).expect("read .editorconfig")
    );
    std::fs::write(&ec_path, seeded).expect("seed .editorconfig");

    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(ws.root_uri()));
    let inventory_uri = path_to_file_uri(&ws.inventory_path());
    client.open_document(&inventory_uri, FIXALL_INVENTORY_CS);
    let _ready =
        poll_hover_until_ready(&mut client, &inventory_uri, 2, 20, Duration::from_secs(150));

    let (line, start, end) = inventory_pos::FIRST_EXPLICIT_TYPE;
    let actions = poll_fix_all_actions(&mut client, &inventory_uri, (line, start, end));
    let base = actions
        .iter()
        .find(|a| title_of(a).contains("var' instead of explicit type"))
        .expect("UseImplicitType action");
    let base_title = title_of(base).to_string();
    let mut solution_action = fix_all_for(&actions, "solution", &base_title).clone();
    solution_action["data"]["fixAll"]["enforce"] = json!(true);

    let resp = client.request("codeAction/resolve", solution_action);
    assert!(
        resp.get("error").is_none(),
        "enforce resolve must succeed: {resp}"
    );
    let annotations = &resp["result"]["edit"]["changeAnnotations"];
    assert_eq!(
        annotations["sharplsp.enforce"]["needsConfirmation"],
        json!(true),
        "enforcement annotation requires confirmation: {resp}"
    );
    assert_eq!(
        annotations["sharplsp.fixAll.scope"]["needsConfirmation"],
        json!(true),
        "solution-scope code edits require confirmation: {resp}"
    );

    apply_document_changes_to_disk(&resp);
    let ec_after = std::fs::read_to_string(&ec_path).expect("read updated .editorconfig");
    assert!(
        ec_after.contains("# preserve-this-comment"),
        "existing comment survived: {ec_after}"
    );
    assert!(
        ec_after.contains("dotnet_diagnostic.IDE0007.severity = error"),
        "IDE0007 enforced as error: {ec_after}"
    );
    assert!(
        ec_after.contains("dotnet_diagnostic.IDE0008.severity = none"),
        "opposing IDE0008 disabled: {ec_after}"
    );
    let props_after =
        std::fs::read_to_string(ws.root.join("Directory.Build.props")).expect("read props");
    assert!(
        props_after.contains("<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>"),
        "EnforceCodeStyleInBuild written to solution Directory.Build.props: {props_after}"
    );

    // Add a new explicit local type and verify `dotnet build` fails with IDE0007!
    let violation = "namespace FixAll.Core;\npublic static class NewViolation { public static int Run() { int x = 42; return x; } }\n";
    std::fs::write(ws.root.join("Core").join("NewViolation.cs"), violation)
        .expect("write violation");
    let build = Command::new("dotnet")
        .args(["build", "Core/Core.csproj", "--nologo"])
        .current_dir(&ws.root)
        .output()
        .expect("run dotnet build");
    let stdout = String::from_utf8_lossy(&build.stdout);
    let stderr = String::from_utf8_lossy(&build.stderr);
    assert!(
        !build.status.success(),
        "dotnet build must fail on new explicit type after enforcing IDE0007:\n{stdout}\n{stderr}"
    );
    assert!(
        stdout.contains("IDE0007") || stderr.contains("IDE0007"),
        "build failure must cite IDE0007:\n{stdout}\n{stderr}"
    );

    // Also verify `source.fixAll.sharplsp` on-save request returns document scope without enforce.
    let on_save = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": inventory_uri },
            "range": {
                "start": { "line": line, "character": start },
                "end": { "line": line, "character": end }
            },
            "context": { "diagnostics": [], "only": ["source.fixAll.sharplsp"] }
        }),
    );
    let on_save_actions = on_save["result"].as_array().expect("on-save actions");
    assert!(
        on_save_actions.iter().any(|a| {
            a["kind"] == "source.fixAll.sharplsp"
                && a["data"]["fixAll"]["scope"] == "document"
                && a["data"]["fixAll"]["enforce"] == false
        }),
        "source.fixAll.sharplsp must offer document-scope non-enforcing fix: {on_save}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
