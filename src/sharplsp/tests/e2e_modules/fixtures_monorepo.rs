//! Real monorepo fixtures for standalone-project loading (#575): .NET projects
//! nested beside non-.NET folders, with no solution or beside one that excludes
//! them. Implements [SHARPLSP-ARCHITECTURE-PROJECTS-DISCOVERY].
use super::*;
use workspace_diagnostic_support::assert_build;

/// C# `Program.cs` of the solutionless monorepo's CMS app.
pub const MONOREPO_PROGRAM_CS: &str = r"namespace Cms.App;

/// Totals a shopping cart for the CMS.
public class CmsCalculator
{
    public int Add(int a, int b) => a + b;

    public int Twice(int x) => Add(x, x);
}
";

/// F# `Reports.fs` of the solutionless monorepo's reports app.
pub const MONOREPO_REPORTS_FS: &str = r"module App.Reports

/// One billed line of a generated report.
type ReportLine = { Title: string; Amount: decimal }

/// Sum of every line's amount.
let total (lines: ReportLine list) : decimal =
    lines |> List.sumBy (fun line -> line.Amount)
";

/// Clean source of the library project the excluding solution lists.
pub const EXCLUDED_LIB_CS: &str = r#"namespace Mono.Lib;

/// Anchor type of the listed library project.
public class LibraryAnchor
{
    public string Name { get; set; } = "lib";
}
"#;

/// Complete C# source with one compiler-confirmed CS0029 error on line 2.
pub const EXCLUDED_TOOL_CS: &str = r#"namespace App.Tool;
public static class ToolBreak {
    public static int Value => "oops";
}
"#;

/// Complete F# source with one compiler-confirmed FS0001 error on line 2.
pub const EXCLUDED_STATS_FS: &str = "module App.Stats\n\nlet value: int = \"oops\"\n";

/// A restored monorepo-style workspace whose .NET projects sit nested beside
/// non-.NET folders. Keep the struct alive for the duration of the test —
/// dropping it deletes the temp directory.
pub struct MonorepoWorkspace {
    /// Owns the temp directory backing the workspace.
    pub tmp: tempfile::TempDir,
    /// Canonicalized workspace root.
    pub root: PathBuf,
}

impl MonorepoWorkspace {
    pub fn root_uri(&self) -> String {
        path_to_file_uri(&self.root)
    }

    pub fn cms_program_path(&self) -> PathBuf {
        self.root.join("apps/cms/App/Program.cs")
    }

    pub fn reports_path(&self) -> PathBuf {
        self.root.join("apps/reports/Reports.fs")
    }

    pub fn entities_path(&self) -> PathBuf {
        self.root.join("Lib/Entities.cs")
    }

    pub fn tool_path(&self) -> PathBuf {
        self.root.join("apps/tool/Tool.cs")
    }

    pub fn stats_path(&self) -> PathBuf {
        self.root.join("apps/stats/Stats.fs")
    }
}

/// An SDK C# library project: sources glob from the project directory.
fn csharp_library_project() -> &'static str {
    r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>"#
}

/// An SDK F# library project compiling `source` explicitly, in order.
fn fsharp_library_project(source: &str) -> String {
    format!(
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="{source}" />
  </ItemGroup>
</Project>"#
    )
}

/// The issue #575 layout: a JS-rooted monorepo whose only .NET projects live
/// nested under `apps/`, with no `.sln`/`.slnx` anywhere. Build output and
/// package copies of the project sit beside the real one: discovery must skip
/// them, not count them. Both projects are restored and compiler-confirmed.
pub fn create_monorepo_without_solution() -> MonorepoWorkspace {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::write(
        root.join("package.json"),
        r#"{"name":"repo","private":true}"#,
    )
    .unwrap();
    let web = root.join("apps/web");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(web.join("index.html"), "<html><body>web app</body></html>").unwrap();

    let cms = root.join("apps/cms/App");
    std::fs::create_dir_all(cms.join("bin/Debug")).unwrap();
    std::fs::write(cms.join("App.csproj"), csharp_library_project()).unwrap();
    std::fs::write(cms.join("Program.cs"), MONOREPO_PROGRAM_CS).unwrap();
    // A stale copy under bin/ and one inside node_modules must never be
    // discovered as a second project. [SHARPLSP-ARCHITECTURE-PROJECTS-DISCOVERY]
    std::fs::write(
        cms.join("bin/Debug/App copy.csproj"),
        csharp_library_project(),
    )
    .unwrap();
    let pkg = root.join("node_modules/pkg");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(pkg.join("Pkg.csproj"), csharp_library_project()).unwrap();

    let reports = root.join("apps/reports");
    std::fs::create_dir_all(&reports).unwrap();
    std::fs::write(
        reports.join("Reports.fsproj"),
        fsharp_library_project("Reports.fs"),
    )
    .unwrap();
    std::fs::write(reports.join("Reports.fs"), MONOREPO_REPORTS_FS).unwrap();

    restore_project(&cms);
    restore_project(&reports);
    assert_build(&cms.join("App.csproj"), None);
    assert_build(&reports.join("Reports.fsproj"), None);

    let root = std::fs::canonicalize(root).unwrap();
    MonorepoWorkspace { tmp, root }
}

