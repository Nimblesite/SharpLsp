//! Shared utility functions used across multiple modules.

use anyhow::Result;
use lsp_types::{Position, Range, TextEdit, Uri};
use tracing::warn;

use crate::sidecar::manager::SidecarManager;

/// Request identifying a position in a file, sent to a sidecar. Serialized as a
/// positional `MessagePack` array `(file_path, line, character)` matching the
/// sidecars' `PositionRequest` Key layout.
#[derive(serde::Serialize)]
pub struct SidecarPositionReq {
    /// Absolute path to the source file.
    pub file_path: String,
    /// Zero-based line number.
    pub line: u32,
    /// Zero-based character offset within the line.
    pub character: u32,
}

impl SidecarPositionReq {
    /// The request for `position` in the document at `uri`.
    pub fn at(uri: &Uri, position: Position) -> Result<Self> {
        Ok(Self {
            file_path: crate::paths::uri_to_path(uri.as_str())?,
            line: position.line,
            character: position.character,
        })
    }
}

/// Run `handle` over `req`'s params when a sidecar is attached, and answer
/// `null` when none is: a request the sidecar would serve has nothing to say
/// without it. The params are only read once a sidecar is known to exist.
pub fn with_sidecar<P: serde::de::DeserializeOwned>(
    req: lsp_server::Request,
    sidecar: Option<&std::sync::Arc<SidecarManager>>,
    handle: impl FnOnce(&SidecarManager, P) -> Result<serde_json::Value>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        tracing::debug!(method = %req.method, "no sidecar available; answering null");
        return Ok(serde_json::Value::Null);
    };
    handle(sidecar, serde_json::from_value(req.params)?)
}

/// Send `request` to the sidecar as `method` and decode its answer.
///
/// `Ok(None)` when the sidecar call itself fails: the handler then answers with
/// its method's empty value, because a sidecar that is still loading — or has
/// crashed — must degrade the feature, never fail the LSP request.
pub fn request_sidecar<T: serde::de::DeserializeOwned, R: serde::Serialize>(
    runtime: &tokio::runtime::Runtime,
    sidecar: &SidecarManager,
    method: &str,
    request: &R,
) -> Result<Option<T>> {
    let payload = rmp_serde::to_vec(request)?;
    match runtime.block_on(sidecar.request(method, payload)) {
        Ok(bytes) => Ok(Some(rmp_serde::from_slice(&bytes)?)),
        Err(err) => {
            warn!(method, error = %format_args!("{err:#}"), "sidecar request unavailable");
            Ok(None)
        }
    }
}

/// Request identifying a whole file, sent to a sidecar. Serialized as a
/// positional `MessagePack` array `(file_path)` matching the sidecars'
/// `FileRequest` Key layout.
#[derive(serde::Serialize)]
pub struct SidecarFileReq {
    /// Absolute path to the source file.
    pub file_path: String,
}

/// A text edit returned by the sidecar in flat-coordinate form. Shared by the
/// formatting, code-action, and completion-resolve flows, which deserialize it
/// and map it into an LSP [`TextEdit`].
#[derive(serde::Deserialize)]
pub struct SidecarTextEdit {
    /// Start line of the range to replace.
    pub start_line: u32,
    /// Start character offset within the start line.
    pub start_character: u32,
    /// End line of the range to replace.
    pub end_line: u32,
    /// End character offset within the end line.
    pub end_character: u32,
    /// Replacement text to insert at the range.
    pub new_text: String,
}

/// Convert a sidecar text edit into an LSP [`TextEdit`].
pub fn map_text_edit(edit: &SidecarTextEdit) -> TextEdit {
    TextEdit {
        range: Range::new(
            Position::new(edit.start_line, edit.start_character),
            Position::new(edit.end_line, edit.end_character),
        ),
        new_text: edit.new_text.clone(),
    }
}

/// Convert a slice of sidecar text edits into LSP [`TextEdit`]s.
pub fn map_text_edits(edits: &[SidecarTextEdit]) -> Vec<TextEdit> {
    edits.iter().map(map_text_edit).collect()
}

/// Windows `CREATE_NO_WINDOW` process-creation flag. Without it, every child
/// process (sidecars, dotnet invocations, profiler tools) flashes a console
/// window when the host itself runs without one (i.e. launched by an editor).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the child's console window on Windows. No-op elsewhere.
pub fn hide_console_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Suppress the child's console window on Windows. No-op elsewhere.
pub fn hide_console_window_tokio(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        let _ = command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Safely convert `usize` to `u32`, clamping to `u32::MAX` on overflow.
pub fn usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_text_edit_translates_range_and_text() {
        let edit = SidecarTextEdit {
            start_line: 1,
            start_character: 2,
            end_line: 3,
            end_character: 4,
            new_text: "x".to_string(),
        };
        let mapped = map_text_edit(&edit);
        assert_eq!(mapped.range.start, Position::new(1, 2));
        assert_eq!(mapped.range.end, Position::new(3, 4));
        assert_eq!(mapped.new_text, "x");
    }
}
