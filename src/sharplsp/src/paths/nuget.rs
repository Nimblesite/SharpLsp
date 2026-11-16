//! Where `NuGet` finds its configuration and how a configured source value
//! resolves. Implements [SHARPLSP-ARCHITECTURE-PATHS] for [PKG-VULN-FIX].

use std::path::{Path, PathBuf};

/// The file name `NuGet` reads in each directory, matched in any casing:
/// `dotnet new nugetconfig` writes `nuget.config`, Linux is case-sensitive.
const CONFIG_NAME: &str = "NuGet.Config";

/// Every `NuGet` config applying to `project`, lowest priority first: the
/// user-level config, then one per directory from the filesystem root down to
/// the project's own — nearer files override, as `NuGet` merges them.
pub fn nuget_config_chain(project: &Path) -> Vec<PathBuf> {
    let mut chain: Vec<PathBuf> = super::directory_of(project)
        .map_or_default(|directory| directory.ancestors().filter_map(config_in).collect());
    chain.extend(user_nuget_config());
    chain.reverse();
    chain
}

/// The `NuGet` config directly inside `directory`, in any casing.
fn config_in(directory: &Path) -> Option<PathBuf> {
    std::fs::read_dir(directory)
        .ok()?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .find(|path| super::has_file_name(path, CONFIG_NAME) && path.is_file())
}

/// The user-level config: `%APPDATA%\NuGet\NuGet.Config` on Windows,
/// `~/.nuget/NuGet/NuGet.Config` elsewhere.
fn user_nuget_config() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else {
        PathBuf::from(std::env::var_os("HOME")?).join(".nuget")
    };
    Some(base.join("NuGet").join(CONFIG_NAME)).filter(|path| path.is_file())
}

/// Where one configured package source lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceLocation {
    /// An `HTTP` v3 service index URL.
    Http(String),
    /// A folder feed directory.
    Folder(PathBuf),
}

/// Resolve a source `value` from the config in `config_directory`: URLs stay
/// as they are, folder feeds resolve against the config file's own directory.
pub fn source_location(config_directory: &Path, value: &str) -> SourceLocation {
    if value.starts_with("http://") || value.starts_with("https://") {
        SourceLocation::Http(value.to_string())
    } else {
        SourceLocation::Folder(config_directory.join(value))
    }
}
