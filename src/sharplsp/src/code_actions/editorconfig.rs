//! Lossless `.editorconfig` CST parser and writer. Implements [FIXALL-ENFORCE].
//!
//! Comments, blank lines, ordering, and unrelated keys survive every edit.

use std::path::{Path, PathBuf};

/// One physical line of an `.editorconfig` file, kept losslessly.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Line {
    Blank(String),
    Comment(String),
    Section {
        raw: String,
        header: String,
    },
    Entry {
        raw: String,
        key: String,
        value: String,
    },
}

impl Line {
    fn as_str(&self) -> &str {
        match self {
            Self::Blank(raw)
            | Self::Comment(raw)
            | Self::Section { raw, .. }
            | Self::Entry { raw, .. } => raw,
        }
    }
}

/// Lossless `.editorconfig` syntax tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorConfigDoc {
    lines: Vec<Line>,
    trailing_newline: bool,
}

impl EditorConfigDoc {
    /// Parse an `.editorconfig` document without losing comments or whitespace.
    pub fn parse(text: &str) -> Self {
        let trailing_newline = text.ends_with('\n');
        let lines = text.lines().map(parse_line).collect();
        Self {
            lines,
            trailing_newline,
        }
    }

    /// Render back to source text. Unmodified documents round-trip byte-for-byte.
    pub fn render(&self) -> String {
        let mut out = self
            .lines
            .iter()
            .map(Line::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        if self.trailing_newline && !out.is_empty() {
            out.push('\n');
        }
        out
    }

    /// Whether the preamble (before any `[section]`) declares `root = true`.
    pub fn is_root(&self) -> bool {
        self.lines
            .iter()
            .take_while(|line| !matches!(line, Line::Section { .. }))
            .any(|line| {
                matches!(
                    line,
                    Line::Entry { key, value, .. }
                        if key.eq_ignore_ascii_case("root") && value.eq_ignore_ascii_case("true")
                )
            })
    }

    /// Ensure `root = true` is present in the preamble.
    pub fn ensure_root(&mut self) {
        if self.is_root() {
            return;
        }
        self.lines.insert(
            0,
            Line::Entry {
                raw: "root = true".to_string(),
                key: "root".to_string(),
                value: "true".to_string(),
            },
        );
        self.trailing_newline = true;
    }

    /// Set `key = value` inside `[section]`, updating in place or inserting at the
    /// end of the section (creating `[section]` if missing). Returns `true` if changed.
    pub fn set_key(&mut self, section: &str, key: &str, value: &str) -> bool {
        if let Some((start, end)) = self.section_range(section) {
            return self.upsert_in_range(start, end, key, value);
        }
        self.append_section(section, key, value);
        true
    }

    /// Whether any section in this document declares one of `keys`.
    pub fn defines_any(&self, keys: &[&str]) -> bool {
        self.lines.iter().any(|line| {
            matches!(
                line,
                Line::Entry { key, .. } if keys.iter().any(|wanted| key.eq_ignore_ascii_case(wanted))
            )
        })
    }

    /// Return `(first_body_idx, exclusive_end_idx)` for `[section]`, if present.
    fn section_range(&self, target: &str) -> Option<(usize, usize)> {
        let header_idx = self
            .lines
            .iter()
            .position(|line| matches!(line, Line::Section { header, .. } if header == target))?;
        let body_start = header_idx + 1;
        let body_end = self
            .lines
            .get(body_start..)
            .and_then(|rest| {
                rest.iter()
                    .position(|line| matches!(line, Line::Section { .. }))
            })
            .map_or(self.lines.len(), |offset| body_start + offset);
        Some((body_start, body_end))
    }

    fn upsert_in_range(&mut self, start: usize, end: usize, key: &str, value: &str) -> bool {
        let rendered = format!("{key} = {value}");
        if let Some(slice) = self.lines.get_mut(start..end) {
            for line in slice {
                if let Line::Entry {
                    raw,
                    key: existing_key,
                    value: existing_val,
                } = line
                {
                    if existing_key.eq_ignore_ascii_case(key) {
                        if existing_val == value {
                            return false;
                        }
                        *raw = rendered;
                        *existing_val = value.to_string();
                        return true;
                    }
                }
            }
        }
        let insert_at = self.last_non_blank(start, end);
        self.lines.insert(
            insert_at,
            Line::Entry {
                raw: rendered,
                key: key.to_string(),
                value: value.to_string(),
            },
        );
        self.trailing_newline = true;
        true
    }

    fn last_non_blank(&self, start: usize, end: usize) -> usize {
        (start..end)
            .rev()
            .find(|&idx| {
                self.lines
                    .get(idx)
                    .is_some_and(|line| !matches!(line, Line::Blank(_)))
            })
            .map_or(start, |idx| idx + 1)
    }

    fn append_section(&mut self, section: &str, key: &str, value: &str) {
        if !self.lines.is_empty() && !matches!(self.lines.last(), Some(Line::Blank(_))) {
            self.lines.push(Line::Blank(String::new()));
        }
        self.lines.push(Line::Section {
            raw: format!("[{section}]"),
            header: section.to_string(),
        });
        self.lines.push(Line::Entry {
            raw: format!("{key} = {value}"),
            key: key.to_string(),
            value: value.to_string(),
        });
        self.trailing_newline = true;
    }
}

fn parse_line(raw: &str) -> Line {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Line::Blank(raw.to_string());
    }
    if trimmed.starts_with('#') || trimmed.starts_with(';') {
        return Line::Comment(raw.to_string());
    }
    if let Some(inner) = trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        return Line::Section {
            raw: raw.to_string(),
            header: inner.trim().to_string(),
        };
    }
    if let Some((key, value)) = trimmed.split_once('=') {
        return Line::Entry {
            raw: raw.to_string(),
            key: key.trim().to_string(),
            value: value.trim().to_string(),
        };
    }
    Line::Comment(raw.to_string())
}

