//! Enforcement edit planner for [FIXALL-ENFORCE] and [PKG-VULN-SEVERITY].
//!
//! Produces LSP `DocumentChanges` (`CreateFile` + `TextDocumentEdit`) across
//! `.editorconfig`, `Directory.Build.props`, and `sharplsp.toml`, tagged with a
//! dedicated `ChangeAnnotation` so clients can preview and undo enforcement
//! alongside the code fixes.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use lsp_types::{
    AnnotatedTextEdit, ChangeAnnotation, ChangeAnnotationIdentifier, CreateFile, CreateFileOptions,
    DocumentChangeOperation, DocumentChanges, OneOf, OptionalVersionedTextDocumentIdentifier,
    Position, Range, ResourceOp, TextDocumentEdit, WorkspaceEdit,
};

use super::editorconfig::{self, EditorConfigDoc};
use super::msbuild_props;
use super::rules_generated::{FixRuleAssociation, RuleLanguage, RuleSetting, RuleSink};
use crate::config_nuget::VulnerabilityConfig;

/// Annotation id used for rule-enforcement edits in a combined `WorkspaceEdit`.
pub const ENFORCE_ANNOTATION_ID: &str = "sharplsp.enforce";

/// Annotation id used for multi-file (`project`/`solution`) fix-all code edits.
pub const SCOPE_ANNOTATION_ID: &str = "sharplsp.fixAll.scope";

/// Locate the solution directory for `anchor_path`: nearest ancestor holding a
/// `.sln`, `.slnx`, or `Directory.Build.props`, else `anchor_path`'s parent.
/// [FIXALL-ENFORCE]
pub fn resolve_solution_dir(anchor_path: &str) -> std::path::PathBuf {
    let start = Path::new(anchor_path)
        .parent()
        .unwrap_or_else(|| Path::new("."));
    let mut cursor = Some(start);
    while let Some(dir) = cursor {
        if has_solution_marker(dir) {
            return dir.to_path_buf();
        }
        cursor = dir.parent();
    }
    start.to_path_buf()
}

/// Whether `dir` holds a `.sln`, `.slnx`, or `Directory.Build.props`.
fn has_solution_marker(dir: &Path) -> bool {
    if dir.join("Directory.Build.props").is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| crate::paths::has_extension(entry.path(), &["sln", "slnx"]))
}

/// Wrap `project`/`solution` fix-all code edits with a `needsConfirmation: true`
/// `ChangeAnnotation` so clients show a preview before applying multi-file edits.
/// [FIXALL-LSP]
pub fn annotate_scope_edit(edit: WorkspaceEdit, scope: &str, title: &str) -> WorkspaceEdit {
    if !matches!(scope, "project" | "solution") {
        return edit;
    }
    let id: ChangeAnnotationIdentifier = SCOPE_ANNOTATION_ID.to_string();
    let ops = workspace_edit_ops(edit.changes, edit.document_changes)
        .into_iter()
        .map(|op| match op {
            DocumentChangeOperation::Edit(mut doc) => {
                doc.edits = doc
                    .edits
                    .into_iter()
                    .map(|e| match e {
                        OneOf::Left(text_edit) => OneOf::Right(AnnotatedTextEdit {
                            text_edit,
                            annotation_id: id.clone(),
                        }),
                        OneOf::Right(annotated) => OneOf::Right(annotated),
                    })
                    .collect();
                DocumentChangeOperation::Edit(doc)
            }
            other @ DocumentChangeOperation::Op(_) => other,
        })
        .collect();
    let mut annotations = edit.change_annotations.unwrap_or_default();
    let _ = annotations.insert(
        id,
        ChangeAnnotation {
            label: title.to_string(),
            needs_confirmation: Some(true),
            description: Some(format!("Apply fix across {scope}")),
        },
    );
    WorkspaceEdit {
        changes: None,
        document_changes: Some(DocumentChanges::Operations(ops)),
        change_annotations: Some(annotations),
    }
}

