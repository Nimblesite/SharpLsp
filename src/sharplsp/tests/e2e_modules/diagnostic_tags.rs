//! Full-stack diagnostic tags against the real `tests/fixtures/diagnostic-tags`
//! solution: unused and unreachable findings carry `DiagnosticTag.Unnecessary`
//! so the editor greys them out, and uses of an obsolete symbol carry
//! `DiagnosticTag.Deprecated` so it strikes them through, in C# and F# alike.
//! Every other finding carries no tag. Implements [DIAG-CATEGORIES-TAGS].

use super::workspace_diagnostic_support::completed_pull_before;
use super::*;

/// LSP `DiagnosticTag.Unnecessary`.
const UNNECESSARY: u64 = 1;
/// LSP `DiagnosticTag.Deprecated`.
const DEPRECATED: u64 = 2;

/// The tags each finding of the fixture must carry, by code; any other code carries none:
/// the compiler's own unused-using `CS8019` among them, whose descriptor does not call it
/// unnecessary (`IDE0005` greys the same using out).
const TAGGED: [(&str, u64); 9] = [
    ("IDE0005", UNNECESSARY),
    ("IDE0051", UNNECESSARY),
    ("SLSPC0101", UNNECESSARY),
    ("CS0618", DEPRECATED),
    ("SLSPF0101", UNNECESSARY),
    ("SLSPF0102", UNNECESSARY),
    ("SLSPF0103", UNNECESSARY),
    ("FS0026", UNNECESSARY),
    ("FS0044", DEPRECATED),
];

/// How long a cold solution may take to report its first findings.
const LOAD: Duration = Duration::from_mins(3);

/// The tags `code` must carry.
fn expected_tags(code: &str) -> Vec<u64> {
    TAGGED
        .iter()
        .filter(|(tagged, _)| *tagged == code)
        .map(|(_, tag)| *tag)
        .collect()
}

/// `(code, tags)` of every finding of one pull report.
fn findings(report: &Value) -> Vec<(String, Vec<u64>)> {
    let items = report["result"]["items"].as_array().expect("a full report");
    let tags = |item: &Value| -> Vec<u64> {
        item["tags"]
            .as_array()
            .map_or_default(|tags| tags.iter().filter_map(Value::as_u64).collect())
    };
    items
        .iter()
        .map(|item| {
            (
                item["code"].as_str().unwrap_or_default().to_owned(),
                tags(item),
            )
        })
        .collect()
}

/// Pull `uri` until every code of `required` is reported, returning the findings.
fn pull_until(client: &mut LspClient, uri: &str, required: &[&str]) -> Vec<(String, Vec<u64>)> {
    let deadline = std::time::Instant::now() + LOAD;
    let mut traffic = Vec::new();
    loop {
        let params = json!({ "textDocument": { "uri": uri } });
        let report = completed_pull_before(
            client,
            "textDocument/diagnostic",
            params,
            &mut traffic,
            deadline,
        );
        let found = findings(&report);
        let reported = |code: &&str| found.iter().any(|(each, _)| each == code);
        if required.iter().all(reported) {
            return found;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "{required:?} never all reported: {found:?}"
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Every finding carries exactly the tags its code calls for.
fn assert_tagged(found: &[(String, Vec<u64>)], file: &str) {
    for (code, tags) in found {
        assert_eq!(
            tags,
            &expected_tags(code),
            "{file}: tags of {code}: {found:?}"
        );
    }
}

#[test]
fn unused_code_is_unnecessary_and_obsolete_uses_are_deprecated_in_csharp_and_fsharp() {
    require_dotnet();
    let ws = copied_fixture("diagnostic-tags", true);
    let root = std::fs::canonicalize(ws.path()).expect("canonical fixture root");
    let mut client = LspClient::start_verbose();
    let pulls = json!({
        "textDocument": { "diagnostic": { "dynamicRegistration": false } },
        "workspace": { "diagnostics": { "refreshSupport": true } }
    });
    let _ = client.initialize_with_capabilities(json!(path_to_file_uri(&root)), pulls);
    let fsharp = open_fixture_file(&mut client, &root, "FsTags/Tagged.fs");
    let csharp = open_fixture_file(&mut client, &root, "CsTags/Tagged.cs");
    let fs_found = pull_until(&mut client, &fsharp, &["FS0044", "FS0026", "SLSPF0102"]);
    assert_tagged(&fs_found, "Tagged.fs");
    let cs_found = pull_until(&mut client, &csharp, &["CS0618", "IDE0051", "IDE0005"]);
    assert_tagged(&cs_found, "Tagged.cs");
    client.shutdown_and_exit();
    client.wait_with_timeout();
}