/// Resolve the target `.editorconfig`: nearest ancestor with `root = true`,
/// or `<solution_dir>/.editorconfig` if none exists. [FIXALL-ENFORCE]
pub fn resolve_target(solution_dir: &Path) -> PathBuf {
    let mut cursor = Some(solution_dir);
    while let Some(dir) = cursor {
        let candidate = dir.join(".editorconfig");
        if std::fs::read_to_string(&candidate)
            .is_ok_and(|content| EditorConfigDoc::parse(&content).is_root())
        {
            return candidate;
        }
        cursor = dir.parent();
    }
    solution_dir.join(".editorconfig")
}

/// Find nested `.editorconfig` files under `solution_dir` that override any of `keys`.
/// [FIXALL-ENFORCE]
pub fn find_overriding_files(solution_dir: &Path, keys: &[&str]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    collect_overrides(solution_dir, solution_dir, keys, &mut found);
    found.sort();
    found
}

fn collect_overrides(root: &Path, dir: &Path, keys: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let skip = entry
                .file_name()
                .to_str()
                .is_some_and(|n| matches!(n, "bin" | "obj" | "target" | "node_modules" | ".git"));
            if !skip {
                collect_overrides(root, &path, keys, out);
            }
        } else if dir != root
            && entry.file_name() == ".editorconfig"
            && std::fs::read_to_string(&path)
                .is_ok_and(|text| EditorConfigDoc::parse(&text).defines_any(keys))
        {
            out.push(path);
        }
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_comments_blank_lines_and_ordering() {
        let original = "# top comment\nroot = true\n\n[*.cs]\n# keep var\ncsharp_style_var_elsewhere = false\nindent_size = 4\n";
        let mut doc = EditorConfigDoc::parse(original);
        assert_eq!(doc.render(), original);

        assert!(doc.set_key("*.cs", "csharp_style_var_elsewhere", "true:error"));
        assert!(doc.set_key("*.cs", "dotnet_diagnostic.IDE0007.severity", "error"));
        assert!(!doc.set_key("*.cs", "dotnet_diagnostic.IDE0007.severity", "error"));

        let rendered = doc.render();
        assert!(rendered.contains("# top comment\n"));
        assert!(rendered.contains("# keep var\n"));
        assert!(rendered.contains("csharp_style_var_elsewhere = true:error\n"));
        assert!(rendered.contains("indent_size = 4\n"));
        assert!(rendered.contains("dotnet_diagnostic.IDE0007.severity = error\n"));
    }

    #[test]
    fn creates_fsharp_section_and_root_when_absent() {
        let mut doc = EditorConfigDoc::parse("");
        doc.ensure_root();
        assert!(doc.set_key(
            "*.{fs,fsi,fsx}",
            "dotnet_diagnostic.SLSPF0102.severity",
            "error",
        ));
        assert_eq!(
            doc.render(),
            "root = true\n\n[*.{fs,fsi,fsx}]\ndotnet_diagnostic.SLSPF0102.severity = error\n"
        );
    }

    #[test]
    fn detects_overriding_nested_editorconfig() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            nested.join(".editorconfig"),
            "[*.cs]\ndotnet_diagnostic.IDE0007.severity = none\n",
        )
        .unwrap();
        let found = find_overriding_files(tmp.path(), &["dotnet_diagnostic.IDE0007.severity"]);
        assert_eq!(found, vec![nested.join(".editorconfig")]);
    }
}
