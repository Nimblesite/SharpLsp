//! Shared test fixtures: constants, C# source snippets, and workspace creation helpers.

// ── Shared test fixtures ──────────────────────────────────────────

pub const TEST_URI: &str = "file:///test/Program.cs";

pub const SIMPLE_CLASS: &str = r#"
using System;

namespace MyApp
{
    public class Program
    {
        public static void Main(string[] args)
        {
            Console.WriteLine("Hello");
        }

        public string Name { get; set; }
    }
}
"#;

pub const COMPLEX_CLASS: &str = r#"
using System;
using System.Collections.Generic;

namespace MyApp.Models
{
    public interface IEntity
    {
        int Id { get; }
    }

    public class User : IEntity
    {
        public int Id { get; set; }
        public string Name { get; set; }

        public User(int id, string name)
        {
            Id = id;
            Name = name;
        }

        public void Greet()
        {
            Console.WriteLine($"Hello, {Name}!");
        }
    }

    public enum Role
    {
        Admin,
        User,
        Guest
    }

    public struct Point
    {
        public int X;
        public int Y;
    }

    public record PersonRecord(string FirstName, string LastName);

    public delegate void EventHandler(object sender, EventArgs e);
}
"#;

pub const EMPTY_FILE: &str = "";

// ── Workspace creation helpers ────────────────────────────────────

