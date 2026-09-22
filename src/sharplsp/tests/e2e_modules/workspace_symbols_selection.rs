use super::workspace_symbols::initialize_workspace_symbols_client;
use super::*;

// ── Workspace Symbols: declarations, for Go to Test ──────────────
//
// Implements [TEST-GOTO-SOURCE] and [SE-WORKSPACE-SYMBOLS-REQUEST]: a test's
// Go to Test reveal lands on the DECLARATION, which for an attributed member is
// not where its syntax node starts. `range` spans the attributes;
// `selectionRange` is the declared name. The extension rebuilds each test's
// runtime name from this tree, so the F# shapes it relies on are pinned here.

/// C# with an attribute on the line above the method it decorates.
const CS_SOURCE: &str = "namespace Goto.Cs;\n\
public class NavigationTests\n\
{\n    [System.Obsolete]\n    public void Navigates() { }\n}\n";

/// An F# top-level module holding a binding, a type and nested modules.
const FS_MODULE_SOURCE: &str = r"module Goto.Fs.Fixtures

[<System.Obsolete>]
let ``navigates to the test`` () = 3

type CalculatorTests() =
    member _.AddsTwoNumbers() = 3

module Inner =
    let nested () = 4
    module Deeper =
        let deepest () = 5
";

/// An F# namespace holding a module and a type.
const FS_NAMESPACE_SOURCE: &str = r"namespace Goto.Ns

module Tests =
    let t () = 1

type T() =
    member _.M() = 2
";

const SDK: &str = r#"<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>"#;

/// Write `path` under `root`, creating its directory.
fn write(root: &Path, path: &str, text: &str) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// A solution with one attributed C# project and one F# project.
fn create_selection_fixture() -> (tempfile::TempDir, String) {
    let tmp = tempfile::tempdir().unwrap();
    write(
        tmp.path(),
        "GotoCs/GotoCs.csproj",
        &format!("{SDK}</Project>"),
    );
    write(tmp.path(), "GotoCs/Tests.cs", CS_SOURCE);
    let compile =
        r#"<ItemGroup><Compile Include="Ns.fs" /><Compile Include="Tests.fs" /></ItemGroup>"#;
    write(
        tmp.path(),
        "GotoFs/GotoFs.fsproj",
        &format!("{SDK}{compile}</Project>"),
    );
    write(tmp.path(), "GotoFs/Ns.fs", FS_NAMESPACE_SOURCE);
    write(tmp.path(), "GotoFs/Tests.fs", FS_MODULE_SOURCE);
    write(
        tmp.path(),
        "Goto.slnx",
        r#"<Solution><Project Path="GotoCs/GotoCs.csproj" /><Project Path="GotoFs/GotoFs.fsproj" /></Solution>"#,
    );
    let sln = tmp.path().canonicalize().unwrap().join("Goto.slnx");
    (tmp, sln.to_string_lossy().to_string())
}

/// The first symbol named `name`, depth-first.
fn find_named<'a>(symbols: &'a [Value], name: &str) -> Option<&'a Value> {
    symbols.iter().find_map(|symbol| {
        if symbol["name"] == name {
            return Some(symbol);
        }
        find_named(symbol["children"].as_array()?, name)
    })
}

