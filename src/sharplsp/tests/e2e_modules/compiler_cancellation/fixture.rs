//! Real SDK inputs and a cooperative project analyzer. [DIAG-ANALYSIS-CANCELLATION]
use super::*;
use workspace_diagnostic_support::assert_build;

pub const OLD_CS: &str = "namespace CancellationInput;\n\npublic static class Library { public static int Value => missing; }\n";
pub const CURRENT_CS: &str = "namespace CancellationInput;\n\npublic static class Library { public static string Value => 42; }\n";
pub const CLEAN_CS: &str = "namespace CancellationInput;\n\npublic static class Library { public static int Value => 42; }\n";
pub const OLD_FS: &str = "module CancellationInput.Library\n\nlet value: int = \"broken\"\n";
pub const CURRENT_FS: &str = "module CancellationInput.Library\n\nlet value: int = missing\n";
pub const CLEAN_FS: &str = "module CancellationInput.Library\n\nlet value: int = 42\n";
const OTHER_FS: &str = "module CancellationInput.Other\n\nlet value = 42\n";
const OTHER_CS: &str = "namespace CancellationInput;\n\npublic static class Other { public static int Value => 42; }\n";
const FS_PROJECT: &str = r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup><Compile Include="Library.fs" /><Compile Include="Other.fs" /></ItemGroup>
</Project>"#;
const PROJECT: &str = r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup>
  <ItemGroup><Analyzer Include="../Analyzer/bin/Release/net10.0/CooperativeAnalyzer.dll" /></ItemGroup>
</Project>"#;

/// One shared analyzer source feeds every real compiler regression fixture.
const ANALYZER_FILES: [(&str, &str); 2] = [
    (
        "CooperativeAnalyzer.cs",
        include_str!("../../../../editors/vscode/test-fixtures/diagnostic-cancellation/CooperativeAnalyzer.cs"),
    ),
    (
        "CooperativeAnalyzer.csproj",
        include_str!("../../../../editors/vscode/test-fixtures/diagnostic-cancellation/CooperativeAnalyzer.csproj"),
    ),
];
/// Complete source and the independently expected SDK compiler failure, or success.
type OracleInput = (&'static str, Option<&'static str>);

/// The SDK pin every fixture `dotnet` invocation honours.
///
/// The `CooperativeAnalyzer` the C# fixture compiles targets
/// `$(MSBuildToolsPath)/Roslyn/bincore/Microsoft.CodeAnalysis.dll` — the SDK's
/// Roslyn. The C# sidecar bundles Roslyn 5.6.0 (Directory.Build.props), and the
/// repo `global.json` pins the SDK that ships exactly that Roslyn (10.0.303),
/// guarded by `Repo_pinned_sdk_ships_exactly_the_bundled_roslyn`. A fixture temp
/// dir lives OUTSIDE the repo, so `dotnet` would otherwise resolve the NEWEST
/// installed SDK; on CI that is 10.0.401 (Roslyn 5.9.0), whose analyzer assembly
/// `AnalyzerFileReference.GetAnalyzers` then silently refuses to load.
/// [DIST-RUNTIME-ACQUIRE] [DIAG-ANALYSIS-CANCELLATION]
const SDK_PIN: &str = include_str!("../../../../../global.json");

pub struct Fixture {
    directory: tempfile::TempDir,
    pub source: PathBuf,
    pub solution: PathBuf,
    pub marker: PathBuf,
    pub fsharp: bool,
}

impl Fixture {
    pub fn csharp() -> Self {
        let fixture = Self::create(false);
        fixture.write_analyzer();
        fixture.write_application();
        fixture.write_analyzer_config();
        fixture.sdk_oracles();
        fixture
    }

    pub fn fsharp() -> Self {
        let fixture = Self::create(true);
        fixture.write_application();
        fixture.sdk_oracles();
        fixture
    }

    fn create(fsharp: bool) -> Self {
        require_dotnet();
        let directory = tempfile::tempdir().expect("real compiler fixture");
        let root = directory.path();
        // Pin the fixture's SDK to the repo pin so the CooperativeAnalyzer builds
        // against the Roslyn the C# sidecar bundles; see SDK_PIN above.
        std::fs::write(root.join("global.json"), SDK_PIN).expect("pin the fixture SDK");
        Self {
            source: root.join(if fsharp {
                "App/Library.fs"
            } else {
                "App/Library.cs"
            }),
            solution: root.join("Cancellation.sln"),
            marker: root.join("analyzer-cancel"),
            directory,
            fsharp,
        }
    }

    pub fn root(&self) -> &Path {
        self.directory.path()
    }