/// A monorepo whose root solution lists only `Lib/Lib.csproj`: the C# `Tool`
/// and F# `Stats` projects are not referenced by it and must still load. The
/// excluded projects carry one compiler-confirmed error each on line 2, so a
/// closed-file workspace diagnostic proves their loading without opening any
/// of their files. Implements [SHARPLSP-ARCHITECTURE-PROJECTS-DISCOVERY].
pub fn create_monorepo_with_excluding_solution() -> MonorepoWorkspace {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    let lib = root.join("Lib");
    std::fs::create_dir_all(&lib).unwrap();
    std::fs::write(lib.join("Lib.csproj"), csharp_library_project()).unwrap();
    std::fs::write(lib.join("Entities.cs"), EXCLUDED_LIB_CS).unwrap();

    let tool = root.join("apps/tool");
    std::fs::create_dir_all(&tool).unwrap();
    std::fs::write(tool.join("Tool.csproj"), csharp_library_project()).unwrap();
    std::fs::write(tool.join("Tool.cs"), EXCLUDED_TOOL_CS).unwrap();
    let stats = root.join("apps/stats");
    std::fs::create_dir_all(&stats).unwrap();
    std::fs::write(
        stats.join("Stats.fsproj"),
        fsharp_library_project("Stats.fs"),
    )
    .unwrap();
    std::fs::write(stats.join("Stats.fs"), EXCLUDED_STATS_FS).unwrap();

    std::fs::write(
        root.join("Main.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Lib", "Lib/Lib.csproj", "{70000000-0000-0000-0000-000000000001}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    restore_project(&lib);
    restore_project(&tool);
    restore_project(&stats);
    assert_build(&lib.join("Lib.csproj"), None);
    assert_build(&tool.join("Tool.csproj"), Some("CS0029"));
    assert_build(&stats.join("Stats.fsproj"), Some("FS0001"));

    let root = std::fs::canonicalize(root).unwrap();
    MonorepoWorkspace { tmp, root }
}

/// Complete F# build output with one compiler-confirmed FS0001 error on line 2.
pub const GENERATED_FS: &str = "module App.Generated\n\nlet generated: int = \"oops\"\n";

/// Run `git` in `dir`, which the owned-sources fixture needs to be a real repository.
fn git(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .status()
        .expect("git must start");
    assert!(
        status.success(),
        "git {args:?} must succeed in {}",
        dir.display()
    );
}

/// A real git repository shaped like this one ([DIAG-CONFIG-OWNED-SOURCES]): the
/// developer's F# `Stats` project also compiles a generated file under `obj/`,
/// and a gitignored `vendor/` holds a cloned F# project and a C# one. Every
/// source carries a compiler error, so anything listed is unmistakable.
pub fn create_repository_with_unowned_sources() -> MonorepoWorkspace {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let stats = root.join("apps/stats");
    std::fs::create_dir_all(stats.join("obj")).unwrap();
    let project = fsharp_library_project("Stats.fs").replace(
        "<Compile Include=\"Stats.fs\" />",
        "<Compile Include=\"obj/Generated.fs\" />\n    <Compile Include=\"Stats.fs\" />",
    );
    std::fs::write(stats.join("Stats.fsproj"), project).unwrap();
    std::fs::write(stats.join("Stats.fs"), EXCLUDED_STATS_FS).unwrap();
    std::fs::write(stats.join("obj/Generated.fs"), GENERATED_FS).unwrap();

    let clone = root.join("vendor/clone");
    std::fs::create_dir_all(&clone).unwrap();
    std::fs::write(
        clone.join("Clone.fsproj"),
        fsharp_library_project("Clone.fs"),
    )
    .unwrap();
    std::fs::write(clone.join("Clone.fs"), EXCLUDED_STATS_FS).unwrap();
    let tool = root.join("vendor/tool");
    std::fs::create_dir_all(&tool).unwrap();
    std::fs::write(tool.join("Tool.csproj"), csharp_library_project()).unwrap();
    std::fs::write(tool.join("Tool.cs"), EXCLUDED_TOOL_CS).unwrap();

    std::fs::write(root.join(".gitignore"), "vendor/\n").unwrap();
    git(root, &["init", "-q"]);
    // The vendored F# project is its own clone, as a gitignored checkout is.
    git(&clone, &["init", "-q"]);
    restore_project(&stats);
    restore_project(&clone);
    restore_project(&tool);

    let root = std::fs::canonicalize(root).unwrap();
    MonorepoWorkspace { tmp, root }
}
