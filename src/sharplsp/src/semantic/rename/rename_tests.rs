//! Rename merge and wire-decoding tests. [RENAME-APPLY] [RENAME-CROSSLANGUAGE]
#![expect(
    clippy::panic_in_result_fn,
    reason = "test code — a failed assert IS the failure mode; returning Err \
              instead would hide which condition broke"
)]

use super::merge::*;
use super::*;

/// The C# sidecar's four-field document edit must decode on the rename path.
/// [RAZOR-FSHARP-RENAME]
#[test]
fn csharp_rename_wire_result_decodes_to_exact_workspace_edit() -> Result<()> {
    use crate::paths::test_paths::{NATIVE_FILE, NATIVE_FILE_URI};
    let edit = (2, 3, 2, 8, "Points");
    let document = (NATIVE_FILE, vec![edit], false, Option::<String>::None);
    let bytes = rmp_serde::to_vec(&(vec![document],))?;
    let decoded: SidecarWorkspaceEditResult = rmp_serde::from_slice(&bytes)?;
    let expected = expected_rename_workspace_edit(NATIVE_FILE_URI);
    assert_eq!(workspace_edit_value(decoded)?, expected);
    Ok(())
}

fn expected_rename_workspace_edit(uri: &str) -> serde_json::Value {
    serde_json::json!({"documentChanges": [{
        "textDocument": {"uri": uri, "version": null},
        "edits": [{
            "range": {
                "start": {"line": 2, "character": 3},
                "end": {"line": 2, "character": 8}
            },
            "newText": "Points"
        }]
    }]})
}

/// Rename returns text edits only; resource operations fail with a reason.
/// [REFACTOR-NEVER-SILENT]
#[test]
fn rename_refuses_sidecar_file_creation_and_renames() -> Result<()> {
    use crate::paths::test_paths::NATIVE_FILE;
    let operations = [(true, None), (false, Some("/tmp/Renamed.cs"))];
    for (create, rename_to) in operations {
        let edits = Vec::<(u32, u32, u32, u32, &str)>::new();
        let bytes = rmp_serde::to_vec(&(vec![(NATIVE_FILE, edits, create, rename_to)],))?;
        let decoded: SidecarWorkspaceEditResult = rmp_serde::from_slice(&bytes)?;
        let Err(error) = workspace_edit_value(decoded) else {
            anyhow::bail!("a resource operation must not become a text edit");
        };
        assert_eq!(error.to_string(), "rename cannot create or rename files");
    }
    Ok(())
}

/// Best-effort enrichment must not hide a foreign resource operation.
/// [REFACTOR-NEVER-SILENT]
#[test]
fn foreign_resource_operation_is_not_dropped_by_best_effort_merge() -> Result<()> {
    use crate::paths::test_paths::NATIVE_FILE;
    let primary = workspace_edit(NATIVE_FILE, vec![rename_edit(0, 0, 4, "New")]);
    let foreign = SidecarWorkspaceEditResult {
        document_changes: vec![SidecarDocumentEditResult {
            file_path: NATIVE_FILE.to_string(),
            edits: Vec::new(),
            create: true,
            rename_to: None,
        }],
    };
    let Err(error) = workspace_edit_value(merge_or_keep(primary, foreign)) else {
        anyhow::bail!("the foreign create must refuse the whole rename");
    };
    assert_eq!(error.to_string(), "rename cannot create or rename files");
    Ok(())
}

#[test]
fn cross_language_merge_normalizes_paths_and_deduplicates_edits() -> Result<()> {
    let duplicate = rename_edit(1, 3, 15, "Renamed");
    let primary = workspace_edit("folder\\Origin.cs", vec![duplicate]);
    let foreign = SidecarWorkspaceEditResult {
        document_changes: vec![
            document_edit("folder/Origin.cs", vec![rename_edit(1, 3, 15, "Renamed")]),
            document_edit("folder/Foreign.fs", vec![rename_edit(2, 8, 14, "Renamed")]),
        ],
    };
    let merged = merge_workspace_edits(primary, foreign)?;
    assert_merged_documents(&merged)
}

#[test]
fn cross_language_merge_rejects_conflicts_and_accepts_boundaries() -> Result<()> {
    assert_overlap_conflicts()?;
    assert_insertion_conflict();
    assert_invalid_and_adjacent_ranges()
}

/// A document whose path cannot be turned into a URI must not sink the whole
/// rename — the remaining documents still have to reach the editor.
#[test]
fn unconvertible_document_path_is_skipped_not_fatal() -> Result<()> {
    let absolute = if cfg!(windows) {
        r"C:\repo\Good.cs"
    } else {
        "/repo/Good.cs"
    };
    let result = SidecarWorkspaceEditResult {
        document_changes: vec![
            document_edit("relative/Bad.cs", vec![rename_edit(0, 0, 3, "New")]),
            document_edit(absolute, vec![rename_edit(1, 0, 3, "New")]),
        ],
    };

    let rendered = workspace_edit_value(result)?.to_string();

    assert!(
        rendered.contains("Good.cs"),
        "the convertible document must survive: {rendered}"
    );
    assert!(
        !rendered.contains("Bad.cs"),
        "the unconvertible document must be skipped: {rendered}"
    );
    Ok(())
}