/// Build enforcement edits for `assoc` anchored at `solution_dir`. [FIXALL-ENFORCE]
pub fn build_enforcement_edit(
    solution_dir: &Path,
    assoc: &FixRuleAssociation,
    vuln_config: Option<&VulnerabilityConfig>,
) -> Result<WorkspaceEdit> {
    let settings: Vec<&RuleSetting> = assoc.rules.iter().flat_map(|r| &r.settings).collect();
    let rule_ids: Vec<&str> = assoc
        .rules
        .iter()
        .map(|r| r.diagnosticId.as_str())
        .collect();
    let label = format!("Enforce {}", rule_ids.join(", "));
    let annotation_id: ChangeAnnotationIdentifier = ENFORCE_ANNOTATION_ID.to_string();

    let mut ops = Vec::new();
    append_editorconfig_ops(
        solution_dir,
        &assoc.language,
        &settings,
        &annotation_id,
        &mut ops,
    )?;
    append_msbuild_ops(
        solution_dir,
        &settings,
        vuln_config,
        &annotation_id,
        &mut ops,
    )?;
    append_toml_ops(solution_dir, &settings, &annotation_id, &mut ops)?;

    let mut annotations = HashMap::new();
    let _ = annotations.insert(
        annotation_id,
        ChangeAnnotation {
            label,
            needs_confirmation: Some(true),
            description: Some("Writes rule enforcement configuration".to_string()),
        },
    );

    Ok(WorkspaceEdit {
        document_changes: Some(DocumentChanges::Operations(ops)),
        change_annotations: Some(annotations),
        ..WorkspaceEdit::default()
    })
}

/// Emit `.editorconfig` edits for all `EditorConfig` settings in `settings`.
fn append_editorconfig_ops(
    solution_dir: &Path,
    lang: &RuleLanguage,
    settings: &[&RuleSetting],
    annotation_id: &ChangeAnnotationIdentifier,
    ops: &mut Vec<DocumentChangeOperation>,
) -> Result<()> {
    let ec_settings: Vec<&RuleSetting> = settings
        .iter()
        .copied()
        .filter(|s| s.sink == RuleSink::EditorConfig)
        .collect();
    if ec_settings.is_empty() {
        return Ok(());
    }
    let section = match lang {
        RuleLanguage::FSharp => "*.{fs,fsi,fsx}",
        RuleLanguage::CSharp => "*.cs",
    };
    let target = editorconfig::resolve_target(solution_dir);
    let keys: Vec<&str> = ec_settings.iter().map(|s| s.key.as_str()).collect();
    let mut files = vec![target];
    files.extend(editorconfig::find_overriding_files(solution_dir, &keys));

    for file in files {
        let current = std::fs::read_to_string(&file).unwrap_or_default();
        let mut doc = EditorConfigDoc::parse(&current);
        if current.is_empty() {
            doc.ensure_root();
        }
        for setting in &ec_settings {
            let _ = doc.set_key(section, &setting.key, &setting.value);
        }
        let updated = doc.render();
        if updated != current {
            push_file_replace(&file, &current, updated, annotation_id, ops)?;
        }
    }
    Ok(())
}

/// Emit `Directory.Build.props` XML DOM edits for `MsBuildProperty` settings.
fn append_msbuild_ops(
    solution_dir: &Path,
    settings: &[&RuleSetting],
    vuln_config: Option<&VulnerabilityConfig>,
    annotation_id: &ChangeAnnotationIdentifier,
    ops: &mut Vec<DocumentChangeOperation>,
) -> Result<()> {
    let ms_settings: Vec<&RuleSetting> = settings
        .iter()
        .copied()
        .filter(|s| s.sink == RuleSink::MsBuildProperty)
        .collect();
    if ms_settings.is_empty() {
        return Ok(());
    }
    let props_path = solution_dir.join("Directory.Build.props");
    let current = std::fs::read_to_string(&props_path).unwrap_or_default();
    let mut updated = current.clone();
    for setting in ms_settings {
        let sep = match setting.key.as_str() {
            "WarningsAsErrors" => Some(';'),
            "OtherFlags" => Some(' '),
            _ => None,
        };
        let value = if setting.key == "WarningsAsErrors" && setting.value.starts_with("NU190") {
            vuln_config
                .map(|cfg| msbuild_props::error_mapped_nuget_codes(cfg).join(";"))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| setting.value.clone())
        } else {
            setting.value.clone()
        };
        updated = msbuild_props::set_property(&updated, &setting.key, &value, sep)?;
    }
    if updated != current {
        push_file_replace(&props_path, &current, updated, annotation_id, ops)?;
    }
    Ok(())
}

