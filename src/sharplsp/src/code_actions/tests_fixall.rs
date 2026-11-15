//! Unit tests for the fix-all mapping and resolve paths ([FIXALL], GitHub #577).

use super::*;

/// The `Fix all: <title>` actions a fix-all-capable item adds — one per
/// supported scope, each resolving through a `FixAllRequest` in `data`.
/// [FIXALL-LSP] (GitHub #577)
#[test]
fn fix_all_actions_add_one_resolvable_action_per_scope() {
    let item = SidecarCodeActionItem {
        id: 3,
        title: "use 'var' instead of explicit type".to_string(),
        kind: "refactor.rewrite".to_string(),
        is_preferred: true,
        reference: None,
        fix_key: Some("UseImplicitType".to_string()),
        fix_all_scopes: Some(
            ["document", "project", "solution"]
                .map(String::from)
                .to_vec(),
        ),
    };
    let uri: Uri = "file:///w/Core/Inventory.cs".parse().unwrap();
    let actions = fix_all_actions(&item, &uri);
    let titles: Vec<&str> = actions
        .iter()
        .map(|action| match action {
            CodeActionOrCommand::CodeAction(action) => action.title.as_str(),
            CodeActionOrCommand::Command(_) => "command",
        })
        .collect();
    assert_eq!(
        titles,
        [
            "Fix all in document: use 'var' instead of explicit type",
            "Fix all in project: use 'var' instead of explicit type",
            "Fix all in solution: use 'var' instead of explicit type",
        ]
    );
    assert!(
        actions
            .iter()
            .all(|action| matches!(action, CodeActionOrCommand::CodeAction(_))),
        "every fix-all action is a code action, not a command"
    );
    for action in &actions {
        let CodeActionOrCommand::CodeAction(action) = action else {
            continue;
        };
        let Some(request) = action.data.as_ref().and_then(|d| d.get("fixAll")) else {
            continue;
        };
        let Some(scope) = request.get("scope").and_then(serde_json::Value::as_str) else {
            continue;
        };
        assert_eq!(
            action.kind,
            Some(CodeActionKind::REFACTOR_REWRITE),
            "the fix-all keeps the fix's kind"
        );
        assert_eq!(
            action.is_preferred,
            Some(false),
            "a fix-all is never preferred"
        );
        let id = action
            .data
            .as_ref()
            .and_then(|d| d.get("id"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default();
        assert!(
            id > 0,
            "a fix-all carries a positive data id, as every listed action does"
        );
        assert_eq!(
            action.data,
            Some(serde_json::json!({
                "id": id,
                "fixAll": {
                    "fixKey": "UseImplicitType",
                    "scope": scope,
                    "enforce": false,
                },
                "uri": "file:///w/Core/Inventory.cs",
            })),
            "the data carries its id, the whole `FixAllRequest` and the anchor uri"
        );
    }
}

/// The `data.id` of every listed fix-all action.
fn fix_all_ids(actions: &[CodeActionOrCommand]) -> Vec<serde_json::Value> {
    actions
        .iter()
        .filter_map(|action| match action {
            CodeActionOrCommand::CodeAction(action) => action.data.clone(),
            CodeActionOrCommand::Command(_) => None,
        })
        .filter_map(|data| data.get("id").cloned())
        .collect()
}

/// Every listed action carries a unique, fresh, positive `data.id`, and the
/// editors key actions by it: a fix-all's is its own, never the single-site
/// fix's, and a requery mints new ones. [FIXALL-LSP] (GitHub #577)
#[test]
fn fix_all_actions_carry_unique_fresh_ids() {
    let item = SidecarCodeActionItem {
        id: 3,
        title: "use 'var' instead of explicit type".to_string(),
        kind: "refactor.rewrite".to_string(),
        is_preferred: true,
        reference: None,
        fix_key: Some("UseImplicitType".to_string()),
        fix_all_scopes: Some(
            ["document", "project", "solution"]
                .map(String::from)
                .to_vec(),
        ),
    };
    let uri: Uri = "file:///w/Core/Inventory.cs".parse().unwrap();
    let actions = fix_all_actions(&item, &uri);
    let first = fix_all_ids(&actions);
    let unique: std::collections::HashSet<String> = first.iter().map(ToString::to_string).collect();
    assert_eq!(
        unique.len(),
        3,
        "each scope's action has its own id: {first:?}"
    );
    assert!(
        !first.contains(&serde_json::json!(item.id)),
        "never the single-site fix's id: {first:?}"
    );
    let requeried = fix_all_ids(&fix_all_actions(&item, &uri));
    assert!(
        requeried.iter().all(|id| !first.contains(id)),
        "a requery mints fresh ids: {first:?} then {requeried:?}"
    );
}

/// A fix with no fix-all identity adds nothing — and a fix-all-capable fix
/// with no offered scopes adds nothing either. [FIXALL-SCOPES]
#[test]
fn fix_all_actions_are_added_only_for_capable_fixes_with_scopes() {
    let uri: Uri = "file:///w/Core/Inventory.cs".parse().unwrap();
    let no_key = SidecarCodeActionItem {
        id: 1,
        title: "Extract method".to_string(),
        kind: "refactor.extract".to_string(),
        is_preferred: false,
        reference: None,
        fix_key: None,
        fix_all_scopes: Some(vec!["document".to_string()]),
    };
    assert_eq!(fix_all_actions(&no_key, &uri).len(), 0);
    let no_scopes = SidecarCodeActionItem {
        id: 2,
        title: "use 'var' instead of explicit type".to_string(),
        kind: "refactor.rewrite".to_string(),
        is_preferred: false,
        reference: None,
        fix_key: Some("UseImplicitType".to_string()),
        fix_all_scopes: None,
    };
    assert_eq!(fix_all_actions(&no_scopes, &uri).len(), 0);
}

/// The `FixAllRequest` parses from the camelCase keys the listing wrote, and is
/// absent for a single-site action. [FIXALL-LSP]
#[test]
fn fix_all_data_parses_the_camel_case_request() {
    let action: CodeAction = serde_json::from_value(serde_json::json!({
        "title": "Fix all in document: use 'var' instead of explicit type",
        "kind": "refactor.rewrite",
        "data": {
            "fixAll": { "fixKey": "UseImplicitType", "scope": "document", "enforce": false },
            "uri": "file:///w/Core/Inventory.cs"
        }
    }))
    .unwrap();
    let fix_all = fix_all_data(&action).expect("the fix-all request parses");
    assert_eq!(fix_all.fix_key, "UseImplicitType");
    assert_eq!(fix_all.scope, "document");
    assert!(!fix_all.enforce);

    let single_site: CodeAction = serde_json::from_value(serde_json::json!({
        "title": "use 'var' instead of explicit type",
        "kind": "refactor.rewrite",
        "data": { "id": 7, "uri": "file:///w/Core/Inventory.cs" }
    }))
    .unwrap();
    assert!(fix_all_data(&single_site).is_none());
}

/// The fix-all request to the sidecar serializes as a positional `MessagePack`
/// `(file_path, fix_key, scope)` array, matching the sidecar's `FixAllRequest`
/// Key layout. [FIXALL-SCOPES]
#[test]
fn sidecar_fix_all_request_serializes_positionally() {
    let bytes = rmp_serde::to_vec(&SidecarFixAllReq {
        file_path: "/w/Core/Inventory.cs".to_string(),
        fix_key: "UseImplicitType".to_string(),
        scope: "solution".to_string(),
    })
    .unwrap();
    let decoded: Vec<String> = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(
        decoded,
        ["/w/Core/Inventory.cs", "UseImplicitType", "solution"]
    );
}