fn assert_overlap_conflicts() -> Result<()> {
    let Err(overlap) = merge_workspace_edits(
        workspace_edit("Origin.cs", vec![rename_edit(1, 3, 15, "One")]),
        workspace_edit("Origin.cs", vec![rename_edit(1, 8, 18, "Two")]),
    ) else {
        anyhow::bail!("overlapping edits must fail");
    };
    assert!(overlap.to_string().contains("overlapping rename edits"));
    assert!(overlap.to_string().contains("Origin.cs"));
    let conflict = merge_workspace_edits(
        workspace_edit("Origin.cs", vec![rename_edit(1, 3, 15, "One")]),
        workspace_edit("Origin.cs", vec![rename_edit(1, 3, 15, "Two")]),
    );
    assert!(
        conflict.is_err(),
        "same range with different text must fail"
    );
    Ok(())
}

fn assert_insertion_conflict() {
    let insertion = merge_workspace_edits(
        workspace_edit("Origin.cs", vec![rename_edit(1, 3, 15, "One")]),
        workspace_edit("Origin.cs", vec![rename_edit(1, 8, 8, "Two")]),
    );
    assert!(insertion.is_err(), "an insertion inside a range must fail");
}

#[test]
fn cross_language_wire_contract_uses_the_declared_key_order() -> Result<()> {
    let bytes = rmp_serde::to_vec(&(true, "Assembly", "T:Example.Symbol"))?;
    let identity: SidecarRenameIdentityResult = rmp_serde::from_slice(&bytes)?;
    assert!(identity.found);
    assert_eq!(identity.assembly_name, "Assembly");
    assert_eq!(identity.xml_doc_sig, "T:Example.Symbol");
    let request = SidecarForeignRenameRequest::new(identity, "Renamed".to_string());
    let bytes = rmp_serde::to_vec(&request)?;
    let tuple: (String, String, String) = rmp_serde::from_slice(&bytes)?;
    assert_eq!(
        tuple,
        (
            "Assembly".into(),
            "T:Example.Symbol".into(),
            "Renamed".into()
        )
    );
    Ok(())
}

fn workspace_edit(path: &str, edits: Vec<SidecarTextEditResult>) -> SidecarWorkspaceEditResult {
    SidecarWorkspaceEditResult {
        document_changes: vec![document_edit(path, edits)],
    }
}

fn document_edit(path: &str, edits: Vec<SidecarTextEditResult>) -> SidecarDocumentEditResult {
    SidecarDocumentEditResult {
        file_path: path.to_string(),
        edits,
        create: false,
        rename_to: None,
    }
}

fn rename_edit(line: u32, start: u32, end: u32, new_text: &str) -> SidecarTextEditResult {
    SidecarTextEditResult {
        start_line: line,
        start_character: start,
        end_line: line,
        end_character: end,
        new_text: new_text.to_string(),
    }
}

fn assert_invalid_and_adjacent_ranges() -> Result<()> {
    let invalid = workspace_edit("Origin.cs", vec![rename_edit(2, 9, 4, "Invalid")]);
    let Err(invalid) = canonicalize_workspace_edit(invalid) else {
        anyhow::bail!("reversed ranges must fail");
    };
    assert!(invalid.to_string().contains("invalid rename range"));
    let adjacent = merge_workspace_edits(
        workspace_edit("Origin.cs", vec![rename_edit(1, 3, 8, "One")]),
        workspace_edit("Origin.cs", vec![rename_edit(1, 8, 15, "Two")]),
    )?;
    assert_adjacent_edits(&adjacent)
}

fn assert_merged_documents(merged: &SidecarWorkspaceEditResult) -> Result<()> {
    let [foreign, origin] = merged.document_changes.as_slice() else {
        anyhow::bail!("merge must return the two language documents");
    };
    let [origin_edit] = origin.edits.as_slice() else {
        anyhow::bail!("the deduplicated origin must contain one edit");
    };
    assert_eq!(foreign.file_path, "folder/Foreign.fs");
    assert_eq!(foreign.edits.len(), 1);
    assert_eq!(origin_edit.start_character, 3);
    assert_eq!(origin_edit.end_character, 15);
    assert_eq!(origin_edit.new_text, "Renamed");
    Ok(())
}

fn assert_adjacent_edits(adjacent: &SidecarWorkspaceEditResult) -> Result<()> {
    let [document] = adjacent.document_changes.as_slice() else {
        anyhow::bail!("adjacent edits must remain in one document");
    };
    let [first, second] = document.edits.as_slice() else {
        anyhow::bail!("both adjacent edits must be preserved");
    };
    assert_eq!(first.new_text, "One");
    assert_eq!(second.new_text, "Two");
    Ok(())
}
