//! Virtual File System — authoritative document state for open files.

use dashmap::DashMap;
use lsp_types::Uri;

use crate::paths::{canonical_native_path, canonical_path, native_paths_equal};

/// Stores the current content of all open documents.
pub struct Vfs {
    /// Concurrent map of open document URIs to their state.
    documents: DashMap<Uri, DocumentState>,
}

/// State of a single open document tracked by the VFS.
pub struct DocumentState {
    /// Full text content of the document.
    pub content: String,
    /// LSP document version counter.
    pub version: i32,
    /// Canonical spelling of the document's native path, resolved once when the
    /// document is opened.
    ///
    /// Editors and sidecars spell the same file differently. VS Code keeps
    /// whatever path the user opened — on Windows frequently the 8.3 short form,
    /// `C:\Users\RUNNER~1\...` — while .NET's `Path.GetFullPath` expands short
    /// names, so the solution model driving Solution Explorer reports
    /// `C:\Users\runneradmin\...`. Neither spelling can be derived from the
    /// other by string manipulation, so the canonical form is resolved here:
    /// once per open, rather than once per lookup. `None` when the URI has no
    /// readable on-disk counterpart, such as an unsaved `untitled:` buffer.
    /// Implements [SE-LIVE-BUFFER] (GitHub #191).
    canonical_path: Option<String>,
}

impl Vfs {
    /// Create an empty VFS.
    pub fn new() -> Self {
        Self {
            documents: DashMap::new(),
        }
    }

    /// Open a document (textDocument/didOpen).
    pub fn open(&self, uri: Uri, version: i32, text: String) {
        let canonical_path = canonical_native_path(&uri);
        let _ = self.documents.insert(
            uri,
            DocumentState {
                content: text,
                version,
                canonical_path,
            },
        );
    }

    /// Apply a full-content change (textDocument/didChange with full sync).
    pub fn change(&self, uri: &Uri, version: i32, text: String) {
        if let Some(mut doc) = self.documents.get_mut(uri) {
            doc.content = text;
            doc.version = version;
        }
    }

    /// Close a document (textDocument/didClose).
    pub fn close(&self, uri: &Uri) {
        let _ = self.documents.remove(uri);
    }

    /// Get the current content of a document.
    pub fn get_content(&self, uri: &Uri) -> Option<String> {
        self.documents.get(uri).map(|d| d.content.clone())
    }

    /// Get the content of an open document identified by its native
    /// filesystem path, regardless of how the editor encoded its URI.
    ///
    /// Editors encode the same file differently — VS Code sends
    /// `file:///c%3A/dir%20name/f.cs` where an RFC 8089 builder produces
    /// `file:///C:/dir%20name/f.cs` — so rebuilding a URI from a path and
    /// matching it as a string misses open documents. Instead each stored
    /// URI is normalized to a native path and the paths are compared.
    /// Implements [SE-LIVE-BUFFER] (GitHub #110).
    pub fn get_content_for_path(&self, path: &str) -> Option<String> {
        self.documents.iter().find_map(|entry| {
            let doc = entry.value();
            document_denotes_path(entry.key(), doc, path).then(|| doc.content.clone())
        })
    }

    /// Like [`Vfs::get_content_for_path`], but retries with the canonicalized
    /// *incoming* path when the direct comparison misses, covering a caller that
    /// spells the path less directly than the editor did — `..` components,
    /// mapped drives, or a short name where the editor held the long one.
    ///
    /// The mirror image, where the editor holds the less direct spelling, is
    /// handled by [`DocumentState::canonical_path`] instead. Both halves are
    /// needed: canonicalizing one side alone leaves the other's alias
    /// unmatched. Implements [SE-LIVE-BUFFER] (GitHub #110, #191).
    pub fn get_content_for_path_canonical(&self, path: &str) -> Option<String> {
        self.get_content_for_path(path)
            .or_else(|| self.get_content_for_path(&canonical_path(path)?))
    }

    /// Read the live buffer for `file_path` when the editor has the document
    /// open (trying canonical path spellings too), else the on-disk text.
    /// Every feature that consumes file content by native path must prefer
    /// the buffer — sorting or analyzing yesterday's save corrupts the
    /// user's unsaved edits. Implements [SE-LIVE-BUFFER] (GitHub #110).
    pub fn read_live_or_disk(&self, file_path: &str) -> anyhow::Result<String> {
        use anyhow::Context;
        if let Some(content) = self.get_content_for_path_canonical(file_path) {
            return Ok(content);
        }
        tracing::trace!("VFS miss for {file_path}, reading from disk");
        std::fs::read_to_string(file_path).with_context(|| format!("read {file_path}"))
    }

    /// Get the current version of a document.
    pub fn get_version(&self, uri: &Uri) -> Option<i32> {
        self.documents.get(uri).map(|d| d.version)
    }

    /// Iterate over all open documents.
    pub fn iter(&self) -> dashmap::iter::Iter<'_, Uri, DocumentState> {
        self.documents.iter()
    }
}

