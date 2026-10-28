use super::*;

use super::workspace_symbols::initialize_workspace_symbols_client;

// ── An F# project whose sources live outside its folder (#493) ────
//
// The reporter's RimWorld mod template keeps `.vscode/mod.fsproj` and compiles
// `../Source/<Name>/*.fs` with `EnableDefaultCompileItems` off. The Solution
// Explorer walked only the project's own folder, so the project listed nothing.
// An F# project's sources are its evaluated Compile items, in compile order,
// wherever they sit. `[SE-FSHARP-SYMBOLS]` `[SE-ADD-FILE-COMMAND]`

const LINKED_FSPROJ: &str = r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="../Source/Linked/Domain.fs" />
    <Compile Include="../Source/Linked/Main.fs" />
  </ItemGroup>
</Project>
"#;

/// `.vscode/mod.fsproj`, `Source/Linked/{Domain,Main}.fs` and `mod.slnx`.
fn create_linked_template() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let sources = root.join("Source").join("Linked");
    std::fs::create_dir_all(&sources).unwrap();
    std::fs::create_dir_all(root.join(".vscode")).unwrap();
    std::fs::write(
        sources.join("Domain.fs"),
        "module Domain\n\nlet answer = 42\n",
    )
    .unwrap();
    std::fs::write(
        sources.join("Main.fs"),
        "module Main\n\nlet twice x = x * 2\n",
    )
    .unwrap();
    let fsproj = root.join(".vscode").join("mod.fsproj");
    std::fs::write(&fsproj, LINKED_FSPROJ).unwrap();
    let slnx = "<Solution>\n  <Project Path=\".vscode/mod.fsproj\" />\n</Solution>\n";
    std::fs::write(root.join("mod.slnx"), slnx).unwrap();
    (tmp, fsproj)
}

/// Poll `sharplsp/workspaceSymbols` until the `mod` project lists two files.
fn linked_project_files(client: &mut LspClient, slnx: &str) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let resp = client.request("sharplsp/workspaceSymbols", json!({ "solution": slnx }));
        assert!(resp.get("error").is_none(), "must not error: {resp}");
        let files = resp["result"]["projects"]
            .as_array()
            .and_then(|projects| projects.iter().find(|p| p["name"] == "mod"))
            .and_then(|project| project["symbols"].as_array().cloned())
            .unwrap_or_default();
        if files.len() == 2 {
            return files;
        }
        assert!(
            Instant::now() < deadline,
            "mod.fsproj must list its two Compile items from ../Source, got: {resp}"
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Every symbol name in `file`, recursively.
fn names_in(file: &Value) -> Vec<String> {
    let mut names = Vec::new();
    let mut stack: Vec<&Value> = file["symbols"].as_array().unwrap().iter().collect();
    while let Some(symbol) = stack.pop() {
        names.push(symbol["name"].as_str().unwrap_or_default().to_string());
        stack.extend(symbol["children"].as_array().into_iter().flatten());
    }
    names
}

#[test]
fn linked_compile_items_are_the_projects_files_in_compile_order() {
    require_dotnet();
    let (tmp, _fsproj) = create_linked_template();
    let slnx = tmp.path().canonicalize().unwrap().join("mod.slnx");
    let mut client = LspClient::start_verbose();
    initialize_workspace_symbols_client(&mut client, &tmp);

    let files = linked_project_files(&mut client, &slnx.to_string_lossy());
    let paths: Vec<&str> = files.iter().map(|f| f["file"].as_str().unwrap()).collect();
    let linked = |name: &str| Path::new("Source").join("Linked").join(name);
    assert!(
        Path::new(paths[0]).ends_with(linked("Domain.fs")),
        "Domain.fs first: {paths:?}"
    );
    assert!(
        Path::new(paths[1]).ends_with(linked("Main.fs")),
        "then Main.fs: {paths:?}"
    );
    assert!(
        !paths.iter().any(|p| p.contains(".vscode")),
        "nothing beside the fsproj: {paths:?}"
    );
    for (file, expected) in files.iter().zip([["Domain", "answer"], ["Main", "twice"]]) {
        let names = names_in(file);
        for name in expected {
            assert!(
                names.iter().any(|n| n == name),
                "FCS names `{name}`: {names:?}"
            );
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn compile_items_answers_full_paths_in_order_and_names_a_bad_project() {
    require_dotnet();
    let (tmp, fsproj) = create_linked_template();
    let mut client = LspClient::start_verbose();
    initialize_workspace_symbols_client(&mut client, &tmp);

    let params = json!({ "projectPath": fsproj.to_string_lossy() });
    let resp = client.request("sharplsp/project/compileItems", params);
    assert!(resp.get("error").is_none(), "must answer: {resp}");
    let items: Vec<PathBuf> = resp["result"]["items"]
        .as_array()
        .expect("an items array")
        .iter()
        .map(|item| PathBuf::from(item.as_str().unwrap()))
        .collect();
    let sources = tmp
        .path()
        .canonicalize()
        .unwrap()
        .join("Source")
        .join("Linked");
    assert_eq!(
        items,
        vec![sources.join("Domain.fs"), sources.join("Main.fs")],
        "resolved, in order"
    );
    assert!(
        items.iter().all(|item| item.is_absolute()),
        "full paths: {items:?}"
    );

    let missing = tmp.path().join("Missing.fsproj");
    let resp = client.request(
        "sharplsp/project/compileItems",
        json!({ "projectPath": missing.to_string_lossy() }),
    );
    assert!(
        resp.get("error").is_some(),
        "a project MSBuild cannot evaluate is an error: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
