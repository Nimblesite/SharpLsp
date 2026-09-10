//! Editor-independent exception policy. Implements [CONFIG-DEBUG-EXCEPTIONS].
use serde::{Deserialize, Serialize};

/// Debugger settings shared by every editor.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct DebugConfig {
    /// Exception breakpoint selection and presentation.
    pub exceptions: ExceptionConfig,
}

/// Exception policy. Ignoring a type never suppresses a terminal unhandled stop.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ExceptionConfig {
    /// Ignore first-chance throws in non-user code; terminal exceptions still stop.
    pub just_my_code: bool,
    /// When exception breakpoints fire; editor preserves client checkboxes.
    pub break_on: ExceptionBreakOn,
    /// Exact, fully qualified CLR type names excluded from selected filters.
    pub ignore: Vec<String>,
    /// Where an external exception is presented in the call stack.
    pub external_code: ExternalExceptionCode,
}

impl Default for ExceptionConfig {
    fn default() -> Self {
        Self {
            just_my_code: true,
            break_on: ExceptionBreakOn::default(),
            ignore: Vec::new(),
            external_code: ExternalExceptionCode::default(),
        }
    }
}

/// Supported breakpoint modes, independent of any editor's checkbox labels.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExceptionBreakOn {
    /// Preserve the DAP client's exception selection.
    #[default]
    Editor,
    /// Stop on all throws, including exceptions handled later.
    All,
    /// Stop when an exception escapes user code (requires Just My Code).
    UserUnhandled,
    /// Stop only on terminal unhandled exceptions.
    Unhandled,
}

/// The first visible frame for exceptions thrown by code outside the workspace.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalExceptionCode {
    /// Show the original throwing frame, including library internals.
    #[default]
    ThrowSite,
    /// Present the nearest user caller; preserve the original exception details.
    UserBoundary,
}
