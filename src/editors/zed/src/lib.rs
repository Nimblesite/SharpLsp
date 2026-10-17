//! SharpLsp for Zed: starts the SharpLsp language server for C# and F#.
//! Implements [DIST-ZED-REGISTRY].
mod archive;
#[cfg(test)]
mod fake_host;
mod server;
mod zed_host;

use zed_extension_api::{self as zed, serde_json::json, settings::LspSettings};

use crate::server::LANGUAGE_SERVER;
use crate::zed_host::{lsp_settings, ZedHost};

/// The extension's state: the download resolved earlier in this session.
struct SharpLspExtension {
    cached_download: Option<String>,
}

impl zed::Extension for SharpLspExtension {
    fn new() -> Self {
        SharpLspExtension {
            cached_download: None,
        }
    }

    fn language_server_command(
        &mut self,
        id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        let launch = server::resolve(&ZedHost { id, worktree }, &mut self.cached_download)?;
        Ok(zed::Command {
            command: launch.command,
            args: launch.args,
            env: server_env(worktree.shell_env(), launch.env),
        })
    }

    /// The workspace configuration, sent with `initialize` too, so
    /// `csharp.solution_path` picks the solution before the first open
    /// ([SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH]).
    fn language_server_initialization_options(
        &mut self,
        id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<Option<zed::serde_json::Value>> {
        self.language_server_workspace_configuration(id, worktree)
    }

    fn language_server_workspace_configuration(
        &mut self,
        _id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<Option<zed::serde_json::Value>> {
        Ok(settings_layer(lsp_settings(worktree)))
    }
}

zed::register_extension!(SharpLspExtension);

/// `lsp.sharplsp.settings` uses the `sharplsp.toml` schema; the server reads the
/// client layer from `settings.sharplsp` ([CONFIG-RESOLUTION]).
fn client_layer(settings: zed::serde_json::Value) -> zed::serde_json::Value {
    json!({ LANGUAGE_SERVER: settings })
}

/// The client layer from `lsp.sharplsp.settings`, if any are set.
fn settings_layer(settings: Option<LspSettings>) -> Option<zed::serde_json::Value> {
    settings
        .and_then(|settings| settings.settings)
        .map(client_layer)
}

/// The shell's environment, overridden by `lsp.sharplsp.binary.env`. The server
/// logs through `tracing`, which emits nothing without `RUST_LOG`, so `info`
/// applies unless either source sets a level.
fn server_env(
    shell: Vec<(String, String)>,
    configured: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let overridden = |key: &String| configured.iter().any(|(set, _)| set == key);
    let mut env: Vec<(String, String)> = shell
        .into_iter()
        .filter(|(key, _)| !overridden(key))
        .collect();
    env.extend(configured);
    if !env.iter().any(|(key, _)| key == "RUST_LOG") {
        env.push(("RUST_LOG".to_owned(), "info".to_owned()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(key: &str, value: &str) -> (String, String) {
        (key.to_owned(), value.to_owned())
    }

    #[test]
    fn a_shell_without_rust_log_gets_the_default_level() {
        let env = server_env(vec![pair("PATH", "/usr/bin")], vec![]);

        assert_eq!(env, [pair("PATH", "/usr/bin"), pair("RUST_LOG", "info")]);
    }

    #[test]
    fn a_shell_with_rust_log_keeps_its_own_level() {
        let env = server_env(vec![pair("RUST_LOG", "trace")], vec![]);

        assert_eq!(env, [pair("RUST_LOG", "trace")]);
    }

    /// Settings win over the shell for the same key, keep the rest of the shell,
    /// and can set the log level themselves.
    #[test]
    fn configured_environment_overrides_the_shell() {
        let shell = vec![
            pair("PATH", "/usr/bin"),
            pair("DOTNET_ROOT", "/usr/share/dotnet"),
        ];
        let configured = vec![
            pair("DOTNET_ROOT", "/opt/dotnet"),
            pair("RUST_LOG", "debug"),
        ];

        let env = server_env(shell, configured);

        assert_eq!(
            env,
            [
                pair("PATH", "/usr/bin"),
                pair("DOTNET_ROOT", "/opt/dotnet"),
                pair("RUST_LOG", "debug")
            ]
        );
    }

    /// Zed's `lsp.sharplsp.settings` is the `sharplsp.toml` schema itself; the
    /// server only reads it under `sharplsp`, so an unwrapped object would be ignored.
    #[test]
    fn zed_settings_become_the_servers_client_layer() {
        let settings = json!({"debug": {"exceptions": {"break_on": "all"}}});

        let layer = client_layer(settings.clone());

        assert_eq!(layer["sharplsp"], settings);
        assert_eq!(layer.as_object().map(zed::serde_json::Map::len), Some(1));
        assert_eq!(layer["sharplsp"]["debug"]["exceptions"]["break_on"], "all");
    }

    /// `initialize` and every settings change carry `lsp.sharplsp.settings`
    /// as the client layer, so a chosen solution opens first time; with
    /// nothing set, neither carries a layer.
    /// [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH]
    #[test]
    fn only_lsp_settings_become_the_layer_sent_at_startup() {
        let chosen = json!({"csharp": {"solution_path": "app/App.sln"}});
        let settings = LspSettings {
            initialization_options: Some(json!({"solutionPicker": true})),
            settings: Some(chosen.clone()),
            ..LspSettings::default()
        };

        let layer = settings_layer(Some(settings));

        assert_eq!(layer, Some(json!({"sharplsp": chosen})));
        assert_eq!(settings_layer(Some(LspSettings::default())), None);
        assert_eq!(settings_layer(None), None);
    }
}

/// `extension.toml` against the Zed registry's publishing rules. Parsed as TOML,
/// never scraped, so a moved or commented-out key cannot pass for a match.
#[cfg(test)]
mod manifest_tests {
    use crate::server::{LANGUAGE_SERVER, REPOSITORY};

    fn manifest() -> toml::Table {
        include_str!("../extension.toml")
            .parse()
            .unwrap_or_else(|error| panic!("extension.toml must parse: {error}"))
    }

    fn crate_manifest() -> toml::Table {
        include_str!("../Cargo.toml")
            .parse()
            .unwrap_or_else(|error| panic!("Cargo.toml must parse: {error}"))
    }

    /// The registry entry's `version` must equal the manifest's at the pinned commit,
    /// and the crate is versioned with it so the two can never drift apart.
    #[test]
    fn the_manifest_and_crate_share_one_numeric_version() {
        let version = manifest()["version"].as_str().map(str::to_owned);
        let crate_version = crate_manifest()["package"]["version"]
            .as_str()
            .map(str::to_owned);

        assert_eq!(
            version, crate_version,
            "extension.toml and Cargo.toml must match"
        );
        let version = version.unwrap_or_default();
        let segments: Vec<&str> = version.split('.').collect();
        assert_eq!(segments.len(), 3, "semver X.Y.Z, got {version}");
        assert!(
            segments
                .iter()
                .all(|segment| segment.parse::<u32>().is_ok()),
            "{version}"
        );
    }

    /// Language-server-only extensions are suffixed `-lsp`; no ID may say `zed` or `extension`.
    #[test]
    fn the_id_follows_the_registry_naming_rules() {
        let manifest = manifest();
        let id = manifest["id"].as_str().unwrap_or_default();

        assert!(id.ends_with("-lsp"), "{id}");
        assert!(!id.contains("zed") && !id.contains("extension"), "{id}");
        assert!(
            id.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
            "kebab-case: {id}"
        );
        assert_eq!(manifest["schema_version"].as_integer(), Some(1));
        assert_eq!(
            manifest["repository"].as_str(),
            Some(format!("https://github.com/{REPOSITORY}").as_str())
        );
    }

    /// Zed matches servers to languages by the names the C# and F# extensions define:
    /// `CSharp` and `FSharp`. `C#` or `F#` silently attaches to nothing.
    #[test]
    fn the_server_attaches_to_the_csharp_and_fsharp_languages() {
        let manifest = manifest();
        let server = &manifest["language_servers"][LANGUAGE_SERVER];

        let languages: Vec<&str> = server["languages"]
            .as_array()
            .map(|names| names.iter().filter_map(toml::Value::as_str).collect())
            .unwrap_or_default();
        assert_eq!(languages, ["CSharp", "FSharp"]);
        assert_eq!(server["language_ids"]["CSharp"].as_str(), Some("csharp"));
        assert_eq!(server["language_ids"]["FSharp"].as_str(), Some("fsharp"));
        assert_eq!(server["name"].as_str(), Some("SharpLsp"));
    }

    /// The extension provides a language server and nothing else: grammars belong to
    /// language extensions, and Zed no longer accepts slash commands.
    #[test]
    fn only_a_language_server_is_provided() {
        let manifest = manifest();

        for key in [
            "slash_commands",
            "grammars",
            "context_servers",
            "agent_servers",
        ] {
            assert!(!manifest.contains_key(key), "{key} must not be declared");
        }
        assert_eq!(
            manifest["language_servers"]
                .as_table()
                .map(toml::Table::len),
            Some(1)
        );
    }

    /// Downloads are confined to this repository's releases, the only thing fetched.
    #[test]
    fn downloads_are_limited_to_the_release_repository() {
        let manifest = manifest();
        let capabilities = manifest["capabilities"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        assert_eq!(capabilities.len(), 1, "{capabilities:?}");
        assert_eq!(capabilities[0]["kind"].as_str(), Some("download_file"));
        assert_eq!(capabilities[0]["host"].as_str(), Some("github.com"));
        let path: Vec<&str> = capabilities[0]["path"]
            .as_array()
            .map(|segments| segments.iter().filter_map(toml::Value::as_str).collect())
            .unwrap_or_default();
        let mut expected: Vec<&str> = REPOSITORY.split('/').collect();
        expected.push("**");
        assert_eq!(path, expected);
    }

    /// The registry's CI rejects an extension without an accepted licence in its own
    /// directory; one at the repository root does not count.
    #[test]
    fn the_extension_directory_carries_the_mit_licence() {
        let licence = include_str!("../LICENSE");

        assert!(
            licence.starts_with("MIT License"),
            "{}",
            &licence[..licence.len().min(40)]
        );
        assert!(licence.contains("Permission is hereby granted, free of charge"));
        assert_eq!(
            licence,
            include_str!("../../../../LICENSE"),
            "the repository licence, not a fork of it"
        );
    }
}
