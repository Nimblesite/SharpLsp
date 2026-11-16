//! Every row of the [SCRIPT-DETECT] table and every stop of the [SCRIPT-CONE]
//! walk, on real directories.
#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]

use std::path::{Path, PathBuf};

use super::{DocumentKind, Engine};
use crate::paths::{cone_owner, directory_of};

/// Create `relative` under `root`, with its directories, and return its path.
fn touch(root: &Path, relative: &str) -> PathBuf {
    let path = root.join(relative);
    let parent = directory_of(&path).unwrap_or_default();
    assert!(std::fs::create_dir_all(parent).is_ok(), "create {relative}");
    assert!(std::fs::write(&path, "").is_ok(), "write {relative}");
    path
}

/// A repository root: nothing above it can own what is beneath it.
fn repository() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    let _git = touch(&root, ".git/HEAD");
    (dir, root)
}

#[test]
fn every_document_resolves_to_exactly_one_kind() {
    let (_dir, root) = repository();
    let _project = touch(&root, "app/App.csproj");
    let _fsharp = touch(&root, "lib/Lib.fsproj");
    let kind = |relative: &str| DocumentKind::of(&touch(&root, relative), None);

    // Inside a cone the project wins, whatever the folder depth.
    let roslyn_owned = DocumentKind::ProjectOwned(Engine::CSharp);
    let fcs_owned = DocumentKind::ProjectOwned(Engine::FSharp);
    assert_eq!(kind("app/Program.cs"), roslyn_owned);
    assert_eq!(kind("app/Models/Deep/Thing.cs"), roslyn_owned);
    assert_eq!(kind("lib/Library.fs"), fcs_owned);
    assert_eq!(kind("lib/Library.fsi"), fcs_owned, "a project's signature");
    assert_eq!(roslyn_owned.engine(), Some(Engine::CSharp));
    assert_eq!(fcs_owned.engine(), Some(Engine::FSharp));

    // Scripts are never project-owned: MSBuild does not compile them.
    assert_eq!(kind("app/build.csx"), DocumentKind::CSharpScript);
    assert_eq!(kind("lib/build.fsx"), DocumentKind::FSharpScript);
    assert_eq!(kind("lib/tool.fsscript"), DocumentKind::FSharpScript);
    assert_eq!(
        kind("lib/UPPER.FSX"),
        DocumentKind::FSharpScript,
        "any casing"
    );

    // Outside every cone the extension alone decides.
    assert_eq!(kind("loose/hello.cs"), DocumentKind::CSharpFileBasedApp);
    assert_eq!(kind("loose/hello.csx"), DocumentKind::CSharpScript);
    assert_eq!(kind("loose/hello.fs"), DocumentKind::FSharpLooseSource);
    assert_eq!(kind("loose/hello.fsi"), DocumentKind::FSharpSignature);
    assert_eq!(kind("loose/README.md"), DocumentKind::Unsupported);
    assert_eq!(kind("app/appsettings.json"), DocumentKind::Unsupported);
    assert_eq!(kind("loose/Makefile"), DocumentKind::Unsupported);

    // Only kinds a compiler reads open a workspace. [SCRIPT-ROUTE-LAZY]
    assert_eq!(
        DocumentKind::CSharpFileBasedApp.engine(),
        Some(Engine::CSharp)
    );
    assert_eq!(DocumentKind::CSharpScript.engine(), Some(Engine::CSharp));
    assert_eq!(DocumentKind::FSharpScript.engine(), Some(Engine::FSharp));
    assert_eq!(
        DocumentKind::FSharpLooseSource.engine(),
        Some(Engine::FSharp)
    );
    assert_eq!(DocumentKind::FSharpSignature.engine(), None, "syntax-only");
    assert_eq!(DocumentKind::Unsupported.engine(), None);
}

#[test]
fn the_cone_walk_stops_at_each_of_its_four_boundaries() {
    let (dir, root) = repository();

    // 1. The first directory holding a project or solution wins: the nearest,
    //    for each of the four owner files.
    for (owner, document) in [
        ("a/A.csproj", "a/src/x/File.cs"),
        ("b/B.fsproj", "b/File.fs"),
        ("c/C.sln", "c/one/two/three/File.cs"),
        ("d/D.slnx", "d/File.cs"),
    ] {
        let owner = touch(&root, owner);
        let found = cone_owner(&touch(&root, document), None);
        assert_eq!(found, directory_of(&owner), "{document}");
    }
    let _outer = touch(&root, "nest/Outer.sln");
    let inner = touch(&root, "nest/inner/Inner.csproj");
    let nested = cone_owner(&touch(&root, "nest/inner/deep/File.cs"), None);
    assert_eq!(nested, directory_of(&inner), "the nearest owner wins");

    // 2. A directory holding `.git` ends the walk: a project above the
    //    repository does not own what is inside it.
    let _above = touch(dir.path(), "Above.sln");
    let loose = touch(&root, "scripts/tools/File.cs");
    assert_eq!(cone_owner(&loose, None), None, "stopped at the repository");
    let unfenced = touch(dir.path(), "plain/File.cs");
    assert_eq!(
        cone_owner(&unfenced, None).as_deref(),
        Some(dir.path()),
        "with no boundary between them the project above owns it"
    );

    // 3. The workspace root ends the walk the same way, and a project in the
    //    root itself still wins.
    let workspace = dir.path().join("plain");
    assert_eq!(cone_owner(&unfenced, Some(&workspace)), None);
    let _rooted = touch(&workspace, "Rooted.csproj");
    assert_eq!(
        cone_owner(&unfenced, Some(&workspace)).as_deref(),
        Some(workspace.as_path())
    );

    // 4. A project beside `.git` wins over the boundary it shares a directory
    //    with, and a document with no directory has no cone.
    let _root_project = touch(&root, "Root.csproj");
    assert_eq!(cone_owner(&loose, None).as_deref(), Some(root.as_path()));
    assert_eq!(cone_owner(Path::new("File.cs"), None), None);
}
