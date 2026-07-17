//! Mixed-language (C# ↔ F#) workspace fixtures for cross-language navigation.
//!
//! Each fixture is a real, buildable solution containing a C# project and an F#
//! project with a `<ProjectReference>` across the language boundary. The
//! fixtures are **built** (`dotnet build`), not merely restored: cross-language
//! go-to-definition resolves the referenced symbol out of the *compiled*
//! assembly (Roslyn / FCS see the other language only as metadata), so the
//! referenced project's output DLL must exist on disk before the sidecar runs.
//!
//! The solution file is created with the `dotnet` CLI (`dotnet new sln` +
//! `dotnet sln add`), never hand-written: a real solution carries the
//! `SolutionConfigurationPlatforms` / `ProjectConfigurationPlatforms` sections
//! that both `dotnet build <sln>` and Roslyn's `MSBuildWorkspace` need to
//! resolve inter-project references. A minimal hand-rolled `.sln` silently
//! drops those references. Implements [DEFINITION-CROSSLANG].

use super::*;
use std::path::Path;

/// Run a `dotnet` subcommand in `cwd`, asserting success.
fn dotnet(args: &[&str], cwd: &Path) {
    let status = std::process::Command::new("dotnet")
        .args(args)
        .current_dir(cwd)
        .status()
        .expect("dotnet failed to start");
    assert!(
        status.success(),
        "dotnet {args:?} must succeed in {}",
        cwd.display()
    );
}

/// Create a real solution over `project_rel_paths` and build it.
///
/// Building the solution (which restores first) produces every project's output
/// DLL, so a cross-language reference resolves against a compiled assembly that
/// actually exists on disk.
fn create_and_build_solution(root: &Path, project_rel_paths: &[&str]) {
    // Let `dotnet` auto-detect the created solution in `root`: SDK 10 defaults
    // `dotnet new sln` to the `.slnx` format, so hardcoding `CrossLang.sln`
    // fails. Both sidecars' loaders accept `.sln` and `.slnx`.
    dotnet(&["new", "sln", "-n", "CrossLang"], root);
    for proj in project_rel_paths {
        dotnet(&["sln", "add", proj], root);
    }
    dotnet(&["build", "--verbosity", "quiet", "--nologo"], root);
}

/// Cross-language fixture where **C# navigates into F#**.
///
/// Layout: an F# library `SharedFSharp` defines `Shape`; a C# project
/// `CSharpConsumer` references it and constructs `new Shape(...)`. Go-to-def on
/// `Shape` (or its members) in the C# file resolves through the F# assembly's
/// metadata. Returns `(TempDir, root_uri, csharp_file_uri, csharp_source)`.
pub fn create_cross_language_cs_to_fs_workspace() -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    // ── F# library (the definition target) ──
    let fs_dir = root.join("SharedFSharp");
    std::fs::create_dir_all(&fs_dir).unwrap();
    std::fs::write(
        fs_dir.join("SharedFSharp.fsproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Shapes.fs" />
  </ItemGroup>
</Project>"#,
    )
    .unwrap();
    std::fs::write(
        fs_dir.join("Shapes.fs"),
        r#"namespace SharedFSharp

/// A geometric shape defined in F#, consumed from C#.
type Shape(name: string, sides: int) =
    /// The shape's display name.
    member _.Name = name
    /// The number of sides.
    member _.Sides = sides
    /// Human-readable description.
    member _.Describe() = sprintf "%s has %d sides" name sides
"#,
    )
    .unwrap();

    // ── C# consumer (navigates into F#) ──
    let cs_dir = root.join("CSharpConsumer");
    std::fs::create_dir_all(&cs_dir).unwrap();
    std::fs::write(
        cs_dir.join("CSharpConsumer.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\SharedFSharp\SharedFSharp.fsproj" />
  </ItemGroup>
</Project>"#,
    )
    .unwrap();

    // Line/character positions of `Shape` matter to the test — keep this source
    // and the navigation coordinates in `definition_cross_language.rs` in sync.
    // A raw string literal (not `\`-continuation, which strips leading
    // whitespace) so the indentation — and therefore every column — is exactly
    // as written.
    let cs_source = r#"namespace CSharpConsumer;

using SharedFSharp;

public class Program
{
    public static string Run()
    {
        var s = new Shape("triangle", 3);
        return s.Describe();
    }
}
"#;
    std::fs::write(cs_dir.join("Program.cs"), cs_source).unwrap();

    create_and_build_solution(
        root,
        &[
            "SharedFSharp\\SharedFSharp.fsproj",
            "CSharpConsumer\\CSharpConsumer.csproj",
        ],
    );

    let real_root = std::fs::canonicalize(root).unwrap();
    let root_uri = path_to_file_uri(&real_root);
    let file_uri = path_to_file_uri(&real_root.join("CSharpConsumer").join("Program.cs"));
    (tmp, root_uri, file_uri, cs_source.to_string())
}

/// Cross-language fixture where **F# navigates into C#**.
///
/// Layout: a C# library `SharedCSharp` defines `Greeter`; an F# project
/// `FSharpConsumer` references it and calls `Greeter().Greet(...)`. Go-to-def on
/// `Greeter` in the F# file resolves through the C# assembly's metadata. Returns
/// `(TempDir, root_uri, fsharp_file_uri, fsharp_source)`.
pub fn create_cross_language_fs_to_cs_workspace() -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    // ── C# library (the definition target) ──
    let cs_dir = root.join("SharedCSharp");
    std::fs::create_dir_all(&cs_dir).unwrap();
    std::fs::write(
        cs_dir.join("SharedCSharp.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();
    std::fs::write(
        cs_dir.join("Greeter.cs"),
        r#"namespace SharedCSharp;

/// <summary>A greeter defined in C#, consumed from F#.</summary>
public class Greeter
{
    /// <summary>Greet someone by name.</summary>
    public string Greet(string name) => $"Hello, {name}!";

    /// <summary>Default number of greetings.</summary>
    public int DefaultCount { get; set; } = 1;
}
"#,
    )
    .unwrap();

    // ── F# consumer (navigates into C#) ──
    let fs_dir = root.join("FSharpConsumer");
    std::fs::create_dir_all(&fs_dir).unwrap();
    std::fs::write(
        fs_dir.join("FSharpConsumer.fsproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Program.fs" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\SharedCSharp\SharedCSharp.csproj" />
  </ItemGroup>
</Project>"#,
    )
    .unwrap();

    // Line/character positions matter to the test — keep this source and the
    // navigation coordinates in `definition_cross_language.rs` in sync.
    // `localName` (line 4) is a purely-local binding used to establish F#
    // sidecar readiness independently of the cross-language C# reference.
    let fs_source = r#"module FSharpConsumer.Program

open SharedCSharp

let localName = "World"
let greeter = Greeter()
let message = greeter.Greet(localName)
"#;
    std::fs::write(fs_dir.join("Program.fs"), fs_source).unwrap();

    create_and_build_solution(
        root,
        &[
            "SharedCSharp\\SharedCSharp.csproj",
            "FSharpConsumer\\FSharpConsumer.fsproj",
        ],
    );

    let real_root = std::fs::canonicalize(root).unwrap();
    let root_uri = path_to_file_uri(&real_root);
    let file_uri = path_to_file_uri(&real_root.join("FSharpConsumer").join("Program.fs"));
    (tmp, root_uri, file_uri, fs_source.to_string())
}
