//! Tests for [NUGET-REQUESTS-UPDATE-BOUNDS] and explicit selection.
#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]

use super::{
    ensure_snapshot, select_bounded, select_explicit, single_declaration, Declaration,
    UpdateBoundary,
};
use crate::nuget::types::InstalledPackageInfo;

#[test]
fn selects_highest_stable_within_major_using_nuget_ordering() {
    let selected = select_bounded(
        "1.0.0",
        &["2.0.0", "1.9.0", "1.10.0", "1.3.0-beta.1", "1.0.0"],
    )
    .unwrap();
    assert_eq!(selected.as_deref(), Some("1.10.0"));
}

#[test]
fn zero_major_stays_within_minor() {
    let selected = select_bounded("0.4.2", &["0.5.0", "0.4.9", "0.4.10-beta.1"]).unwrap();
    assert_eq!(selected.as_deref(), Some("0.4.9"));
}

#[test]
fn no_newer_stable_candidate_returns_none() {
    let selected = select_bounded("1.2.0", &["2.0.0", "1.3.0-beta.1", "1.2.0"]).unwrap();
    assert_eq!(selected, None);
}

#[test]
fn four_part_versions_and_metadata_use_nuget_semantics() {
    let selected = select_bounded("1.2.3.4", &["1.2.3.10+build.2", "1.2.4"]).unwrap();
    assert_eq!(selected.as_deref(), Some("1.2.4"));
}

#[test]
fn explicit_selection_identifies_every_opt_in_boundary() {
    let cases = [
        ("1.0.0", "2.0.0", UpdateBoundary::Major),
        ("0.4.2", "0.5.0", UpdateBoundary::ZeroMinor),
        ("1.2.0", "1.3.0-beta.1", UpdateBoundary::Prerelease),
        ("1.0.0", "1.2.0", UpdateBoundary::SameLine),
    ];
    for (current, selected, boundary) in cases {
        let proposal = select_explicit(current, selected).unwrap();
        assert_eq!(proposal.version, selected);
        assert_eq!(proposal.boundary, boundary);
    }
}

#[test]
fn explicit_selection_still_requires_a_concrete_version() {
    for selected in ["latest", "1.*", "[1.0,2.0)"] {
        assert!(select_explicit("1.0.0", selected).is_err());
    }
}

#[test]
fn floating_or_property_declarations_are_rejected() {
    for current in ["1.*", "[1.0,2.0)", "$(ControlledVersion)", "latest"] {
        let error = select_bounded(current, &["1.2.0"]).unwrap_err();
        assert!(error.to_string().contains("explicit version selection"));
    }
}

#[test]
fn equivalent_framework_occurrences_are_one_declaration() {
    let declaration = single_declaration(
        vec![installed("1.0.0", "1.0.0"), installed("1.0.0", "1.0.0")],
        "SharpLsp.Controlled",
    )
    .unwrap();
    assert_eq!(declaration.requested, "1.0.0");
    assert_eq!(declaration.resolved, "1.0.0");
}

#[test]
fn differently_resolved_frameworks_require_explicit_selection() {
    let error = single_declaration(
        vec![installed("1.0.0", "1.0.0"), installed("1.0.0", "1.2.0")],
        "SharpLsp.Controlled",
    )
    .unwrap_err();
    assert!(error.to_string().contains("Ambiguous installed versions"));
    assert!(error.to_string().contains("explicit version selection"));
}

#[test]
fn absent_package_cannot_be_installed_by_update() {
    let error = single_declaration(Vec::new(), "SharpLsp.Absent").unwrap_err();
    assert!(error
        .to_string()
        .contains("not an installed direct package"));
}

#[test]
fn stale_requested_or_resolved_versions_are_both_rejected() {
    let current = Declaration {
        requested: "1.0.0".to_string(),
        resolved: "1.0.0".to_string(),
    };
    assert!(ensure_snapshot(&current, Some("1.0.0"), Some("1.0.0")).is_ok());
    assert!(ensure_snapshot(&current, Some("1.2.0"), Some("1.0.0")).is_err());
    assert!(ensure_snapshot(&current, Some("1.0.0"), Some("1.*")).is_err());
}

fn installed(requested: &str, resolved: &str) -> InstalledPackageInfo {
    InstalledPackageInfo {
        id: "SharpLsp.Controlled".to_string(),
        requested_version: requested.to_string(),
        resolved_version: resolved.to_string(),
    }
}
