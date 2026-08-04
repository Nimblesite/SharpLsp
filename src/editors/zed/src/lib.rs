mod pipeline;
mod project;
mod solution;
mod tree;

use zed_extension_api::{self as zed};

/// SharpLsp Zed extension — provides sharplsp for C# and F# development.
struct SharpLspExtension {
    cached_binary_path: Option<String>,
}

const SERVER_BINARY: &str = "sharplsp";
const EXPECTED_VERSION: &str = env!("CARGO_PKG_VERSION");
const SLASH_CMD_TREE: &str = "sharplsp-tree";

impl zed::Extension for SharpLspExtension {
    fn new() -> Self {
        SharpLspExtension {
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
                label: "path/to/Solution.slnx".to_string(),
                new_text: "Solution.slnx".to_string(),
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

zed::register_extension!(SharpLspExtension);

// ── Server binary resolution ────────────────────────────────────

impl SharpLspExtension {
    /// Resolve the sharplsp binary path.
    ///
    /// Priority:
    ///   1. Cached path from a previous successful resolution
    ///   2. Binary on `$PATH` (via worktree.which)
    ///
    /// NOTE: The Zed extension API (WASM sandbox) does not support running
    /// subprocesses, so we cannot execute `sharplsp --version` to verify
    /// the binary version matches the extension version. Version validation
    /// relies on the LSP server reporting its version during initialization.
    fn resolve_binary(&mut self, worktree: &zed::Worktree) -> zed::Result<String> {
        cached_or(&mut self.cached_binary_path, || {
            worktree.which(SERVER_BINARY)
        })
    }
}

/// Return the cached path, otherwise look one up and cache it.
///
/// Split from `resolve_binary` because `zed::Worktree` exists only inside Zed's
/// WASM host: the caching contract is testable, the `which` call is not.
fn cached_or(
    cache: &mut Option<String>,
    lookup: impl FnOnce() -> Option<String>,
) -> zed::Result<String> {
    if let Some(path) = cache {
        return Ok(path.clone());
    }

    let path = lookup().ok_or_else(missing_binary_error)?;
    *cache = Some(path.clone());
    Ok(path)
}

/// The message shown when `sharplsp` is absent from `$PATH`. Zed surfaces this
/// verbatim, and it is the only install guidance a Zed user ever sees.
fn missing_binary_error() -> String {
    format!(
        "{SERVER_BINARY} not found on PATH. \
         Install SharpLsp v{EXPECTED_VERSION} via `make install` \
         or download from https://github.com/Nimblesite/SharpLsp/releases"
    )
}

/// Build environment variables for the sharplsp server process.
fn build_server_env(worktree: &zed::Worktree) -> Vec<(String, String)> {
    with_default_log_level(worktree.shell_env())
}

/// The server logs through `tracing`, which emits nothing without `RUST_LOG`.
/// A shell that already sets it keeps its own value.
fn with_default_log_level(mut env: Vec<(String, String)>) -> Vec<(String, String)> {
    if !env.iter().any(|(key, _)| key == "RUST_LOG") {
        env.push(("RUST_LOG".to_string(), "info".to_string()));
    }
    env
}

// ── Slash command: sharplsp-tree ───────────────────────────────────

fn run_tree_command(
    args: Vec<String>,
    worktree: Option<&zed::Worktree>,
) -> zed::Result<zed::SlashCommandOutput> {
    let wt = worktree.ok_or("No worktree available")?;

    let sln_path = args
        .first()
        .ok_or("Usage: /sharplsp-tree <path/to/Solution.sln|Solution.slnx>")?;

    let sln_content = wt
        .read_text_file(sln_path)
        .map_err(|err| format!("Failed to read {}: {}", sln_path, err))?;

    let text = pipeline::solution_tree(sln_path, &sln_content, |path| wt.read_text_file(path).ok());

    Ok(tree_output(sln_path, text))
}

/// Wrap the rendered tree in the single labelled section Zed renders.
fn tree_output(sln_path: &str, text: String) -> zed::SlashCommandOutput {
    let section = zed::SlashCommandOutputSection {
        range: (0..text.len()).into(),
        label: format!("Solution: {}", sln_path),
    };
    zed::SlashCommandOutput {
        text,
        sections: vec![section],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// The top-level `version` declared in `extension.toml`, parsed as TOML
    /// rather than scraped, so a moved or commented-out key is not mistaken for
    /// a match.
    fn manifest_version() -> Option<String> {
        include_str!("../extension.toml")
            .parse::<toml::Table>()
            .ok()?
            .get("version")?
            .as_str()
            .map(str::to_owned)
    }

    /// `make _stamp-version` rewrites the version in BOTH `Cargo.toml` and
    /// `extension.toml`. Zed reads the latter; `EXPECTED_VERSION` — which the
    /// install message quotes — comes from the former. If a release stamps one
    /// and misses the other, the marketplace listing and the version the
    /// extension tells users to install disagree, and nothing else in the
    /// pipeline compares them.
    #[test]
    fn extension_toml_version_matches_crate_version() {
        assert_eq!(
            manifest_version().as_deref(),
            Some(EXPECTED_VERSION),
            "extension.toml and Cargo.toml versions must be stamped together",
        );
    }

    #[test]
    fn crate_version_is_numeric_and_dotted() {
        let segments: Vec<&str> = EXPECTED_VERSION.split('.').collect();
        assert!(
            segments.len() >= 2,
            "version needs at least X.Y segments, got {EXPECTED_VERSION}",
        );
        for segment in &segments {
            assert!(
                segment.parse::<u32>().is_ok(),
                "every segment must be numeric, got {segment} in {EXPECTED_VERSION}",
            );
        }
    }

    #[test]
    fn a_resolved_binary_is_returned_and_cached() {
        let mut cache = None;

        let resolved = cached_or(&mut cache, || Some("/usr/local/bin/sharplsp".to_owned()));

        assert_eq!(resolved, Ok("/usr/local/bin/sharplsp".to_owned()));
        assert_eq!(cache.as_deref(), Some("/usr/local/bin/sharplsp"));
    }

    /// The cache exists to keep `Worktree::which` off the hot path. If a second
    /// resolve still looked up, the cache would be decorative.
    #[test]
    fn a_cached_binary_is_not_looked_up_again() {
        let mut cache = Some("/cached/sharplsp".to_owned());
        let looked_up = Cell::new(false);

        let resolved = cached_or(&mut cache, || {
            looked_up.set(true);
            Some("/fresh/sharplsp".to_owned())
        });

        assert_eq!(resolved, Ok("/cached/sharplsp".to_owned()));
        assert!(
            !looked_up.get(),
            "the cached path must short-circuit lookup"
        );
    }

    /// This asserts on the message `cached_or` actually produces. The previous
    /// test rebuilt the string itself and so could not have caught a change to
    /// the real one.
    #[test]
    fn an_absent_binary_reports_the_install_guidance() {
        let mut cache = None;

        let resolved = cached_or(&mut cache, || None);

        let Err(message) = resolved else {
            panic!("a missing binary must not resolve");
        };
        assert!(message.contains(SERVER_BINARY), "{message}");
        assert!(message.contains(EXPECTED_VERSION), "{message}");
        assert!(message.contains("make install"), "{message}");
        assert!(
            message.contains("github.com/Nimblesite/SharpLsp"),
            "{message}"
        );
        assert!(cache.is_none(), "a failed lookup must not poison the cache");
    }

    #[test]
    fn a_shell_without_rust_log_gets_the_default_level() {
        let env = with_default_log_level(vec![("PATH".to_owned(), "/usr/bin".to_owned())]);

        assert!(
            env.contains(&("RUST_LOG".to_owned(), "info".to_owned())),
            "{env:?}"
        );
    }

    #[test]
    fn a_shell_with_rust_log_keeps_its_own_level() {
        let env = with_default_log_level(vec![("RUST_LOG".to_owned(), "trace".to_owned())]);

        assert_eq!(env, vec![("RUST_LOG".to_owned(), "trace".to_owned())]);
    }

    /// Zed highlights the section by byte range. A range short of the text
    /// leaves the tail unlabelled; one past it is out of bounds.
    #[test]
    fn the_output_section_spans_the_whole_tree() {
        let text = "Solution: App.slnx\n└ Project: Api (Api.csproj)\n".to_owned();

        let output = tree_output("App.slnx", text.clone());

        assert_eq!(output.text, text);
        assert_eq!(output.sections.len(), 1);
        assert_eq!(output.sections[0].label, "Solution: App.slnx");
        assert_eq!(output.sections[0].range.start, 0);
        assert_eq!(u64::from(output.sections[0].range.end), text.len() as u64);
    }
}
