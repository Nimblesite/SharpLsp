//! Tree-sitter integration for incremental parsing of C# and F#.

use std::path::Path;

use anyhow::{Context, Result};
use lsp_types::Uri;
use tree_sitter::{Language, Parser, Tree};

/// Language identifier for routing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LangId {
    /// C# (.cs files).
    CSharp,
    /// F# (.fs, .fsx, .fsi files).
    FSharp,
}

impl LangId {
    /// Detect language from a file URI.
    ///
    /// Decodes the URI through the sanctioned converter first — sniffing the
    /// raw URI string breaks on query suffixes and percent-encoding, silently
    /// routing a document to the wrong sidecar. Falls back to the raw string
    /// for non-`file://` schemes (e.g. `untitled:`) so extension sniffing
    /// still works there. [GitHub #110]
    pub fn from_uri(uri: &Uri) -> Option<Self> {
        let raw = uri.as_str();
        let path = crate::utils::uri_to_path(raw).unwrap_or_else(|_| raw.to_string());
        Self::from_path(Path::new(&path))
    }

    /// Detect language from a file path.
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path.extension()?.to_str()?;
        match ext.to_ascii_lowercase().as_str() {
            "cs" => Some(Self::CSharp),
            "fs" | "fsx" | "fsi" => Some(Self::FSharp),
            _ => None,
        }
    }
}

/// Manages tree-sitter parsers and parse trees.
pub struct TsParsers {
    /// Compiled C# tree-sitter grammar.
    csharp_language: Language,
}

impl TsParsers {
    /// Create a new parser manager with the C# grammar loaded.
    pub fn new() -> Self {
        let csharp_language: Language = tree_sitter_c_sharp::LANGUAGE.into();
        Self { csharp_language }
    }

    /// Parse source code for a given language. Returns the tree-sitter Tree.
    pub fn parse(&self, lang: LangId, source: &str, old_tree: Option<&Tree>) -> Result<Tree> {
        let mut parser = Parser::new();
        match lang {
            LangId::CSharp => {
                parser
                    .set_language(&self.csharp_language)
                    .context("failed to set C# language")?;
            }
            LangId::FSharp => {
                anyhow::bail!("F# tree-sitter grammar not yet integrated");
            }
        }
        parser
            .parse(source, old_tree)
            .context("tree-sitter parse returned None")
    }
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::expect_used,
        reason = "test code — panics are the correct failure mode"
    )]
    use super::*;

    /// Language routing must sniff the extension from the decoded URI path,
    /// not the raw URI string — a query suffix or exotic encoding must not
    /// silently misroute a document to the wrong sidecar. [GitHub #110]
    #[test]
    fn from_uri_decodes_the_uri_before_sniffing_the_extension() {
        let fs_with_query: Uri = "file:///c:/dir/Library.fs?v=2".parse().expect("valid uri");
        assert_eq!(LangId::from_uri(&fs_with_query), Some(LangId::FSharp));

        let encoded_cs: Uri = "file:///c%3A/dir/Program.cs".parse().expect("valid uri");
        assert_eq!(LangId::from_uri(&encoded_cs), Some(LangId::CSharp));

        let unknown: Uri = "file:///c:/dir/readme.txt".parse().expect("valid uri");
        assert_eq!(LangId::from_uri(&unknown), None);
    }
}
