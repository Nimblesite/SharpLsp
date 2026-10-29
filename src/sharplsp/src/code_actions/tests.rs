//! Unit tests for the code-action mapping and resolve paths.

use super::*;

#[test]
fn map_action_kind_known_kinds() {
    assert_eq!(
        map_action_kind("refactor.extract"),
        CodeActionKind::REFACTOR_EXTRACT
    );
    assert_eq!(
        map_action_kind("refactor.inline"),
        CodeActionKind::REFACTOR_INLINE
    );
    assert_eq!(
        map_action_kind("refactor.rewrite"),
        CodeActionKind::REFACTOR_REWRITE
    );
    assert_eq!(
        map_action_kind("source.organizeImports"),
        CodeActionKind::SOURCE_ORGANIZE_IMPORTS,
    );
    assert_eq!(map_action_kind("refactor"), CodeActionKind::REFACTOR);
}

#[test]
fn map_action_kind_unknown_falls_back_to_quickfix() {
    assert_eq!(map_action_kind(""), CodeActionKind::QUICKFIX);
    assert_eq!(map_action_kind("anything-else"), CodeActionKind::QUICKFIX);
}

#[test]
fn map_code_action_carries_metadata() {
    let item = SidecarCodeActionItem {
        id: 7,
        title: "Add using".to_string(),
        kind: "quickfix".to_string(),
        is_preferred: true,
        reference: None,
    };
    let uri: Uri = "file:///tmp/Foo.cs".parse().unwrap();
    let action = map_code_action(&item, &uri);
    assert_eq!(action.title, "Add using");
    assert_eq!(action.kind, Some(CodeActionKind::QUICKFIX));
    assert_eq!(action.is_preferred, Some(true));
    let data = action.data.unwrap();
    assert_eq!(data["id"], serde_json::json!(7));
    assert_eq!(data["uri"], serde_json::json!("file:///tmp/Foo.cs"));
}

/// [REFACTOR-IMPORT-REFERENCE]: a reference row is an edit action AND a
/// command action — the client resolves its `data` to the import edit,
/// applies it, then runs the command that adds the reference.
#[test]
fn map_code_action_with_a_reference_resolves_its_import_and_carries_the_command() {
    let reference = crate::import_command::SidecarReferenceImport {
        kind: "project".to_string(),
        project_path: "/s/App/App.csproj".to_string(),
        reference: "/s/Lib/Lib.csproj".to_string(),
        version: String::new(),
    };
    let item = SidecarCodeActionItem {
        id: 9,
        title: "Reference project Lib from App.csproj and add 'using Shapes;'".to_string(),
        kind: "quickfix".to_string(),
        is_preferred: false,
        reference: Some(reference),
    };
    let uri: Uri = "file:///s/App/Probe.cs".parse().unwrap();
    let action = map_code_action(&item, &uri);

    let data = action
        .data
        .clone()
        .expect("the import edit resolves through data");
    assert_eq!(
        data,
        serde_json::json!({"id": 9, "uri": "file:///s/App/Probe.cs"})
    );
    let command = action
        .command
        .expect("the reference is added by the command");
    assert_eq!(command.command, "sharplsp.addReferenceAndImport");
    assert_eq!(command.title, item.title);
    assert_eq!(
        command.arguments,
        Some(vec![serde_json::json!({
            "title": item.title,
            "action": {"id": 9, "uri": "file:///s/App/Probe.cs"},
            "reference": {
                "kind": "project",
                "projectPath": "/s/App/App.csproj",
                "reference": "/s/Lib/Lib.csproj",
                "version": "",
            },
        })])
    );
    assert_eq!(action.kind, Some(CodeActionKind::QUICKFIX));
}

#[test]
#[expect(
    clippy::mutable_key_type,
    reason = "Uri is the key type mandated by lsp-types WorkspaceEdit"
)]
fn map_workspace_edit_groups_edits_by_uri() {
    use crate::paths::test_paths::{NATIVE_FILE, NATIVE_FILE_URI};
    let edit = SidecarWorkspaceEdit {
        document_changes: vec![SidecarDocumentEdit {
            create: false,
            rename_to: None,
            file_path: NATIVE_FILE.to_string(),
            edits: vec![
                SidecarTextEdit {
                    start_line: 0,
                    start_character: 0,
                    end_line: 0,
                    end_character: 1,
                    new_text: "a".to_string(),
                },
                SidecarTextEdit {
                    start_line: 5,
                    start_character: 6,
                    end_line: 5,
                    end_character: 7,
                    new_text: "b".to_string(),
                },
            ],
        }],
    };
    let workspace_edit = map_workspace_edit(&edit).expect("a native path maps");
    let changes = workspace_edit.changes.unwrap();
    assert_eq!(changes.len(), 1);
    let (uri, edits) = changes.iter().next().unwrap();
    assert_eq!(uri.as_str(), NATIVE_FILE_URI);
    assert_eq!(edits.len(), 2);
    assert_eq!(edits[0].new_text, "a");
    assert_eq!(edits[1].new_text, "b");
}