/// Emit `sharplsp.toml` edits for `SharpLspToml` settings.
fn append_toml_ops(
    solution_dir: &Path,
    settings: &[&RuleSetting],
    annotation_id: &ChangeAnnotationIdentifier,
    ops: &mut Vec<DocumentChangeOperation>,
) -> Result<()> {
    let toml_settings: Vec<&RuleSetting> = settings
        .iter()
        .copied()
        .filter(|s| s.sink == RuleSink::SharpLspToml)
        .collect();
    if toml_settings.is_empty() {
        return Ok(());
    }
    let toml_path = solution_dir.join("sharplsp.toml");
    let current = std::fs::read_to_string(&toml_path).unwrap_or_default();
    let mut table: toml::Table = if current.trim().is_empty() {
        toml::Table::new()
    } else {
        toml::from_str(&current)?
    };
    for setting in toml_settings {
        set_dotted_toml(&mut table, &setting.key, parse_toml_scalar(&setting.value));
    }
    let updated = toml::to_string_pretty(&table)?;
    if updated != current {
        push_file_replace(&toml_path, &current, updated, annotation_id, ops)?;
    }
    Ok(())
}

/// Convert a string setting value into a TOML boolean or string scalar.
fn parse_toml_scalar(raw: &str) -> toml::Value {
    match raw {
        "true" => toml::Value::Boolean(true),
        "false" => toml::Value::Boolean(false),
        other => toml::Value::String(other.to_string()),
    }
}

/// Set a dotted key path (`a.b.c`) inside a TOML table, creating subtables.
fn set_dotted_toml(root: &mut toml::Table, dotted_key: &str, value: toml::Value) {
    let parts: Vec<&str> = dotted_key.split('.').collect();
    let Some((last, parents)) = parts.split_last() else {
        return;
    };
    let mut cursor = root;
    for &part in parents {
        let entry = cursor
            .entry(part.to_string())
            .or_insert_with(|| toml::Value::Table(toml::Table::new()));
        if let toml::Value::Table(sub) = entry {
            cursor = sub;
        } else {
            return;
        }
    }
    let _ = cursor.insert((*last).to_string(), value);
}

/// Resolve and merge rule enforcement for `fix_key` anchored at `anchor_path`.
/// Returns an error if `fix_key` has no associated rule in [FIXALL-RULES-TABLE].
pub fn apply_enforcement_for_file(
    anchor_path: &str,
    fix_key: &str,
    scope: &str,
    title: &str,
    base: WorkspaceEdit,
) -> Result<WorkspaceEdit> {
    let assoc = super::rules_generated::find_association(fix_key)
        .ok_or_else(|| anyhow::anyhow!("this fix has no associated rule to enforce"))?;
    let dir = resolve_solution_dir(anchor_path);
    let annotated = annotate_scope_edit(base, scope, title);
    let extra = build_enforcement_edit(&dir, &assoc, None)?;
    Ok(merge_into_workspace_edit(annotated, extra))
}

/// Merge `enforcement` into a resolved code-fix `WorkspaceEdit`, converting
/// `changes` into `document_changes` so both code edits and enforcement edits
/// (with their own `ChangeAnnotation`) apply atomically. [FIXALL-ENFORCE]
pub fn merge_into_workspace_edit(base: WorkspaceEdit, enforcement: WorkspaceEdit) -> WorkspaceEdit {
    let mut ops = workspace_edit_ops(base.changes, base.document_changes);
    ops.extend(workspace_edit_ops(
        enforcement.changes,
        enforcement.document_changes,
    ));
    let mut annotations = base.change_annotations.unwrap_or_default();
    if let Some(extra) = enforcement.change_annotations {
        annotations.extend(extra);
    }
    WorkspaceEdit {
        changes: None,
        document_changes: Some(DocumentChanges::Operations(ops)),
        change_annotations: (!annotations.is_empty()).then_some(annotations),
    }
}

/// Flatten `changes` and `document_changes` into an ordered operation list.
fn workspace_edit_ops(
    changes: Option<HashMap<lsp_types::Uri, Vec<lsp_types::TextEdit>>>,
    doc_changes: Option<DocumentChanges>,
) -> Vec<DocumentChangeOperation> {
    let mut ops = match doc_changes {
        Some(DocumentChanges::Operations(existing)) => existing,
        Some(DocumentChanges::Edits(edits)) => edits
            .into_iter()
            .map(DocumentChangeOperation::Edit)
            .collect(),
        None => Vec::new(),
    };
    if let Some(map) = changes {
        for (uri, edits) in map {
            ops.push(DocumentChangeOperation::Edit(TextDocumentEdit {
                text_document: OptionalVersionedTextDocumentIdentifier { uri, version: None },
                edits: edits.into_iter().map(OneOf::Left).collect(),
            }));
        }
    }
    ops
}

