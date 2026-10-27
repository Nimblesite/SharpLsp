//! Which native paths are compiler diagnostic inputs. [SHARPLSP-ARCHITECTURE-PATHS]

use std::path::Path;

use super::{has_extension, has_file_name};

/// Source and project diagnostics owned by the F# engine. [DIAG-CATEGORIES-COMPILER]
pub fn is_fsharp_diagnostic_input(path: impl AsRef<Path>) -> bool {
    has_extension(path, &["fs", "fsx", "fsi", "fsscript", "fsproj"])
}

/// Metadata that changes project graphs, analyzer policy, references or generated inputs.
pub fn diagnostic_requires_reload(path: &str) -> bool {
    has_extension(
        path,
        &["csproj", "fsproj", "sln", "slnx", "props", "targets"],
    ) || [
        ".editorconfig",
        "fsharplint.json",
        "project.assets.json",
        "global.json",
        // A restore input ([DIAG-RESTORE]); file names compare case-folded.
        "nuget.config",
    ]
    .into_iter()
    .any(|name| has_file_name(path, name))
}

/// Native inputs relevant to compiler errors or analyzer policy.
pub fn is_diagnostic_input(path: &Path) -> bool {
    is_diagnostic_source(path)
        || diagnostic_requires_reload(&path.to_string_lossy())
        || has_file_name(path, "sharplsp.toml")
}

/// Restore outputs reload without recursively restoring. [DIAG-RESTORE] [DIAG-LSP-REFRESH]
pub fn diagnostic_restore_output(path: impl AsRef<Path>) -> bool {
    let path = path.as_ref();
    diagnostic_requires_reload(&path.to_string_lossy()) && in_output_directory(path)
}

/// Generated outputs never become standalone compiler inputs. [DIAG-ARCHITECTURE-SCOPE]
pub fn is_diagnostic_source(path: impl AsRef<Path>) -> bool {
    let path = path.as_ref();
    has_extension(path, &["cs", "csx", "fs", "fsi", "fsx", "razor", "cshtml"])
        && !in_output_directory(path)
}

/// Whether an SDK `bin` or `obj` directory owns the path.
fn in_output_directory(path: &Path) -> bool {
    path.ancestors()
        .skip(1)
        .any(|directory| has_file_name(directory, "obj") || has_file_name(directory, "bin"))
}

/// SDK-owned sources need metadata adoption; scripts retain their independent compiler contexts.
pub fn is_user_diagnostic_source(path: impl AsRef<Path>) -> bool {
    let path = path.as_ref();
    has_extension(path, &["cs", "fs", "fsi", "razor", "cshtml"]) && is_diagnostic_source(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An inherited `nuget.config` is a restore input ([DIAG-RESTORE]): editing it
    /// reloads the compiler from any watch depth, and restores.
    #[test]
    fn nuget_configuration_reloads_the_compiler_at_every_scope() {
        for name in ["NuGet.Config", "nuget.config", "NuGet.config"] {
            let path = Path::new("repo").join(name);
            assert!(
                diagnostic_requires_reload(&path.to_string_lossy()),
                "{name} reloads"
            );
            assert!(
                super::super::diagnostic_input_in_scope(&path, false),
                "{name} counts at an inherited scope"
            );
            assert!(
                super::super::diagnostic_input_in_scope(&path, true),
                "{name} counts inside a project cone"
            );
            assert!(
                !diagnostic_restore_output(&path),
                "{name} is a restore input, never an output"
            );
        }
    }
}