/// A path that cannot become a URI fails the whole resolve with a reason
/// naming it — it is never silently dropped. [REFACTOR-NEVER-SILENT]
#[test]
fn map_workspace_edit_fails_on_an_unparseable_path() {
    let edit = SidecarWorkspaceEdit {
        document_changes: vec![SidecarDocumentEdit {
            create: false,
            rename_to: None,
            file_path: "\u{0}".to_string(),
            edits: vec![],
        }],
    };
    let failure = map_workspace_edit(&edit)
        .expect_err("an unparseable path must fail the resolve, not vanish");
    let reason = format!("{failure:#}");
    assert!(
        reason.contains("cannot become a URI"),
        "the reason must say what could not be done: {reason}"
    );
    assert!(
        reason.contains('\u{0}'),
        "the reason must name the offending path: {reason}"
    );
}

/// An edit that creates a file creates it before writing its text, and
/// edits the other files in the same document changes. [RAZOR-CODE-ACTIONS]
#[test]
fn map_workspace_edit_creates_new_files_before_editing_them() {
    use crate::paths::test_paths::{NATIVE_FILE, NATIVE_FILE_URI};
    let text = |new_text: &str| SidecarTextEdit {
        start_line: 0,
        start_character: 0,
        end_line: 0,
        end_character: 0,
        new_text: new_text.to_string(),
    };
    let created = format!("{NATIVE_FILE}.cs");
    let edit = SidecarWorkspaceEdit {
        document_changes: vec![
            SidecarDocumentEdit {
                create: true,
                rename_to: None,
                file_path: created.clone(),
                edits: vec![text("public partial class Counter {}")],
            },
            SidecarDocumentEdit {
                create: false,
                rename_to: None,
                file_path: NATIVE_FILE.to_string(),
                edits: vec![text("")],
            },
        ],
    };
    let workspace_edit = map_workspace_edit(&edit).expect("the edit maps");
    assert!(workspace_edit.changes.is_none());
    let operations = match workspace_edit.document_changes {
        Some(DocumentChanges::Operations(operations)) => operations,
        _ => Vec::new(),
    };
    let steps: Vec<(&str, &str, Option<bool>, usize)> =
        operations.iter().map(operation_step).collect();
    let created_uri = crate::paths::path_to_lsp_uri(&created).unwrap();
    assert_eq!(
        steps,
        [
            ("create", created_uri.as_str(), Some(false), 0),
            ("edit", created_uri.as_str(), None, 1),
            ("edit", NATIVE_FILE_URI, None, 1),
        ],
        "the new file is created, then written, then the existing file is edited"
    );
    assert!(
        operations.iter().all(|operation| !matches!(
            operation,
            DocumentChangeOperation::Edit(TextDocumentEdit {
                text_document: OptionalVersionedTextDocumentIdentifier {
                    version: Some(_),
                    ..
                },
                ..
            })
        )),
        "no edit pins a document version"
    );
}

