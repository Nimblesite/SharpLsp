//! A configured solution is what both compilers open: the F# compiler loads
//! its projects and never every project under the folder, so a project
//! outside it is not restored or loaded. Implements [PERF-PROGRESSIVE-LOAD]
//! and [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH] (GitHub #563).

use super::fixall_fsharp_tests::write_project;
use super::workspace_diagnostic_protocol::recovery::{owned_apphosts, published_apphost_uri};
use super::*;

/// How long a cold compiler may take to answer.
const COLD: Duration = Duration::from_mins(3);

/// One module declaring `value`, on its second line.
fn module(name: &str) -> String {
    format!("module {name}\nlet value = 42\n")
}

/// How many compilers the host started from the apphost `key` names.
fn running(client: &LspClient, key: &str) -> usize {
    owned_apphosts(client, &published_apphost_uri(key, key)).len()
}

/// Open `project`'s source in `root` and wait for the compiler's hover of `value`.
fn hover_of_value(client: &mut LspClient, root: &Path, project: &str) -> String {
    let path = root.join(project).join("Library.fs");
    let uri = path_to_file_uri(&path);
    client.open_document(&uri, &module(project));
    let hovered = poll_hover_until_ready(client, &uri, 1, 5, COLD);
    hovered["contents"]["value"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn a_configured_solution_is_the_only_thing_the_fsharp_compiler_opens() {
    require_dotnet();
    let dir = tempfile::tempdir().expect("a folder with a solution and projects beside it");
    let root = std::fs::canonicalize(dir.path()).expect("canonical folder");
    for project in ["Inside", "Beside", "Untouched"] {
        write_project(&root, project, &[("Library.fs", module(project))], &[]);
    }
    let listed = "<Solution>\n  <Project Path=\"Inside/Inside.fsproj\" />\n</Solution>\n";
    std::fs::write(root.join("Chosen.slnx"), listed).expect("write the solution");
    std::fs::write(root.join("Other.slnx"), "<Solution />\n").expect("write another solution");
    let settings = "[csharp]\nsolution_path = \"Chosen.slnx\"\n";
    std::fs::write(root.join("sharplsp.toml"), settings).expect("write the settings");
    let restored = |project: &str| root.join(project).join("obj/project.assets.json").exists();

    let mut client = LspClient::spawn_in(Stdio::null(), Some(&root));
    let initialized = client.initialize_with_root(json!(path_to_file_uri(&root)));
    assert_rpc_ok(&initialized, "initialize on the folder");

    // 1. The solution's project answers, and only it was restored.
    let inside = hover_of_value(&mut client, &root, "Inside");
    assert!(
        inside.contains("value") && inside.contains("int"),
        "{inside}"
    );
    assert!(
        restored("Inside"),
        "the configured solution's project is restored"
    );
    assert!(!restored("Beside"), "a project beside the solution is not");
    assert!(!restored("Untouched"), "nor is any other");
    assert_eq!(
        running(&client, "SHARPLSP_FSHARP_SIDECAR_PATH"),
        1,
        "one FCS"
    );

    // 2. Opening a file of a project outside the solution does not make the
    //    compiler restore it, and the solution's project still answers.
    let beside = root.join("Beside").join("Library.fs");
    client.open_document(&path_to_file_uri(&beside), &module("Beside"));
    let again = hover_of_value(&mut client, &root, "Inside");
    assert!(
        again.contains("value"),
        "the solution still answers: {again}"
    );
    assert!(!restored("Beside"), "opening its file restores nothing");
    assert!(!restored("Untouched"), "and the rest stays untouched");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
