//! What an opened document is, decided before any workspace is created: its
//! extension plus the project cone, never its content. Implements
//! [SCRIPT-DETECT].

use std::path::Path;

use crate::paths;

/// The compiler engine that reads a document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// Roslyn.
    CSharp,
    /// FSharp.Compiler.Service.
    FSharp,
}

/// The one kind every opened document resolves to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentKind {
    /// A project or solution in its cone owns it. [SCRIPT-CONE]
    ProjectOwned(Engine),
    /// A `.cs` no project owns: a file-based app.
    CSharpFileBasedApp,
    /// A `.csx`; never project-owned.
    CSharpScript,
    /// A `.fsx` or `.fsscript`; never project-owned.
    FSharpScript,
    /// A `.fs` no project owns, checked in its own context like a script.
    FSharpLooseSource,
    /// A `.fsi` no project owns: syntax-only. [SCRIPT-FSX-FSI]
    FSharpSignature,
    /// Anything else; it never initializes or latches a workspace.
    Unsupported,
}

impl DocumentKind {
    /// Classify `document`, searching its cone no further than `workspace_root`.
    pub fn of(document: &Path, workspace_root: Option<&Path>) -> Self {
        let owned = || paths::cone_owner(document, workspace_root).is_some();
        match paths::extension_key(document).as_deref() {
            Some("CSX") => Self::CSharpScript,
            Some("FSX" | "FSSCRIPT") => Self::FSharpScript,
            Some("CS") if owned() => Self::ProjectOwned(Engine::CSharp),
            Some("CS") => Self::CSharpFileBasedApp,
            Some("FS" | "FSI") if owned() => Self::ProjectOwned(Engine::FSharp),
            Some("FS") => Self::FSharpLooseSource,
            Some("FSI") => Self::FSharpSignature,
            _ => Self::Unsupported,
        }
    }

    /// The engine that opens a workspace for this kind; none for a document
    /// no compiler reads.
    pub const fn engine(self) -> Option<Engine> {
        match self {
            Self::ProjectOwned(engine) => Some(engine),
            Self::CSharpFileBasedApp | Self::CSharpScript => Some(Engine::CSharp),
            Self::FSharpScript | Self::FSharpLooseSource => Some(Engine::FSharp),
            Self::FSharpSignature | Self::Unsupported => None,
        }
    }
}

#[cfg(test)]
#[path = "document_kind_tests.rs"]
mod tests;
