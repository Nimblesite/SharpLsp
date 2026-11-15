//! Fix-all workspace fixture: two real C# projects in one `.sln`
//! ([FIXALL-TESTS], GitHub #577). The anchor document carries three IDE0007
//! sites; the sibling file two; the second project four; the clean file none.

use super::*;
use std::path::{Path, PathBuf};

// ── Shared fix-all e2e helpers ───────────────────────────────────

/// Poll `textDocument/codeAction` at the anchor until a fix-all action is
/// offered — the solution load finishes asynchronously.
pub fn poll_fix_all_actions(client: &mut LspClient, uri: &str, at: (u32, u32, u32)) -> Vec<Value> {
    std::thread::sleep(Duration::from_secs(5));
    let deadline = Instant::now() + Duration::from_secs(150);
    loop {
        let resp = client.request(
            "textDocument/codeAction",
            json!({
                "textDocument": { "uri": uri },
                "range": {
                    "start": { "line": at.0, "character": at.1 },
                    "end": { "line": at.0, "character": at.2 }
                },
                "context": { "diagnostics": [] }
            }),
        );
        assert!(
            resp.get("error").is_none(),
            "codeAction must not error: {resp}"
        );
        let none = Vec::new();
        let actions = resp["result"].as_array().unwrap_or(&none).clone();
        if actions
            .iter()
            .any(|action| title_of(action).starts_with("Fix all in "))
        {
            return actions;
        }
        assert!(
            Instant::now() < deadline,
            "no fix-all action was offered within 150s — actions seen: {actions:?}"
        );
        std::thread::sleep(Duration::from_secs(3));
    }
}

pub fn title_of(action: &Value) -> &str {
    action["title"].as_str().unwrap_or_default()
}

/// The single fix-all action for `scope`, whose title is
/// `Fix all in <scope>: <base title>`.
pub fn fix_all_for<'a>(actions: &'a [Value], scope: &str, base_title: &str) -> &'a Value {
    let wanted = format!("Fix all in {scope}: {base_title}");
    actions
        .iter()
        .find(|action| title_of(action) == wanted)
        .unwrap_or_else(|| panic!("no action titled {wanted:?}; actions: {actions:?}"))
}

/// The `(uri, edit count)` pairs of a resolved action's workspace edit.
pub fn edit_files(resp: &Value, label: &str) -> Vec<(String, usize)> {
    let changes = resp["result"]["edit"]["changes"]
        .as_object()
        .unwrap_or_else(|| panic!("{label} must resolve to a workspace edit with changes: {resp}"));
    changes
        .iter()
        .map(|(uri, edits)| (uri.clone(), edits.as_array().map_or(0, Vec::len)))
        .collect()
}

pub fn edits_in(files: &[(String, usize)], suffix: &str) -> usize {
    files
        .iter()
        .find(|(uri, _)| uri.ends_with(suffix))
        .map_or(0, |(_, count)| *count)
}

// ── Fixture sources ───────────────────────────────────────────────
// Line/column positions below are load-bearing: `inventory_pos` documents the
// anchor the tests act on. Editing these sources means re-deriving positions.

/// Three IDE0007 sites (`int units`, `string label`, `bool stacked`).
pub const FIXALL_INVENTORY_CS: &str = r#"namespace FixAll.Core;

public static class Inventory
{
    public static int CountUnits(string[] boxes)
    {
        int units = boxes.Length;
        string label = "units";
        bool stacked = units > 0;
        return stacked ? units : 0;
    }
}
"#;

/// Two IDE0007 sites (`int capacity`, `string name`) in the same project.
pub const FIXALL_WAREHOUSE_CS: &str = r#"namespace FixAll.Core;

public static class Warehouse
{
    public static string NameOf(int zone)
    {
        int capacity = zone * 10;
        string name = $"zone-{zone}";
        return name.Length > capacity ? name : name + capacity;
    }
}
"#;

/// No IDE0007 site at all — must never be touched by any scope.
pub const FIXALL_SETTINGS_CS: &str = r#"namespace FixAll.Core;

public static class Settings
{
    public const string Region = "eu";
}
"#;

/// Four IDE0007 sites (`int id`, `decimal amount`, `bool paid`, `int
/// rounding`) in the second project, which references the first.
pub const FIXALL_INVOICE_CS: &str = r"using FixAll.Core;