/// The projects `target` resolves to, once `project` reports symbols (the F#
/// sidecar loads lazily).
fn resolve(client: &mut LspClient, target: &str, project: &str) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let response = client.request("sharplsp/workspaceSymbols", json!({ "solution": target }));
        assert!(
            response.get("error").is_none(),
            "must not error: {response}"
        );
        let projects = response["result"]["projects"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let ready = projects
            .iter()
            .find(|p| p["name"] == project)
            .and_then(|p| p["symbols"].as_array())
            .is_some_and(|files| !files.is_empty());
        if ready {
            return projects;
        }
        assert!(
            Instant::now() < deadline,
            "{project} never reported symbols: {response}"
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Every top-level symbol `project` reports, across its files.
fn project_symbols(projects: &[Value], project: &str) -> Vec<Value> {
    projects
        .iter()
        .find(|p| p["name"] == project)
        .and_then(|p| p["symbols"].as_array())
        .into_iter()
        .flatten()
        .flat_map(|file| file["symbols"].as_array().cloned().unwrap_or_default())
        .collect()
}

/// `symbol`'s `field` start line.
fn start_line(symbol: &Value, field: &str) -> u64 {
    symbol[field]["start"]["line"].as_u64().unwrap()
}

#[test]
fn test_workspace_symbols_selection_range_is_the_declared_name() {
    require_dotnet();
    let (tmp, sln) = create_selection_fixture();
    let mut client = LspClient::start_verbose();
    initialize_workspace_symbols_client(&mut client, &tmp);

    // C#: the method node starts on its `[System.Obsolete]` line (3); its name is on line 4.
    let projects = resolve(&mut client, &sln, "GotoFs");
    let cs = project_symbols(&projects, "GotoCs");
    let method = find_named(&cs, "Navigates").expect("C# method must be listed");
    assert_eq!(
        start_line(method, "range"),
        3,
        "range spans the attribute: {method}"
    );
    assert_eq!(
        start_line(method, "selectionRange"),
        4,
        "selection is the name: {method}"
    );
    assert_eq!(
        method["selectionRange"]["start"]["character"], 16,
        "{method}"
    );
    assert_eq!(method["selectionRange"]["end"]["character"], 25, "{method}");
    let class = find_named(&cs, "NavigationTests").expect("C# class must be listed");
    assert_eq!(start_line(class, "selectionRange"), 1, "{class}");

    // F#: the binding's name is on line 3, under its attribute on line 2.
    let fs = project_symbols(&projects, "GotoFs");
    let binding = find_named(&fs, "navigates to the test").expect("F# binding must be listed");
    assert_eq!(
        start_line(binding, "selectionRange"),
        3,
        "selection is the name: {binding}"
    );
    assert!(start_line(binding, "range") <= start_line(binding, "selectionRange"));

    // The F# shapes a runtime name is rebuilt from: a namespace is not a module,
    // and declarations nested in a module are listed flat, named relative to it.
    let kind_of = |name: &str| find_named(&fs, name).map(|symbol| symbol["kind"].clone());
    assert_eq!(kind_of("Goto.Ns"), Some(json!("Namespace")), "{fs:?}");
    assert_eq!(kind_of("Goto.Fs.Fixtures"), Some(json!("Module")), "{fs:?}");
    assert_eq!(kind_of("CalculatorTests"), Some(json!("Class")), "{fs:?}");
    assert_eq!(kind_of("Inner.Deeper"), Some(json!("Module")), "{fs:?}");
    let deeper = find_named(&fs, "Inner.Deeper").unwrap();
    assert_eq!(start_line(deeper, "selectionRange"), 10, "{deeper}");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_workspace_symbols_resolves_a_project_or_a_folder_without_a_solution() {
    require_dotnet();
    let (tmp, _sln) = create_selection_fixture();
    let mut client = LspClient::start_verbose();
    initialize_workspace_symbols_client(&mut client, &tmp);
    let root = tmp.path().canonicalize().unwrap();

    // A folder stands for every project under it; there are no solution folders.
    let folder = root.to_string_lossy().to_string();
    let projects = resolve(&mut client, &folder, "GotoFs");
    let names: Vec<&str> = projects.iter().filter_map(|p| p["name"].as_str()).collect();
    assert_eq!(
        names,
        ["GotoCs", "GotoFs"],
        "both projects, in path order: {projects:?}"
    );
    assert!(find_named(&project_symbols(&projects, "GotoCs"), "Navigates").is_some());

    // A project file stands for itself.
    let fsproj = root
        .join("GotoFs/GotoFs.fsproj")
        .to_string_lossy()
        .to_string();
    let single = resolve(&mut client, &fsproj, "GotoFs");
    assert_eq!(single.len(), 1, "one project: {single:?}");
    assert!(find_named(&project_symbols(&single, "GotoFs"), "Inner.Deeper").is_some());

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
