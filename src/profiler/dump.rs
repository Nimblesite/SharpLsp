//! Memory dump collection via `dotnet-dump collect`.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::info;

use super::tool_discovery;

/// Parameters for collecting a memory dump.
#[derive(Debug, Deserialize)]
pub struct CollectDumpParams {
    pub pid: u32,
    #[serde(default = "default_dump_type")]
    pub dump_type: String,
    pub output_path: Option<String>,
}

/// Result of dump collection.
#[derive(Debug, Serialize)]
pub struct CollectDumpResult {
    pub output_path: String,
    pub file_size_bytes: u64,
}

/// Collect a memory dump from a running .NET process.
pub async fn collect(params: CollectDumpParams) -> Result<CollectDumpResult> {
    let tool = tool_discovery::require_dump()?;

    let output_path = params
        .output_path
        .unwrap_or_else(|| format!(".forge/profiles/dump-{}.dmp", params.pid));

    ensure_output_dir(&output_path)?;

    info!(
        pid = params.pid,
        dump_type = %params.dump_type,
        output = %output_path,
        "Collecting memory dump"
    );

    let output = tokio::process::Command::new(tool)
        .args(["collect", "-p"])
        .arg(params.pid.to_string())
        .args(["--type", &params.dump_type])
        .args(["-o", &output_path])
        .output()
        .await
        .context("failed to run dotnet-dump collect")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("dotnet-dump collect failed: {stderr}");
    }

    let file_size_bytes = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    info!(
        output = %output_path,
        size_bytes = file_size_bytes,
        "Memory dump collected"
    );

    Ok(CollectDumpResult {
        output_path,
        file_size_bytes,
    })
}

fn ensure_output_dir(path: &str) -> Result<()> {
    if let Some(parent) = PathBuf::from(path).parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create output dir: {}", parent.display()))?;
    }
    Ok(())
}

fn default_dump_type() -> String {
    "Heap".to_string()
}
