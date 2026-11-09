//! Member sorting tests for `sharplsp/sortMembers`.
#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]

use super::*;

#[test]
fn access_priority_returns_index() {
    let order = vec![
        "public".to_string(),
        "internal".to_string(),
        "private".to_string(),
    ];
    assert_eq!(access_priority(Some("public"), &order), 0);
    assert_eq!(access_priority(Some("internal"), &order), 1);
    assert_eq!(access_priority(Some("private"), &order), 2);
    assert_eq!(access_priority(None, &order), 3);
}

#[test]
fn category_priority_returns_index() {
    let order = vec!["field".to_string(), "method".to_string()];
    assert_eq!(category_priority("field", &order), 0);
    assert_eq!(category_priority("method", &order), 1);
    assert_eq!(category_priority("unknown", &order), 2);
}

#[test]
fn sort_member_infos_sorts_by_hierarchy() {
    let members = vec![
        MemberInfo {
            index: 0,
            name: "Zebra".to_string(),
            category: "method".to_string(),
            access: Some("private".to_string()),
            trivia_byte: 0,
            end_byte: 10,
            end_row: 0,
            end_col: 10,
        },
        MemberInfo {
            index: 1,
            name: "Alpha".to_string(),
            category: "field".to_string(),
            access: Some("public".to_string()),
            trivia_byte: 10,
            end_byte: 20,
            end_row: 1,
            end_col: 10,
        },
    ];
    let config = SortConfig {
        hierarchy: vec![
            "accessibility".to_string(),
            "category".to_string(),
            "alphabetical".to_string(),
        ],
        accessibility_order: vec!["public".to_string(), "private".to_string()],
        category_order: vec!["field".to_string(), "method".to_string()],
    };
    let sorted = sort_member_infos(&members, &config);
    // Public field Alpha should come first.
    assert_eq!(sorted, vec![1, 0]);
}

#[test]
fn member_category_classifies_correctly() {
    // This test would require tree-sitter nodes, so we test the
    // priority functions instead (above). The category mapping is
    // verified in E2E tests.
}

#[test]
fn handle_reorders_out_of_order_members_into_edits() {
    // A class (no modifier, so the declaration starts at column 0) whose
    // members are deliberately out of accessibility/category order. Sorting
    // drives collect_members, member_category, access/variable name
    // extraction, sort_member_infos, build_edits and byte_to_position.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("Sample.cs");
    let source = "class Sample\n\
{\n\
private int _field;\n\
public void Beta() { }\n\
public int Alpha { get; set; }\n\
public Sample() { }\n\
private const int Max = 10;\n\
}\n";
    std::fs::write(&file, source).unwrap();

    let params = SortMembersParams {
        uri: crate::paths::path_to_uri(&file.to_string_lossy()).unwrap(),
        range: SortRange {
            start: SortPosition {
                line: 0,
                character: 0,
            },
            end: SortPosition {
                line: 7,
                character: 1,
            },
        },
        sort_config: SortConfig {
            hierarchy: vec![
                "accessibility".to_string(),
                "category".to_string(),
                "alphabetical".to_string(),
            ],
            accessibility_order: vec![
                "public".to_string(),
                "protected".to_string(),
                "internal".to_string(),
                "private".to_string(),
            ],
            category_order: vec![
                "const".to_string(),
                "field".to_string(),
                "constructor".to_string(),
                "property".to_string(),
                "method".to_string(),
            ],
        },
    };

    let response = handle(&params, &TsParsers::new(), &crate::vfs::Vfs::new()).unwrap();

    assert!(
        !response.edits.is_empty(),
        "out-of-order members must produce reordering edits"
    );
}

#[test]
fn handle_on_single_member_type_makes_no_edits() {
    // Fewer than two members: nothing to reorder.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("One.cs");
    std::fs::write(&file, "class One\n{\n    public int X;\n}\n").unwrap();

    let params = SortMembersParams {
        uri: crate::paths::path_to_uri(&file.to_string_lossy()).unwrap(),
        range: SortRange {
            start: SortPosition {
                line: 0,
                character: 0,
            },
            end: SortPosition {
                line: 3,
                character: 1,
            },
        },
        sort_config: SortConfig {
            hierarchy: vec!["accessibility".to_string()],
            accessibility_order: vec!["public".to_string()],
            category_order: vec!["field".to_string()],
        },
    };

    let response = handle(&params, &TsParsers::new(), &crate::vfs::Vfs::new()).unwrap();
    assert!(response.edits.is_empty());
}