    /// The same normal analyzer option is used by native and editor-driven tests.
    fn write_analyzer_config(&self) {
        let config = format!(
            "root = true\n[*.cs]\nsharplsp_cancellation_marker = {}\n",
            self.marker.display()
        );
        std::fs::write(self.root().join(".editorconfig"), config).expect("actual analyzer options");
    }

    pub fn uri(&self) -> String {
        path_to_file_uri(&self.source)
    }

    /// A second real compiled source shares the SDK project but has a distinct identity.
    pub fn other_uri(&self) -> String {
        path_to_file_uri(&self.other_path())
    }

    /// The companion is SDK-compiled in both languages and never introduces another error.
    pub fn other_saved(&self) -> &'static str {
        if self.fsharp {
            OTHER_FS
        } else {
            OTHER_CS
        }
    }

    /// Match the selected language's actual compiled companion.
    fn other_path(&self) -> PathBuf {
        self.root().join(if self.fsharp {
            "App/Other.fs"
        } else {
            "App/Other.cs"
        })
    }

    pub fn saved(&self) -> &'static str {
        if self.fsharp {
            OLD_FS
        } else {
            OLD_CS
        }
    }

    pub fn tag(&self) -> &'static str {
        if self.fsharp {
            "sharplsp-fsharp"
        } else {
            "sharplsp-csharp"
        }
    }

    fn project_name(&self) -> &'static str {
        if self.fsharp {
            "App/CancellationInput.fsproj"
        } else {
            "App/CancellationInput.csproj"
        }
    }

    pub fn signal(&self, suffix: &str) -> PathBuf {
        self.root().join(format!("analyzer-cancel.{suffix}"))
    }

    pub fn release_guard(&self) -> Release<'_> {
        Release(self)
    }

    fn write_analyzer(&self) {
        let directory = self.root().join("Analyzer");
        std::fs::create_dir_all(&directory).expect("analyzer directory");
        for (name, source) in ANALYZER_FILES {
            std::fs::write(directory.join(name), source).expect("write actual project analyzer");
        }
        self.sdk(&[
            "build",
            "Analyzer/CooperativeAnalyzer.csproj",
            "-c",
            "Release",
            "--nologo",
            "--disable-build-servers",
        ]);
    }

    fn write_application(&self) {
        std::fs::create_dir_all(self.root().join("App")).expect("application directory");
        std::fs::write(
            self.root().join(self.project_name()),
            if self.fsharp { FS_PROJECT } else { PROJECT },
        )
        .expect("real project XML");
        std::fs::write(self.other_path(), self.other_saved())
            .expect("independent clean compiled source");
        self.sdk(&["new", "sln", "--name", "Cancellation", "--format", "sln"]);
        self.sdk(&["sln", "Cancellation.sln", "add", self.project_name()]);
        self.sdk(&["restore", "Cancellation.sln", "--nologo"]);
        self.write_policy();
    }

    /// Only one real engine is active; visibility remains default solution-wide.
    fn write_policy(&self) {
        let policy = if self.fsharp {
            "[csharp]\nenabled=false\n"
        } else {
            "[fsharp]\nenabled=false\n"
        };
        std::fs::write(
            self.root().join("sharplsp.toml"),
            format!("{policy}[diagnostics]\nmin_severity=\"error\"\nrefresh_debounce_ms=0\n"),
        )
        .expect("compiler fixture policy");
    }

    fn sdk_oracles(&self) {
        let project = self.root().join(self.project_name());
        for (source, expected) in self.oracle_inputs() {
            std::fs::write(&self.source, source).expect("write independent SDK input");
            assert_build(&project, expected);
        }
        std::fs::write(&self.source, self.saved())
            .expect("restore original saved compiler failure");
    }

    /// Each language independently verifies old, edited, and repaired compiler truth.
    fn oracle_inputs(&self) -> [OracleInput; 3] {
        if self.fsharp {
            [
                (OLD_FS, Some("FS0001")),
                (CURRENT_FS, Some("FS0039")),
                (CLEAN_FS, None),
            ]
        } else {
            [
                (OLD_CS, Some("CS0103")),
                (CURRENT_CS, Some("CS0029")),
                (CLEAN_CS, None),
            ]
        }
    }

    fn sdk(&self, arguments: &[&str]) {
        let output = Command::new("dotnet")
            .args(arguments)
            .current_dir(self.root())
            .output()
            .expect("run real SDK fixture setup");
        assert!(
            output.status.success(),
            "SDK setup failed: {:?}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
}

/// Always release the actual analyzer before the owned host is dropped on failure.
pub struct Release<'a>(&'a Fixture);

impl Drop for Release<'_> {
    fn drop(&mut self) {
        std::fs::write(self.0.signal("release"), "release").expect("release owned analyzer");
    }
}
