//! Tree-sitter integration for incremental parsing of C# and F#.

use std::path::Path;

use anyhow::{Context, Result};
use lsp_types::Uri;
use tree_sitter::{Language, Parser, Tree};

use crate::vfs::Vfs;

/// Language identifier for routing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LangId {
    /// C# (.cs files).
    CSharp,
    /// F# (.fs, .fsx, .fsi files).
    FSharp,
    /// Razor (.razor components, .cshtml pages and views). The C# sidecar owns
    /// it, and its Razor compiler is the only parser: there is no tree-sitter
    /// Razor grammar. Implements [RAZOR-ARCHITECTURE-ROUTING].
    Razor,
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
        let path = crate::paths::uri_to_path(raw).unwrap_or_else(|_| raw.to_string());
        Self::from_path(Path::new(&path))
    }

    /// Detect language from a file path.
    pub fn from_path(path: &Path) -> Option<Self> {
        match crate::paths::extension_key(path)?.as_str() {
            "CS" => Some(Self::CSharp),
            "FS" | "FSX" | "FSI" => Some(Self::FSharp),
            "RAZOR" | "CSHTML" => Some(Self::Razor),
            _ => None,
        }
    }

    /// Whether the host parses this language with tree-sitter. Razor has no
    /// grammar, so its syntax features come from the sidecar instead.
    pub const fn has_grammar(self) -> bool {
        !matches!(self, Self::Razor)
    }
}

/// Manages tree-sitter parsers and parse trees.
pub struct TsParsers {
    /// Compiled C# tree-sitter grammar.
    csharp_language: Language,
    /// Compiled F# tree-sitter grammar, for implementation and script files.
    fsharp_language: Language,
}

impl TsParsers {
    /// Create a new parser manager with both grammars loaded.
    pub fn new() -> Self {
        let csharp_language: Language = tree_sitter_c_sharp::LANGUAGE.into();
        let fsharp_language: Language = tree_sitter_fsharp::LANGUAGE_FSHARP.into();
        Self {
            csharp_language,
            fsharp_language,
        }
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
                parser
                    .set_language(&self.fsharp_language)
                    .context("failed to set F# language")?;
            }
            LangId::Razor => anyhow::bail!("Razor has no tree-sitter grammar"),
        }
        parser
            .parse(source, old_tree)
            .context("tree-sitter parse returned None")
    }
}

/// Parse one file addressed by PATH, preferring its live buffer over disk.
///
/// Implements [SE-LIVE-BUFFER]. Every tree-sitter feature that addresses a file
/// by path — Solution Explorer symbols, member sorting, debugger stop
/// classification — needs the same three steps, and getting the live-buffer
/// half wrong analyses the last save instead of what the user is looking at.
/// Sharing it means that can only ever be wrong in one place.
pub fn parse_file(file_path: &str, parsers: &TsParsers, vfs: &Vfs) -> Result<(String, Tree)> {
    let source = vfs.read_live_or_disk(file_path)?;
    let lang = LangId::from_path(Path::new(file_path)).context("unsupported file type")?;
    let tree = parsers.parse(lang, &source, None)?;
    Ok((source, tree))
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

    /// Razor components and Razor pages and views are one language, owned by the
    /// C# sidecar and never parsed by tree-sitter. [RAZOR-ARCHITECTURE-ROUTING]
    #[test]
    fn razor_and_cshtml_files_are_razor_without_a_grammar() {
        let component: Uri = "file:///c:/app/Pages/Counter.razor"
            .parse()
            .expect("valid uri");
        let view: Uri = "file:///c:/app/Views/Home/Index.CSHTML"
            .parse()
            .expect("valid uri");
        assert_eq!(LangId::from_uri(&component), Some(LangId::Razor));
        assert_eq!(LangId::from_uri(&view), Some(LangId::Razor));
        assert!(!LangId::Razor.has_grammar());
        assert!(LangId::CSharp.has_grammar() && LangId::FSharp.has_grammar());
        let parsed = TsParsers::new().parse(LangId::Razor, "<p>@x</p>", None);
        assert!(
            parsed.is_err(),
            "Razor must never reach a tree-sitter parser"
        );
    }
}