/// Create a minimal .NET project workspace in a temp directory.
pub fn create_test_workspace() -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("TestHover");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("TestHover.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    let cs_source = r#"namespace TestHover;

/// <summary>A simple calculator for arithmetic operations.</summary>
public class Calculator
{
    /// <summary>Adds two integers.</summary>
    /// <param name="a">The first operand.</param>
    /// <param name="b">The second operand.</param>
    /// <returns>The sum of a and b.</returns>
    public int Add(int a, int b) { return a + b; }

    /// <summary>The calculator's display name.</summary>
    public string Name { get; set; } = "Default";

    [System.Obsolete("Use Add instead")]
    public int OldAdd(int x, int y) { return x + y; }

    private int _counter;
}

public struct Point
{
    public int X;
    public int Y;
}

public interface ICalculator
{
    int Add(int a, int b);
}

public enum Color
{
    Red,
    Green,
    Blue
}

public static class VarExample
{
    public static void Run()
    {
        var calc = new Calculator();
        var name = calc.Name;
    }
}"#;
    std::fs::write(proj_dir.join("Program.cs"), cs_source).unwrap();

    std::fs::write(
        tmp.path().join("TestHover.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "TestHover", "TestHover/TestHover.csproj", "{00000000-0000-0000-0000-000000000001}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    let restore = std::process::Command::new("dotnet")
        .args(["restore", "--verbosity", "quiet"])
        // Restore the project directly, not the cwd: the generated .sln has no
        // GlobalSection(ProjectConfigurationPlatforms), so `dotnet restore` in
        // tmp warns "Unable to find a project to restore" and writes NO
        // obj/project.assets.json. Without the assets file the sidecar's Roslyn
        // design-time build cannot resolve the project and returns null
        // definitions on cold CI runners (matches the ChangeTest fixture below).
        .current_dir(&proj_dir)
        .status()
        .expect("dotnet restore failed to start");
    assert!(restore.success(), "dotnet restore must succeed");

    let real_root = std::fs::canonicalize(tmp.path()).unwrap();
    let real_proj = real_root.join("TestHover");
    let root_uri = format!("file://{}", real_root.display());
    let file_uri = format!("file://{}", real_proj.join("Program.cs").display());
    (tmp, root_uri, file_uri, cs_source.to_string())
}

/// Create a workspace whose single project references `Newtonsoft.Json` but
/// never uses it — so a real Roslyn `GetUsedAssemblyReferences` pass flags the
/// package as unused. Returns `(TempDir, root_uri, sln_path, csproj_path,
/// file_uri, source)`. Used by the `sharplsp/nuget/unused` full-stack test.
pub fn create_unused_packages_workspace(
) -> (tempfile::TempDir, String, String, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("UnusedPkg");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("UnusedPkg.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>"#,
    )
    .unwrap();

    // Source uses only the framework — Newtonsoft.Json is referenced but never
    // touched, which is exactly what makes it "unused".
    let cs_source = r#"namespace UnusedPkg;

public class Greeter
{
    public string Greet(string name) => $"Hello, {name}!";

    public int Count { get; set; }
}"#;
    std::fs::write(proj_dir.join("Program.cs"), cs_source).unwrap();

    std::fs::write(
        tmp.path().join("UnusedPkg.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "UnusedPkg", "UnusedPkg/UnusedPkg.csproj", "{00000000-0000-0000-0000-000000000003}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    let restore = std::process::Command::new("dotnet")
        .args(["restore", "--verbosity", "quiet"])
        // Restore the project directly so obj/project.assets.json is written and
        // the Newtonsoft.Json compile assembly resolves for the design-time build.
        .current_dir(&proj_dir)
        .status()
        .expect("dotnet restore failed to start");
    assert!(restore.success(), "dotnet restore must succeed");

    let real_root = std::fs::canonicalize(tmp.path()).unwrap();
    let real_proj = real_root.join("UnusedPkg");
    let root_uri = format!("file://{}", real_root.display());
    let sln_path = real_root
        .join("UnusedPkg.sln")
        .to_string_lossy()
        .into_owned();
    let csproj_path = real_proj
        .join("UnusedPkg.csproj")
        .to_string_lossy()
        .into_owned();
    let file_uri = format!("file://{}", real_proj.join("Program.cs").display());
    (
        tmp,
        root_uri,
        sln_path,
        csproj_path,
        file_uri,
        cs_source.to_string(),
    )
}

/// Create an F# test workspace with .fsproj and .fs files.
pub fn create_fsharp_test_workspace() -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("TestFSharp");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("TestFSharp.fsproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Library.fs" />
  </ItemGroup>
</Project>"#,
    )
    .unwrap();

    let fs_source = r"namespace TestFSharp

/// A simple calculator module.
module Calculator =
    /// Adds two integers and returns the sum.
    let add (a: int) (b: int) : int = a + b

    /// Multiplies two integers.
    let multiply (a: int) (b: int) : int = a * b

/// Represents a shape with area calculation.
type Shape =
    | Circle of radius: float
    | Rectangle of width: float * height: float

/// Compute the area of a shape.
let area (shape: Shape) : float =
    match shape with
    | Shape.Circle r -> System.Math.PI * r * r
    | Shape.Rectangle(w, h) -> w * h

/// Pipeline example: sum of squares.
let sumOfSquares (xs: int list) : int =
    xs |> List.map (fun x -> x * x) |> List.sum
";
    std::fs::write(proj_dir.join("Library.fs"), fs_source).unwrap();

    std::fs::write(
        tmp.path().join("TestFSharp.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{F2A71F9B-5D33-465A-A702-920D77279786}") = "TestFSharp", "TestFSharp/TestFSharp.fsproj", "{00000000-0000-0000-0000-000000000002}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    let restore = std::process::Command::new("dotnet")
        .args(["restore", "--verbosity", "quiet"])
        // Restore the project directly, not the cwd: the generated .sln has no
        // GlobalSection(ProjectConfigurationPlatforms), so `dotnet restore` in
        // tmp warns "Unable to find a project to restore" and writes NO
        // obj/project.assets.json. Without the assets file the sidecar's Roslyn
        // design-time build cannot resolve the project and returns null
        // definitions on cold CI runners (matches the ChangeTest fixture below).
        .current_dir(&proj_dir)
        .status()
        .expect("dotnet restore failed");
    assert!(restore.success(), "dotnet restore must succeed");

    let real_root = std::fs::canonicalize(tmp.path()).unwrap();
    let real_proj = real_root.join("TestFSharp");
    let root_uri = format!("file://{}", real_root.display());
    let file_uri = format!("file://{}", real_proj.join("Library.fs").display());
    (tmp, root_uri, file_uri, fs_source.to_string())
}

/// Create an F# workspace whose source `open`s a restored external package
/// (`Newtonsoft.Json`). Used to prove the F# sidecar resolves package references
/// in its persistent project options — a file that compiles must not report
/// unresolved-namespace/type errors. Regression fixture for issue #120.
pub fn create_fsharp_nuget_workspace() -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("TestFSharpNuget");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("TestFSharpNuget.fsproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Library</OutputType>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Serializer.fs" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>"#,
    )
    .unwrap();

    // `open Newtonsoft.Json` + `JsonConvert` exercise the external package
    // reference. With the package resolved this compiles cleanly; with it
    // missing FCS reports FS0039 (namespace not defined) — the #120 symptom.
    let fs_source = r"namespace TestFSharpNuget

open Newtonsoft.Json

/// Serializes values to JSON via the Newtonsoft.Json package.
module Serializer =

    /// A simple record round-tripped through JSON.
    type Payload = { Name: string; Value: int }

    /// Serialize a payload to a JSON string.
    let toJson (payload: Payload) : string =
        JsonConvert.SerializeObject(payload)
";
    std::fs::write(proj_dir.join("Serializer.fs"), fs_source).unwrap();

    std::fs::write(
        tmp.path().join("TestFSharpNuget.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{F2A71F9B-5D33-465A-A702-920D77279786}") = "TestFSharpNuget", "TestFSharpNuget/TestFSharpNuget.fsproj", "{00000000-0000-0000-0000-000000000003}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    let restore = std::process::Command::new("dotnet")
        .args(["restore", "--verbosity", "quiet"])
        // Restore the project directly: the generated .sln has no
        // ProjectConfigurationPlatforms, so restoring the cwd writes no
        // obj/project.assets.json and the sidecar cannot resolve references.
        .current_dir(&proj_dir)
        .status()
        .expect("dotnet restore failed");
    assert!(restore.success(), "dotnet restore must succeed");

    let real_root = std::fs::canonicalize(tmp.path()).unwrap();
    let real_proj = real_root.join("TestFSharpNuget");
    let root_uri = format!("file://{}", real_root.display());
    let file_uri = format!("file://{}", real_proj.join("Serializer.fs").display());
    (tmp, root_uri, file_uri, fs_source.to_string())
}

/// Create a .NET workspace with interfaces, implementations, overrides,
/// and method calls — everything needed to test definition navigation.
pub fn create_definition_workspace() -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("TestDefinition");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("TestDefinition.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    let cs_source = r#"namespace TestDefinition;

public interface IAnimal
{
    string Name { get; }
    string Speak();
}

public abstract class AnimalBase : IAnimal
{
    public abstract string Name { get; }
    public virtual string Speak() { return "..."; }
}

public class Dog : AnimalBase
{
    public override string Name => "Dog";
    public override string Speak() { return "Woof"; }
}

public class Cat : AnimalBase
{
    public override string Name => "Cat";
    public override string Speak() { return "Meow"; }
}

public class Zoo
{
    public Dog MyDog { get; } = new Dog();
    public Cat MyCat { get; } = new Cat();

    public string GetGreeting()
    {
        var dog = MyDog;
        var message = dog.Speak();
        return message;
    }
}"#;
    std::fs::write(proj_dir.join("Program.cs"), cs_source).unwrap();

    std::fs::write(
        tmp.path().join("TestDefinition.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "TestDefinition", "TestDefinition/TestDefinition.csproj", "{00000000-0000-0000-0000-000000000002}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    let restore = std::process::Command::new("dotnet")
        .args(["restore", "--verbosity", "quiet"])
        // Restore the project directly, not the cwd: the generated .sln has no
        // GlobalSection(ProjectConfigurationPlatforms), so `dotnet restore` in
        // tmp warns "Unable to find a project to restore" and writes NO
        // obj/project.assets.json. Without the assets file the sidecar's Roslyn
        // design-time build cannot resolve the project and returns null
        // definitions on cold CI runners (matches the ChangeTest fixture below).
        .current_dir(&proj_dir)
        .status()
        .expect("dotnet restore failed to start");
    assert!(restore.success(), "dotnet restore must succeed");

    let real_root = std::fs::canonicalize(tmp.path()).unwrap();
    let real_proj = real_root.join("TestDefinition");
    let root_uri = format!("file://{}", real_root.display());
    let file_uri = format!("file://{}", real_proj.join("Program.cs").display());
    (tmp, root_uri, file_uri, cs_source.to_string())
}

/// Create a workspace symbols fixture.
pub fn create_workspace_symbols_fixture() -> (tempfile::TempDir, String) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("MyLib");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("MyLib.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    std::fs::write(
        proj_dir.join("Models.cs"),
        r#"namespace MyLib.Models;

public class Customer
{
    public string Name { get; set; } = "";
    public int Age { get; set; }

    public void Greet() { }
    private int _id;
}

public interface IRepository
{
    void Save();
}

public enum Status
{
    Active,
    Inactive
}

public struct Point
{
    public int X;
    public int Y;
}

public record Address(string Street, string City);

public delegate void Handler(string msg);
"#,
    )
    .unwrap();

    std::fs::write(
        tmp.path().join("Test.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "MyLib", "MyLib/MyLib.csproj", "{00000000-0000-0000-0000-000000000001}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    let sln_path = tmp
        .path()
        .canonicalize()
        .unwrap()
        .join("Test.sln")
        .to_string_lossy()
        .to_string();
    (tmp, sln_path)
}

/// Create a temporary `ChangeTest` workspace.
pub fn create_change_test_workspace() -> (
    tempfile::TempDir,
    String,
    std::path::PathBuf,
    String,
    &'static str,
) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path().join("ChangeTest");
    std::fs::create_dir_all(&proj_dir).unwrap();

    std::fs::write(
        proj_dir.join("ChangeTest.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    let clean_source = r"namespace ChangeTest;
public class Widget
{
    public int Count { get; set; }
}
";
    std::fs::write(proj_dir.join("Widget.cs"), clean_source).unwrap();

    std::fs::write(
        tmp.path().join("ChangeTest.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "ChangeTest", "ChangeTest/ChangeTest.csproj", "{00000000-0000-0000-0000-000000000001}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();

    let restore = std::process::Command::new("dotnet")
        .args(["restore", "--verbosity", "quiet"])
        .current_dir(&proj_dir)
        .status()
        .expect("dotnet restore failed");
    assert!(restore.success(), "dotnet restore must succeed");

    let real_root = std::fs::canonicalize(tmp.path()).unwrap();
    let root_uri = format!("file://{}", real_root.display());
    let file_path = real_root.join("ChangeTest").join("Widget.cs");
    let file_uri = format!("file://{}", file_path.display());
    (tmp, root_uri, file_path, file_uri, clean_source)
}

/// Create a workspace with only a `.csproj` file (no `.sln`).
pub fn create_standalone_csproj_workspace() -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let proj_dir = tmp.path();

    std::fs::write(
        proj_dir.join("TestStandalone.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();

    let cs_source = r#"namespace TestStandalone;

public class Calculator
{
    public int Add(int a, int b) { return a + b; }
    public string Name { get; set; } = "Default";
}"#;
    std::fs::write(proj_dir.join("Calculator.cs"), cs_source).unwrap();

    let restore = std::process::Command::new("dotnet")
        .args(["restore", "--verbosity", "quiet"])
        .current_dir(proj_dir)
        .status()
        .expect("dotnet restore failed to start");
    assert!(restore.success(), "dotnet restore must succeed");

    let real_root = std::fs::canonicalize(proj_dir).unwrap();
    let root_uri = format!("file://{}", real_root.display());
    let file_uri = format!("file://{}", real_root.join("Calculator.cs").display());
    (tmp, root_uri, file_uri, cs_source.to_string())
}
