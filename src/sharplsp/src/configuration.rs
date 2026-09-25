//! Shared configuration resolution and LSP access. Implements [CONFIG-RESOLUTION].
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};
use lsp_server::{Connection, Message, Request, Response};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::{find_config_file, SharpLspConfig};

/// Merge objects recursively; arrays and scalars replace, including empty arrays.
fn merge(base: &mut Value, overlay: Value) {
    if let (Some(target), Some(source)) = (base.as_object_mut(), overlay.as_object()) {
        for (key, value) in source {
            merge(target.entry(key).or_insert(Value::Null), value.clone());
        }
    } else {
        *base = overlay;
    }
}

/// Read a partial TOML layer without filling defaults that would shadow earlier layers.
fn read_layer(path: &Path) -> Result<Value> {
    let source = std::fs::read_to_string(path)
        .with_context(|| format!("read configuration {}", path.display()))?;
    let value: toml::Value = toml::from_str(&source)
        .with_context(|| format!("parse configuration {}", path.display()))?;
    Ok(serde_json::to_value(value)?)
}

/// Platform-specific personal configuration, separate from editor preferences.
pub(crate) fn user_config_file() -> Option<PathBuf> {
    let root = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
    };
    root.map(|root| root.join("sharplsp").join("config.toml"))
}

/// Resolve layers in precedence order and validate the complete typed configuration.
pub(crate) fn resolve(
    root: &Path,
    user_file: Option<&Path>,
    client: &Value,
    overrides: Value,
) -> Result<Value> {
    ensure!(
        client.is_object() && overrides.is_object(),
        "configuration overrides must be objects"
    );
    let mut value = serde_json::to_value(SharpLspConfig::default())?;
    let files = user_file
        .filter(|path| path.is_file())
        .map(Path::to_path_buf)
        .into_iter()
        .chain(find_config_file(root));
    for file in files {
        merge(&mut value, read_layer(&file)?);
    }
    merge(&mut value, client.clone());
    merge(&mut value, overrides);
    let typed: SharpLspConfig =
        serde_json::from_value(value).context("invalid SharpLsp configuration")?;
    validate(&typed)?;
    Ok(serde_json::to_value(typed)?)
}

/// Reject malformed exception names before passing a type-filter expression to DAP.
fn validate(config: &SharpLspConfig) -> Result<()> {
    for name in &config.debug.exceptions.ignore {
        ensure!(
            name.contains('.')
                && !name.chars().any(char::is_whitespace)
                && !name.contains('!')
                && !name.contains('*'),
            "debug.exceptions.ignore requires exact fully qualified CLR type names: {name}"
        );
    }
    ensure!(
        config.profiler.max_concurrent_sessions > 0,
        "profiler.max_concurrent_sessions must be positive"
    );
    Ok(())
}

/// Resolve request parameters. A scope URI is a workspace directory or project file.
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct ResolveParams {
    /// Optional per-workspace or per-project scope.
    scope_uri: Option<String>,
    /// Explicit per-launch overrides in the shared schema.
    overrides: Option<Value>,
}

/// Server-owned client layer. Files are read on each resolution, so edits never go stale.
pub(crate) struct Configuration {
    /// Default workspace scope from initialize.
    root: PathBuf,
    /// Validated session-level settings from didChangeConfiguration.
    client: Value,
}

impl Configuration {
    /// Start with no editor override, preserving personal and workspace TOML.
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            client: json!({}),
        }
    }

    /// Resolve one scope; this is shared by every editor through JSON-RPC.
    fn effective(&self, params: ResolveParams) -> Result<Value> {
        let root = params
            .scope_uri
            .map(|uri| {
                url::Url::parse(&uri)?
                    .to_file_path()
                    .map_err(|()| anyhow::anyhow!("scopeUri must be a local file URI"))
            })
            .transpose()?
            .unwrap_or_else(|| self.root.clone());
        let directory = if root.is_file() {
            root.parent().unwrap_or(&root)
        } else {
            &root
        };
        resolve(
            directory,
            user_config_file().as_deref(),
            &self.client,
            params.overrides.unwrap_or_else(|| json!({})),
        )
    }

    /// Respond to a configuration request without involving a language sidecar.
    pub(crate) fn respond(&self, request: Request, connection: &Connection) -> Result<()> {
        let result = serde_json::from_value(request.params)
            .map_err(anyhow::Error::from)
            .and_then(|params| self.effective(params));
        let response = match result {
            Ok(value) => Response::new_ok(request.id, value),
            Err(error) => Response::new_err(request.id, -32602, format!("{error:#}")),
        };
        connection.sender.send(Message::Response(response))?;
        Ok(())
    }

    /// Atomically replace client overrides; rejected changes retain the previous layer.
    pub(crate) fn update(&mut self, settings: &Value) -> Result<()> {
        let Some(layer) = settings.get("sharplsp") else {
            return Ok(());
        };
        ensure!(layer.is_object(), "settings.sharplsp must be an object");
        let _ = resolve(&self.root, user_config_file().as_deref(), layer, json!({}))?;
        self.client = layer.clone();
        Ok(())
    }
}

#[cfg(test)]
#[path = "configuration_tests.rs"]
mod tests;
