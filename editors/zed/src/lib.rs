mod project;
mod solution;
mod tree;

use zed_extension_api::{self as zed};

/// Forge Zed extension — provides forge-lsp for C# and F# development.
struct ForgeExtension {
    cached_binary_path: Option<String>,
}

const SERVER_BINARY: &str = "forge-lsp";
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
    fn resolve_binary(&mut self, worktree: &zed::Worktree) -> zed::Result<String> {
        if let Some(ref path) = self.cached_binary_path {
            return Ok(path.clone());
        }

        let path = worktree.which(SERVER_BINARY).ok_or_else(|| {
            format!(
                "{} not found on PATH. Install via `cargo install forge-lsp`.",
                SERVER_BINARY
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
