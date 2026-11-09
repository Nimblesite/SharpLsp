//! Tests for `sharplsp/workspaceSymbols`. [SE-WORKSPACE-SYMBOLS-REQUEST] [SE-SYMBOL-KINDS]
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "test code — panics are the correct failure mode"
)]

use super::file_symbols::reparent_file_scoped_members;
use super::*;

fn make_symbol(name: &str, kind: &str) -> SymbolNode {
    SymbolNode {
        name: name.to_string(),
        kind: kind.to_string(),
        detail: None,
        access: None,
        range: SymbolRange {
            start: SymbolPosition {
                line: 0,
                character: 0,
            },
            end: SymbolPosition {
                line: 0,
                character: 0,
            },
        },
        selection_range: SymbolRange {
            start: SymbolPosition {
                line: 0,
                character: 0,
            },
            end: SymbolPosition {
                line: 0,
                character: 0,
            },
        },
        children: Vec::new(),
    }
}

// ── reparent_file_scoped_members ──

#[test]
fn reparent_no_namespace_returns_unchanged() {
    let symbols = vec![
        make_symbol("MyClass", "Class"),
        make_symbol("MyStruct", "Struct"),
    ];
    let result = reparent_file_scoped_members(symbols);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].name, "MyClass");
    assert_eq!(result[1].name, "MyStruct");
}

#[test]
fn reparent_namespace_with_existing_children_unchanged() {
    let mut ns = make_symbol("MyApp", "Namespace");
    ns.children.push(make_symbol("Existing", "Class"));

    let symbols = vec![ns, make_symbol("Orphan", "Class")];
    let result = reparent_file_scoped_members(symbols);
    // Namespace already has type children, so no reparenting.
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].name, "MyApp");
    assert_eq!(result[0].children.len(), 1);
    assert_eq!(result[1].name, "Orphan");
}

#[test]
fn reparent_file_scoped_namespace_adopts_orphans() {
    let ns = make_symbol("MyApp.Models", "Namespace");
    let class1 = make_symbol("User", "Class");
    let class2 = make_symbol("Order", "Class");

    let symbols = vec![ns, class1, class2];
    let result = reparent_file_scoped_members(symbols);

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].name, "MyApp.Models");
    assert_eq!(result[0].kind, "Namespace");
    assert_eq!(result[0].children.len(), 2);
    assert_eq!(result[0].children[0].name, "User");
    assert_eq!(result[0].children[1].name, "Order");
}

fn project(
    display_name: &str,
    path: &str,
    project_type: &str,
    parent_folder: Option<&str>,
    parent_folder_path: Option<&str>,
    order: usize,
) -> SolutionProjectEntry {
    SolutionProjectEntry {
        display_name: display_name.to_string(),
        path: path.to_string(),
        relative_path: path.to_string(),
        project_type: project_type.to_string(),
        identity: format!("id-{display_name}"),
        parent_folder: parent_folder.map(str::to_string),
        parent_folder_path: parent_folder_path.map(str::to_string),
        declaration_order: order,
    }
}

fn folder(
    name: &str,
    path: &str,
    parent_path: Option<&str>,
    parent_name: Option<&str>,
) -> SolutionFolderEntry {
    SolutionFolderEntry {
        name: name.to_string(),
        path: path.to_string(),
        identity: format!("guid-{name}"),
        parent_path: parent_path.map(str::to_string),
        parent_name: parent_name.map(str::to_string),
        declaration_order: 0,
    }
}

#[test]
fn model_projects_keeps_only_dotnet_projects_in_declaration_order() {
    let model = SolutionFileModel {
        path: "/s.sln".to_string(),
        format: "sln".to_string(),
        projects: vec![
            project("Web", "/Web/Web.csproj", "", None, None, 1),
            project("Native", "/Native/Native.vcxproj", "", None, None, 0),
            project("Lib", "/Lib/Lib.fsproj", "", None, None, 2),
        ],
        folders: vec![],
        files: vec![],
    };

    let projects = model_projects(&model);

    // The C++ project is filtered out; the rest keep declaration order.
    assert_eq!(projects.len(), 2);
    assert_eq!(projects[0].name, "Web");
    assert_eq!(projects[1].name, "Lib");
}

#[test]
fn project_name_falls_back_to_the_file_stem_when_display_name_is_empty() {
    let entry = project("", "/src/Calc/Calc.csproj", "", None, None, 0);
    assert_eq!(project_name(&entry), "Calc");
}

#[test]
fn parent_folder_name_resolves_via_folder_path() {
    let folders = vec![folder("src", "/src/", None, None)];
    let entry = project("App", "/App.csproj", "", None, Some("/src/"), 0);
    assert_eq!(
        parent_folder_name(&entry, &folders),
        Some("src".to_string())
    );
}

#[test]
fn model_folders_resolve_parent_identity_by_path_then_name() {
    let folders = vec![
        folder("root", "/root/", None, None),
        folder("child", "/root/child/", Some("/root/"), None),
        folder("byname", "/x/", None, Some("root")),
    ];

    let nodes = model_folders(&folders);

    let child = nodes.iter().find(|n| n.name == "child").unwrap();
    assert_eq!(child.parent_guid, Some("guid-root".to_string()));
    let byname = nodes.iter().find(|n| n.name == "byname").unwrap();
    assert_eq!(byname.parent_guid, Some("guid-root".to_string()));
    let root = nodes.iter().find(|n| n.name == "root").unwrap();
    assert_eq!(root.parent_guid, None);
}

#[test]
fn solution_item_count_ignores_fully_empty_entries() {
    let files = vec![
        SolutionItemEntry {
            path: "/readme.md".to_string(),
            relative_path: "readme.md".to_string(),
            parent_folder: None,
            parent_folder_path: None,
            declaration_order: 0,
        },
        SolutionItemEntry {
            path: String::new(),
            relative_path: String::new(),
            parent_folder: None,
            parent_folder_path: None,
            declaration_order: 0,
        },
    ];

    assert_eq!(solution_item_count(&files), 1);
}

#[test]
fn is_dotnet_project_detects_by_path_and_by_type_marker() {
    assert!(is_dotnet_project(&project(
        "A",
        "/A.csproj",
        "",
        None,
        None,
        0
    )));
    assert!(is_dotnet_project(&project(
        "B",
        "/B.fsproj",
        "",
        None,
        None,
        0
    )));
    assert!(is_dotnet_project(&project(
        "C",
        "/C.unknown",
        ".csproj",
        None,
        None,
        0
    )));
    assert!(!is_dotnet_project(&project(
        "D",
        "/D.vcxproj",
        "native",
        None,
        None,
        0
    )));
}
