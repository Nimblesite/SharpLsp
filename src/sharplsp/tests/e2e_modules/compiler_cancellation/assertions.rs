//! Exact SDK truth, identity and ownership assertions. [DIAG-TRUTH-GUARANTEES]
use super::*;
use workspace_diagnostic_support::assert_error;

/// Every successful response identifies the snapshot that produced its exact findings.
pub fn report(
    report: &Value,
    expected: Option<&str>,
    previous: Option<&str>,
    source: &str,
) -> String {
    payload(&report["result"], expected, previous, source)
}

/// Document and workspace reports carry the same actual compiler payload.
pub fn payload(
    report: &Value,
    expected: Option<&str>,
    previous: Option<&str>,
    source: &str,
) -> String {
    assert_eq!(report["kind"], "full");
    let id = report["resultId"]
        .as_str()
        .expect("current result identity");
    assert!(!id.is_empty());
    if let Some(previous) = previous {
        assert_ne!(id, previous);
    }
    items(&report["items"], expected, source);
    id.to_owned()
}

/// Only the newly selected source may report errors; old owners retire explicitly.
pub fn selected_scope(response: &Value, selected: &str, previous: &[Value], code: &str) -> String {
    let reports = workspace_diagnostic_support::workspace_reports(response);
    workspace_diagnostic_protocol::selection::assert_retired(reports, previous);
    let current = workspace_diagnostic_support::report_for(reports, selected);
    let id = payload(
        current,
        Some(code),
        previous[0]["value"].as_str(),
        "sharplsp-fsharp",
    );
    assert!(
        reports.iter().all(|report| report["items"]
            .as_array()
            .expect("workspace items")
            .is_empty()
            || report["uri"] == selected),
        "only selected compiler sources may retain errors"
    );
    id
}

/// Filtering cannot hide extra errors or manufacture a clean report after failure.
fn items(value: &Value, expected: Option<&str>, source: &str) {
    let items = value.as_array().expect("compiler diagnostic array");
    assert_eq!(
        items.len(),
        usize::from(expected.is_some()),
        "exact compiler truth"
    );
    if let Some(code) = expected {
        assert_error(items, code, source);
    }
}