/// [REFACTOR-MOVE-TYPE-RENAME-FILE]
#[test]
fn map_workspace_edit_renames_before_editing_the_new_uri() {
    use crate::paths::test_paths::{NATIVE_FILE, NATIVE_FILE_URI};
    let renamed = format!("{NATIVE_FILE}.renamed");
    let renamed_uri = crate::paths::path_to_lsp_uri(&renamed).unwrap();
    let edit = SidecarWorkspaceEdit {
        document_changes: vec![SidecarDocumentEdit {
            create: false,
            rename_to: Some(renamed),
            file_path: NATIVE_FILE.to_string(),
            edits: vec![SidecarTextEdit {
                start_line: 0,
                start_character: 0,
                end_line: 0,
                end_character: 1,
                new_text: "Lone".to_string(),
            }],
        }],
    };
    let workspace_edit = map_workspace_edit(&edit).expect("the edit maps");
    assert!(workspace_edit.changes.is_none());
    let operations = match workspace_edit.document_changes {
        Some(DocumentChanges::Operations(operations)) => operations,
        _ => Vec::new(),
    };
    assert_eq!(operations.len(), 2);
    assert!(matches!(
        operations[0],
        DocumentChangeOperation::Op(ResourceOp::Rename(_))
    ));
    let rename = operations
        .iter()
        .find_map(|operation| match operation {
            DocumentChangeOperation::Op(ResourceOp::Rename(rename)) => Some(rename),
            DocumentChangeOperation::Op(_) | DocumentChangeOperation::Edit(_) => None,
        })
        .unwrap();
    assert_eq!(rename.old_uri.as_str(), NATIVE_FILE_URI);
    assert_eq!(rename.new_uri, renamed_uri);
    let options = rename.options.as_ref().unwrap();
    assert_eq!(options.overwrite, Some(false));
    assert_eq!(options.ignore_if_exists, Some(false));
    assert_eq!(rename.annotation_id, None);
    assert!(matches!(operations[1], DocumentChangeOperation::Edit(_)));
    let edit = operations
        .iter()
        .find_map(|operation| match operation {
            DocumentChangeOperation::Edit(edit) => Some(edit),
            DocumentChangeOperation::Op(_) => None,
        })
        .unwrap();
    assert_eq!(edit.text_document.uri, renamed_uri);
    assert_eq!(edit.text_document.version, None);
    assert_eq!(edit.edits.len(), 1);
}

/// [REFACTOR-MOVE-TYPE-RENAME-FILE]
#[test]
fn map_workspace_edit_rename_without_text_emits_only_the_resource_operation() {
    use crate::paths::test_paths::NATIVE_FILE;
    let edit = SidecarWorkspaceEdit {
        document_changes: vec![SidecarDocumentEdit {
            create: false,
            rename_to: Some(format!("{NATIVE_FILE}.renamed")),
            file_path: NATIVE_FILE.to_string(),
            edits: vec![],
        }],
    };
    assert!(edit.document_changes[0].rename_to.is_some());
    let workspace_edit = map_workspace_edit(&edit).expect("the edit maps");
    assert!(workspace_edit.changes.is_none());
    let operations = match workspace_edit.document_changes {
        Some(DocumentChanges::Operations(operations)) => operations,
        _ => Vec::new(),
    };
    assert_eq!(operations.len(), 1);
    assert!(matches!(
        operations[0],
        DocumentChangeOperation::Op(ResourceOp::Rename(_))
    ));
}

/// A creating edit drops a document whose path is no URI, and keeps the
/// others: the new file is still created. [RAZOR-CODE-ACTIONS]
/// A creating edit with a document whose path is no URI fails the resolve
/// with a reason — the file that WOULD have been created is not silently
/// lost. [REFACTOR-NEVER-SILENT]
#[test]
fn map_workspace_edit_creating_files_fails_on_an_unparseable_path() {
    use crate::paths::test_paths::NATIVE_FILE;
    let created = format!("{NATIVE_FILE}.cs");
    let edit = SidecarWorkspaceEdit {
        document_changes: vec![
            SidecarDocumentEdit {
                create: true,
                rename_to: None,
                file_path: created.clone(),
                edits: vec![],
            },
            SidecarDocumentEdit {
                create: false,
                rename_to: None,
                file_path: "\u{0}".to_string(),
                edits: vec![],
            },
        ],
    };
    let failure =
        map_workspace_edit(&edit).expect_err("an unparseable path must fail the whole resolve");
    assert!(
        format!("{failure:#}").contains("cannot become a URI"),
        "the reason must say what could not be done"
    );
}

/// An operation as `(kind, uri, overwrite, edit count)`.
fn operation_step(operation: &DocumentChangeOperation) -> (&str, &str, Option<bool>, usize) {
    match operation {
        DocumentChangeOperation::Op(ResourceOp::Create(create)) => (
            "create",
            create.uri.as_str(),
            create
                .options
                .as_ref()
                .and_then(|options| options.overwrite),
            0,
        ),
        DocumentChangeOperation::Edit(edit) => (
            "edit",
            edit.text_document.uri.as_str(),
            None,
            edit.edits.len(),
        ),
        DocumentChangeOperation::Op(_) => ("other", "", None, 0),
    }
}