/// Push a `CreateFile` (when absent) and whole-file annotated `TextDocumentEdit`.
fn push_file_replace(
    path: &Path,
    current: &str,
    updated: String,
    annotation_id: &ChangeAnnotationIdentifier,
    ops: &mut Vec<DocumentChangeOperation>,
) -> Result<()> {
    let uri = crate::paths::path_to_lsp_uri(&path.to_string_lossy())?;
    if !path.exists() {
        ops.push(DocumentChangeOperation::Op(ResourceOp::Create(
            CreateFile {
                uri: uri.clone(),
                options: Some(CreateFileOptions {
                    overwrite: Some(false),
                    ignore_if_exists: Some(true),
                }),
                annotation_id: Some(annotation_id.clone()),
            },
        )));
    }
    let end_line = u32::try_from(current.lines().count()).unwrap_or(u32::MAX);
    ops.push(DocumentChangeOperation::Edit(TextDocumentEdit {
        text_document: OptionalVersionedTextDocumentIdentifier { uri, version: None },
        edits: vec![OneOf::Right(AnnotatedTextEdit {
            text_edit: lsp_types::TextEdit {
                range: Range::new(Position::new(0, 0), Position::new(end_line + 1, 0)),
                new_text: updated,
            },
            annotation_id: annotation_id.clone(),
        })],
    }));
    Ok(())
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::panic,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;
    use crate::code_actions::rules_generated::find_association;

    #[test]
    fn enforces_ide0007_and_disables_ide0008_across_editorconfig_and_props() {
        let tmp = tempfile::tempdir().unwrap();
        let assoc = find_association("UseImplicitType").unwrap();
        let edit = build_enforcement_edit(tmp.path(), &assoc, None).unwrap();
        let Some(DocumentChanges::Operations(ops)) = edit.document_changes else {
            panic!("expected document_changes operations");
        };
        let texts: Vec<String> = ops
            .iter()
            .filter_map(|op| match op {
                DocumentChangeOperation::Edit(e) => match e.edits.first()? {
                    OneOf::Right(a) => Some(a.text_edit.new_text.clone()),
                    OneOf::Left(t) => Some(t.new_text.clone()),
                },
                DocumentChangeOperation::Op(_) => None,
            })
            .collect();
        assert!(texts
            .iter()
            .any(|t| t.contains("dotnet_diagnostic.IDE0007.severity = error")));
        assert!(texts
            .iter()
            .any(|t| t.contains("dotnet_diagnostic.IDE0008.severity = none")));
        assert!(texts
            .iter()
            .any(|t| t.contains("<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>")));
    }

    #[test]
    fn enforces_slspf0102_in_fsharp_section() {
        let tmp = tempfile::tempdir().unwrap();
        let assoc = find_association("SLSPF0102").unwrap();
        let edit = build_enforcement_edit(tmp.path(), &assoc, None).unwrap();
        let Some(DocumentChanges::Operations(ops)) = edit.document_changes else {
            panic!("expected document_changes operations");
        };
        let rendered = ops.iter().find_map(|op| match op {
            DocumentChangeOperation::Edit(e) => match e.edits.first()? {
                OneOf::Right(a) => Some(a.text_edit.new_text.clone()),
                OneOf::Left(t) => Some(t.new_text.clone()),
            },
            DocumentChangeOperation::Op(_) => None,
        });
        assert!(rendered
            .unwrap()
            .contains("[*.{fs,fsi,fsx}]\ndotnet_diagnostic.SLSPF0102.severity = error"));
    }

    #[test]
    fn nuget_enforce_in_build_writes_warnings_as_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = VulnerabilityConfig {
            enforce_in_build: true,
            ..VulnerabilityConfig::default()
        };
        let assoc = find_association("nuget.updateVulnerable").unwrap();
        let edit = build_enforcement_edit(tmp.path(), &assoc, Some(&cfg)).unwrap();
        let Some(DocumentChanges::Operations(ops)) = edit.document_changes else {
            panic!("expected operations");
        };
        assert!(
            ops.len() >= 2,
            "creates Directory.Build.props and writes WarningsAsErrors"
        );
    }
}
