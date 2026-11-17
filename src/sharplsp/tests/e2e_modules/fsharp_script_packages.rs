//! An F# script's `#r "nuget: …"` binds the package's symbols once FCS's
//! dependency manager has restored it, and a use the package does not declare
//! is still an error: the reference is real, not ignored. [SCRIPT-FSX-NUGET]

use super::navigation_latency::ask;
use super::*;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Run `dotnet` with `arguments` in `directory`, failing with its output.
fn dotnet(directory: &Path, arguments: &[&str]) {
    let output = Command::new("dotnet")
        .args(arguments)
        .current_dir(directory)
        .output()
        .expect("dotnet starts");
    assert!(
        output.status.success(),
        "dotnet {arguments:?}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Pack `ScriptDep` 1.2.3, declaring `Packed.Greeter.Greet`, into a folder
/// feed under `root`; returns the feed.
fn packed_feed(root: &Path) -> PathBuf {
    let (source, feed) = (root.join("source"), root.join("feed"));
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(
        source.join("ScriptDep.csproj"),
        "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    <TargetFramework>netstandard2.0</TargetFramework>\n    <PackageId>SharpLsp.ScriptDep</PackageId>\n    <PackageVersion>1.2.3</PackageVersion>\n  </PropertyGroup>\n</Project>\n",
    )
    .unwrap();
    std::fs::write(
        source.join("Greeter.cs"),
        "namespace Packed\n{\n    public static class Greeter\n    {\n        public static string Greet(string name) { return \"Hello \" + name; }\n    }\n}\n",
    )
    .unwrap();
    let output = feed.to_string_lossy().into_owned();
    dotnet(&source, &["pack", "--output", &output]);
    feed
}

/// The script: the feed as a source, the package, and one use of it on line 3.
fn script(feed: &Path, member: &str) -> String {
    // Forward slashes: the path sits in an F# string literal.
    let feed = feed.to_string_lossy().replace('\\', "/");
    format!(
        "#i \"nuget: {feed}\"\n#r \"nuget: SharpLsp.ScriptDep, 1.2.3\"\nopen Packed\nlet message = Greeter.{member} \"world\"\n"
    )
}

/// The codes of the script's current diagnostics, once the pull settles.
fn diagnostic_codes(client: &mut LspClient, uri: &str) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_mins(4);
    loop {
        let report = ask(client, "textDocument/diagnostic", uri, (0, 0));
        if let Some(items) = report["result"]["items"].as_array() {
            return items
                .iter()
                .filter_map(|item| item["code"].as_str().map(str::to_owned))
                .collect();
        }
        assert!(
            Instant::now() < deadline,
            "diagnostics never settled: {report}"
        );
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[test]
fn an_fsharp_script_binds_the_symbols_of_its_nuget_reference() {
    require_dotnet();
    let root = tempfile::tempdir().unwrap();
    let feed = packed_feed(root.path());
    let scripts = root.path().join("scripts");
    std::fs::create_dir_all(&scripts).unwrap();
    let path = scripts.join("Use.fsx");
    let text = script(&feed, "Greet");
    std::fs::write(&path, &text).unwrap();
    let uri = path_to_file_uri(&path);

    let mut client = LspClient::start_verbose();
    let pulls = json!({"textDocument": {"diagnostic": {}}});
    let _ = client.initialize_with_capabilities(json!(path_to_file_uri(&scripts)), pulls);
    client.open_document(&uri, &text);

    // 1. The package's method binds: its signature comes from the package.
    let deadline = Instant::now() + Duration::from_mins(4);
    let hovered = loop {
        let response = ask(&mut client, "textDocument/hover", &uri, (3, 24));
        assert_hover_ok(&response);
        if let Some(found) = response["result"]["contents"]["value"].as_str() {
            break found.to_owned();
        }
        assert!(Instant::now() < deadline, "the package never resolved");
        std::thread::sleep(Duration::from_millis(500));
    };
    assert!(hovered.contains("Greet"), "{hovered}");
    assert!(
        hovered.contains("string"),
        "the package's own signature: {hovered}"
    );
    let value = ask(&mut client, "textDocument/hover", &uri, (3, 6));
    let inferred = value["result"]["contents"]["value"]
        .as_str()
        .unwrap_or_default();
    assert!(
        inferred.contains("message") && inferred.contains("string"),
        "{inferred}"
    );
    assert_eq!(
        diagnostic_codes(&mut client, &uri),
        Vec::<String>::new(),
        "it compiles"
    );

    // 2. The namespace completes from the package too.
    let opened = ask(&mut client, "textDocument/hover", &uri, (2, 7));
    let namespace = opened["result"]["contents"]["value"]
        .as_str()
        .unwrap_or_default();
    assert!(namespace.contains("Packed"), "{namespace}");

    // 3. A member the package does not declare is an error: the reference is
    //    real, not an unchecked hole.
    client.change_document(&uri, 2, &script(&feed, "Shout"));
    let codes = diagnostic_codes(&mut client, &uri);
    assert!(
        codes.iter().any(|code| code == "FS0039"),
        "an undefined member: {codes:?}"
    );
    client.change_document(&uri, 3, &text);
    assert_eq!(
        diagnostic_codes(&mut client, &uri),
        Vec::<String>::new(),
        "and it compiles again"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
