//! Shared utility functions used across multiple modules.

use anyhow::{Context, Result};

/// Convert a `file://` URI string to a filesystem path string.
pub fn uri_to_path(uri: &str) -> Result<String> {
    uri.strip_prefix("file://")
        .map(String::from)
        .context("expected file:// URI")
}

/// Safely convert `usize` to `u32`, clamping to `u32::MAX` on overflow.
pub fn usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