/// Whether an open document denotes the file at `path`.
///
/// Both spellings the VFS knows are compared: the one the editor sent, and the
/// canonical one resolved when the document was opened. Comparing only the
/// editor's spelling misses whenever another component resolved the same file
/// differently — the Windows 8.3 short/long split above all — and the caller
/// then silently analyses stale disk content instead of the live buffer.
/// Implements [SE-LIVE-BUFFER] (GitHub #191).
fn document_denotes_path(uri: &Uri, doc: &DocumentState, path: &str) -> bool {
    let canonical_matches = doc
        .canonical_path
        .as_deref()
        .is_some_and(|canonical| native_paths_equal(canonical, path));

    canonical_matches
        || crate::paths::uri_to_path(uri.as_str())
            .is_ok_and(|doc_path| native_paths_equal(&doc_path, path))
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test code — panics are the correct failure mode"
    )]

    use super::*;

    /// NTFS folds case across Unicode, not only ASCII: `Ärger` and `ärger` name
    /// one directory. Canonicalizing cannot bridge the two spellings when the
    /// file is not on disk — deleted since it was opened, or never saved — so
    /// the comparison itself has to fold `Ä` and `ä`, or the open buffer is
    /// missed and the caller reads a file that is not there. NTFS maps one
    /// UTF-16 unit to one (its `$UpCase` table), so `ß` never equals `SS`.
    /// Implements [SE-LIVE-BUFFER] (GitHub #171).
    #[cfg(windows)]
    #[test]
    fn get_content_for_path_folds_case_beyond_ascii_like_ntfs() {
        let tmp = tempfile::tempdir().unwrap();
        let opened = tmp.path().join("Ärger").join("Übersicht.cs");
        let vfs = Vfs::new();
        let uri: Uri = url::Url::from_file_path(&opened)
            .unwrap()
            .to_string()
            .parse()
            .unwrap();
        vfs.open(uri, 1, "class InBuffer {}".to_string());

        let respelled = tmp.path().join("ärger").join("ÜBERSICHT.cs");
        assert_eq!(
            vfs.get_content_for_path_canonical(&respelled.to_string_lossy())
                .as_deref(),
            Some("class InBuffer {}"),
            "a buffer whose file is not on disk must be found under any NTFS casing"
        );
        assert!(native_paths_equal(
            r"C:\ΣΟΦΙΑ\Ärger.cs",
            r"c:\σοφια\ärger.cs"
        ));
        assert!(!native_paths_equal(r"C:\a\straße.cs", r"C:\a\STRASSE.cs"));
        assert!(!native_paths_equal(r"C:\Ärger\a.cs", r"C:\Arger\a.cs"));
    }

    #[test]
    fn get_content_for_path_canonical_resolves_indirect_spellings() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sub");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Program.cs");
        std::fs::write(&file, "class OnDisk {}").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();

        let vfs = Vfs::new();
        let uri: Uri = url::Url::from_file_path(&canonical)
            .unwrap()
            .to_string()
            .parse()
            .unwrap();
        vfs.open(uri, 1, "buffer text".to_string());

        let indirect = dir.join("..").join("sub").join("Program.cs");
        let found = vfs.get_content_for_path_canonical(&indirect.to_string_lossy());
        assert_eq!(
            found.as_deref(),
            Some("buffer text"),
            "an indirect path spelling must still find the open buffer"
        );
    }

    /// The editor and the sidecar disagree on how to spell the same file. VS
    /// Code keeps a document under the path the user opened it by — on Windows
    /// CI that is the 8.3 short form, `C:\Users\RUNNER~1\...` — while the .NET
    /// solution model returns `Path.GetFullPath`, which expands short names to
    /// `C:\Users\runneradmin\...`. Canonicalizing only the *incoming* path
    /// cannot bridge that: the spelling the editor stored has to be resolved
    /// too. When the lookup misses, `read_live_or_disk` silently falls back to
    /// disk and every feature reading files by path — Solution Explorer above
    /// all — analyses the last save instead of the live buffer.
    ///
    /// A symlink reproduces the same aliasing on platforms without 8.3 names,
    /// so this runs on the Ubuntu shards that gate the suite.
    /// Implements [SE-LIVE-BUFFER] (GitHub #191).
    #[cfg(unix)]
    #[test]
    fn read_live_or_disk_finds_a_buffer_opened_under_an_aliased_path() {
        let tmp = tempfile::tempdir().unwrap();
        let real_dir = tmp.path().join("real");
        std::fs::create_dir_all(&real_dir).unwrap();
        let file = real_dir.join("Program.cs");
        std::fs::write(&file, "class OnDisk {}").unwrap();

        let alias_dir = tmp.path().join("alias");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();

        // The editor opened the document through the alias …
        let vfs = Vfs::new();
        let uri: Uri = url::Url::from_file_path(alias_dir.join("Program.cs"))
            .unwrap()
            .to_string()
            .parse()
            .unwrap();
        vfs.open(uri, 1, "class InBuffer {}".to_string());

        // … while workspace symbols walks the project and finds the real one.
        let found = vfs.read_live_or_disk(&file.to_string_lossy()).unwrap();
        assert_eq!(
            found, "class InBuffer {}",
            "an open buffer must be found under every spelling of its path, or \
             features silently analyse stale disk content"
        );
    }
}
