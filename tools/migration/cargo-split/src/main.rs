use std::{env, fs, path::PathBuf};

use toml_edit::{value, DocumentMut, InlineTable, Item, Table, Value};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1).map(PathBuf::from);
    let workspace_manifest = args.next().ok_or("missing workspace manifest path")?;
    let package_manifest = args.next().ok_or("missing package manifest path")?;
    if args.next().is_some() {
        return Err("expected exactly two manifest paths".into());
    }

    inherit_package_metadata(&workspace_manifest, &package_manifest)
}

fn inherit_package_metadata(
    workspace_manifest: &PathBuf,
    package_manifest: &PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut workspace = fs::read_to_string(workspace_manifest)?.parse::<DocumentMut>()?;
    let mut package = fs::read_to_string(package_manifest)?.parse::<DocumentMut>()?;
    let package_table = package["package"]
        .as_table_mut()
        .ok_or("package manifest has no [package] table")?;
    let mut inherited = Table::new();
    for key in [
        "version",
        "edition",
        "description",
        "license",
        "homepage",
        "repository",
    ] {
        let item = package_table.remove(key).ok_or("missing package metadata key")?;
        inherited.insert(key, item);
        let mut marker = InlineTable::new();
        marker.insert("workspace", Value::from(true));
        package_table.insert(key, Item::Value(Value::InlineTable(marker)));
    }
    inherited.insert("readme", value("README.md"));
    let mut marker = InlineTable::new();
    marker.insert("workspace", Value::from(true));
    package_table.insert("readme", Item::Value(Value::InlineTable(marker)));

    workspace["workspace"]
        .as_table_mut()
        .ok_or("workspace manifest has no [workspace] table")?
        .insert("package", Item::Table(inherited));
    fs::write(package_manifest, package.to_string())?;
    fs::write(workspace_manifest, workspace.to_string())?;
    Ok(())
}
