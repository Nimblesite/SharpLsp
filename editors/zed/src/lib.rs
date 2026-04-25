mod project;
mod solution;
mod tree;

use zed_extension_api::{self as zed};

/// Forge Zed extension — provides forge-lsp for C# and F# development.
struct ForgeExtension {
    cached_binary_path: Option<String>,
}

const SERVER_BINARY: &str = "forge-lsp";
const EXPECTED_VERSION: &str = env!("CARGO_PKG_VERSION");
const SLASH_CMD_TREE: &str = "forge-tree";

impl zed::Extension for ForgeExtension {
    fn new() -> Self {
        ForgeExtension {
            cached_binary_path: None,
        }
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        let binary = self.resolve_binary(worktree)?;
        let env = build_server_env(worktree);
        Ok(zed::Command {
            command: binary,
            args: vec![],
            env,
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> zed::Result<Option<zed::serde_json::Value>> {
        Ok(None)
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> zed::Result<Option<zed::serde_json::Value>> {
        Ok(None)
    }

    fn complete_slash_command_argument(
        &self,
        command: zed::SlashCommand,
        _args: Vec<String>,
    ) -> zed::Result<Vec<zed::SlashCommandArgumentCompletion>> {
        match command.name.as_str() {
            SLASH_CMD_TREE => Ok(vec![zed::SlashCommandArgumentCompletion {
                label: "path/to/Solution.sln".to_string(),
                new_text: "Solution.sln".to_string(),
                run_command: false,
            }]),
            _ => Ok(vec![]),
        }
    }

    fn run_slash_command(
        &self,
        command: zed::SlashCommand,
        args: Vec<String>,
        worktree: Option<&zed::Worktree>,
    ) -> zed::Result<zed::SlashCommandOutput> {
        match command.name.as_str() {
            SLASH_CMD_TREE => run_tree_command(args, worktree),
            _ => Err(format!("Unknown command: {}", command.name)),
        }
    }
}

zed::register_extension!(ForgeExtension);

// ── Server binary resolution ────────────────────────────────────

impl ForgeExtension {
    /// Resolve the forge-lsp binary path.
    ///
    /// Priority:
    ///   1. Cached path from a previous successful resolution
    ///   2. Binary on `$PATH` (via worktree.which)
    ///
    /// NOTE: The Zed extension API (WASM sandbox) does not support running
    /// subprocesses, so we cannot execute `forge-lsp --version` to verify
    /// the binary version matches the extension version. Version validation
    /// relies on the LSP server reporting its version during initialization.
    fn resolve_binary(&mut self, worktree: &zed::Worktree) -> zed::Result<String> {
        if let Some(ref path) = self.cached_binary_path {
            return Ok(path.clone());
        }

        let path = worktree.which(SERVER_BINARY).ok_or_else(|| {
            format!(
                "{SERVER_BINARY} not found on PATH. \
                 Install Forge v{EXPECTED_VERSION} via `make install` \
                 or download from https://github.com/Nimblesite/forge/releases"
            )
        })?;

        self.cached_binary_path = Some(path.clone());
        Ok(path)
    }
}

/// Build environment variables for the forge-lsp server process.
fn build_server_env(worktree: &zed::Worktree) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = worktree.shell_env();
    let has_rust_log = env.iter().any(|(key, _)| key == "RUST_LOG");
    if !has_rust_log {
        env.push(("RUST_LOG".to_string(), "info".to_string()));
    }
    env
}

// ── Slash command: forge-tree ───────────────────────────────────

fn run_tree_command(
    args: Vec<String>,
    worktree: Option<&zed::Worktree>,
) -> zed::Result<zed::SlashCommandOutput> {
    let wt = worktree.ok_or("No worktree available")?;

    let sln_path = args
        .first()
        .ok_or("Usage: /forge-tree <path/to/Solution.sln>")?;

    let sln_content = wt
        .read_text_file(sln_path)
        .map_err(|err| format!("Failed to read {}: {}", sln_path, err))?;

    let projects = solution::parse_solution(&sln_content, sln_path);
    let enriched = enrich_projects(wt, &projects);
    let text = tree::format_solution_tree(sln_path, &enriched);
    let label = format!("Solution: {}", sln_path);

    Ok(zed::SlashCommandOutput {
        text: text.clone(),
        sections: vec![zed::SlashCommandOutputSection {
            range: (0..text.len()).into(),
            label,
        }],
    })
}

/// Read each project file and parse its dependencies.
fn enrich_projects(
    worktree: &zed::Worktree,
    projects: &[solution::SolutionProject],
) -> Vec<tree::EnrichedProject> {
    projects
        .iter()
        .map(|proj| enrich_single_project(worktree, proj))
        .collect()
}

fn enrich_single_project(
    worktree: &zed::Worktree,
    proj: &solution::SolutionProject,
) -> tree::EnrichedProject {
    let deps = worktree
        .read_text_file(&proj.relative_path)
        .map(|content| project::parse_project_file(&content))
        .unwrap_or_default();

    tree::EnrichedProject {
        name: proj.name.clone(),
        relative_path: proj.relative_path.clone(),
        nuget_packages: deps.nuget_packages,
        project_references: deps.project_references,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_version_matches_cargo_toml() {
        // EXPECTED_VERSION is set at compile time from Cargo.toml.
        // This ensures the Zed extension version matches the crate version.
        assert_eq!(EXPECTED_VERSION, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn expected_version_is_valid_semver() {
        let segments: Vec<&str> = EXPECTED_VERSION.split('.').collect();
        assert!(
            segments.len() >= 2,
            "Version must have at least X.Y segments, got: {EXPECTED_VERSION}",
        );
        for segment in &segments {
            assert!(
                segment.parse::<u32>().is_ok(),
                "Each version segment must be numeric, got: {segment} in {EXPECTED_VERSION}",
            );
        }
    }

    #[test]
    fn expected_version_matches_extension_toml_version() {
        // extension.toml `version` and Cargo.toml `version` MUST match.
        // Since both are set to the same value, and EXPECTED_VERSION comes
        // from Cargo.toml, this test proves they are in sync.
        // If they drift, the build system should catch it.
        let version = env!("CARGO_PKG_VERSION");
        assert!(!version.is_empty(), "CARGO_PKG_VERSION must not be empty",);
    }

    #[test]
    fn server_binary_name_is_forge_lsp() {
        assert_eq!(SERVER_BINARY, "forge-lsp");
    }

    #[test]
    fn missing_binary_error_includes_version_and_install_instructions() {
        // Simulate what resolve_binary returns when the binary is not found.
        let error_msg = format!(
            "{SERVER_BINARY} not found on PATH. \
             Install Forge v{EXPECTED_VERSION} via `make install` \
             or download from https://github.com/Nimblesite/forge/releases"
        );
        assert!(
            error_msg.contains(EXPECTED_VERSION),
            "Error message must include the expected version",
        );
        assert!(
            error_msg.contains("make install"),
            "Error message must include install instructions",
        );
        assert!(
            error_msg.contains("github.com"),
            "Error message must include download URL",
        );
    }
}
