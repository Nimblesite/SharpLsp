//! Tree-sitter integration for incremental parsing of C# and F#.

use std::path::Path;

use anyhow::{Context, Result};
use lsp_types::Uri;
use tree_sitter::{Language, Parser, Tree};

/// Language identifier for routing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LangId {
    CSharp,
    FSharp,
}

impl LangId {
    /// Detect language from a file URI string.
    pub fn from_uri(uri: &Uri) -> Option<Self> {
        let s = uri.as_str();
        Self::from_path(Path::new(s))
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
    csharp_language: Language,
}

impl TsParsers {
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