namespace FixAll.Billing;

public static class Invoice
{
    public static decimal TotalOf(int zone, string[] items)
    {
        int id = zone;
        decimal amount = items.Length * 2.5m;
        bool paid = amount == 0m;
        int rounding = id + 1;
        return paid ? 0m : amount + rounding;
    }
}
";

/// Positions inside the anchor document `Inventory.cs` (0-based).
pub mod inventory_pos {
    /// The `int` of `int units = boxes.Length;` — the first IDE0007 site.
    pub const FIRST_EXPLICIT_TYPE: (u32, u32, u32) = (6, 8, 11);
}

// ── Workspace builder ─────────────────────────────────────────────

/// A restored two-project C# solution on disk: `Core` (Inventory, Warehouse,
/// Settings) referenced by `Billing` (Invoice). Keep the struct alive for the
/// duration of the test — dropping it deletes the temp directory.
pub struct FixAllWorkspace {
    /// Owns the temp directory backing the workspace.
    pub tmp: tempfile::TempDir,
    /// Canonicalized workspace root.
    pub root: PathBuf,
}

impl FixAllWorkspace {
    pub fn root_uri(&self) -> String {
        path_to_file_uri(&self.root)
    }

    pub fn inventory_path(&self) -> PathBuf {
        self.core_path("Inventory.cs")
    }

    pub fn warehouse_path(&self) -> PathBuf {
        self.core_path("Warehouse.cs")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.core_path("Settings.cs")
    }

    pub fn invoice_path(&self) -> PathBuf {
        self.root.join("Billing").join("Invoice.cs")
    }

    fn core_path(&self, name: &str) -> PathBuf {
        self.root.join("Core").join(name)
    }
}

/// Create the fix-all workspace on disk and restore its projects.
pub fn create_fixall_workspace() -> FixAllWorkspace {
    let tmp = tempfile::tempdir().unwrap();
    write_fixall_editorconfig(tmp.path());
    write_fixall_core(tmp.path());
    write_fixall_billing(tmp.path());
    write_fixall_solution(tmp.path());
    // Restoring Billing restores Core transitively via the ProjectReference.
    restore_project(&tmp.path().join("Billing"));
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    FixAllWorkspace { tmp, root }
}

/// Promoting the var styles is what makes IDE0007 report, so the fix — with its
/// fix-all — is offered at every explicit local type ([FIXALL-TESTS]).
fn write_fixall_editorconfig(root: &Path) {
    std::fs::write(
        root.join(".editorconfig"),
        r"root = true

[*.cs]
csharp_style_var_for_built_in_types = true:warning
csharp_style_var_when_type_is_apparent = true:warning
csharp_style_var_elsewhere = true:warning
",
    )
    .unwrap();
}

fn write_fixall_core(root: &Path) {
    let proj_dir = root.join("Core");
    std::fs::create_dir_all(&proj_dir).unwrap();
    std::fs::write(
        proj_dir.join("Core.csproj"),
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
    std::fs::write(proj_dir.join("Inventory.cs"), FIXALL_INVENTORY_CS).unwrap();
    std::fs::write(proj_dir.join("Warehouse.cs"), FIXALL_WAREHOUSE_CS).unwrap();
    std::fs::write(proj_dir.join("Settings.cs"), FIXALL_SETTINGS_CS).unwrap();
}

fn write_fixall_billing(root: &Path) {
    let proj_dir = root.join("Billing");
    std::fs::create_dir_all(&proj_dir).unwrap();
    std::fs::write(
        proj_dir.join("Billing.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <OutputType>Library</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Core/Core.csproj" />
  </ItemGroup>
</Project>"#,
    )
    .unwrap();
    std::fs::write(proj_dir.join("Invoice.cs"), FIXALL_INVOICE_CS).unwrap();
}

fn write_fixall_solution(root: &Path) {
    std::fs::write(
        root.join("FixAll.sln"),
        r#"Microsoft Visual Studio Solution File, Format Version 12.00
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Core", "Core/Core.csproj", "{10000000-0000-0000-0000-000000000011}"
EndProject
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Billing", "Billing/Billing.csproj", "{10000000-0000-0000-0000-000000000012}"
EndProject
Global
EndGlobal"#,
    )
    .unwrap();
}
