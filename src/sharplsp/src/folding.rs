//! Folding ranges (`textDocument/foldingRange`), computed in Rust from the
//! tree-sitter parse tree for C# and F# alike: the syntax-only tier of
//! [SHARPLSP-ARCHITECTURE-ROUTING].

use lsp_types::{FoldingRange, FoldingRangeKind};
use tree_sitter::{Node, Tree};

use crate::utils::usize_to_u32;

/// Compute folding ranges from a tree-sitter parse tree.
///
/// A declaration or a multi-line comment folds on its own shape, from the
/// recursive walk. Everything else spans SIBLINGS - a `#region` closed by a
/// later `#endregion`, a run of adjacent `using`/`open` directives, a run of
/// comment lines - so those are paired from a flat, document-ordered collection.
pub fn folding_ranges(tree: &Tree, source: &str) -> Vec<FoldingRange> {
    let root = tree.root_node();
    let mut ranges = Vec::new();
    collect_folding(root, &mut ranges);
    let lines: Vec<&str> = source.lines().collect();
    let mut spans = Spans::default();
    collect_spans(root, &lines, &mut spans);
    ranges.extend(region_ranges(&spans.regions));
    ranges.extend(run_ranges(&spans.imports, FoldingRangeKind::Imports));
    ranges.extend(run_ranges(&spans.comments, FoldingRangeKind::Comment));
    ranges
}

/// One directive's position, as `(start row, end row, end column)`.
type Marker = (usize, usize, usize);

/// The sibling-spanning directives, in document order.
#[derive(Default)]
struct Spans {
    /// `#region` (true) and `#endregion` (false) markers, interleaved.
    regions: Vec<(bool, Marker)>,
    /// `using` / `open` directives.
    imports: Vec<Marker>,
    /// One-line comments that start their own line: C# `//` and `///`, F# `//`
    /// and `///`. The grammars emit one node PER LINE, so a doc block is only
    /// visible as a run of them (GitHub #219).
    comments: Vec<Marker>,
}

/// Collect every directive and comment line a sibling-spanning fold is built from.
fn collect_spans(node: Node<'_>, lines: &[&str], spans: &mut Spans) {
    let marker = (
        node.start_position().row,
        node.end_position().row,
        node.end_position().column,
    );
    match node.kind() {
        "preproc_region" => spans.regions.push((true, marker)),
        "preproc_endregion" => spans.regions.push((false, marker)),
        "using_directive" | "import_decl" => spans.imports.push(marker),
        "comment" | "line_comment" | "xml_doc" => {
            spans.comments.extend(comment_line(node, lines));
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_spans(child, lines, spans);
    }
}

/// A comment that is one whole line of its own, as a marker on that line.
///
/// A multi-line `/* */` folds on its own shape instead, and a comment trailing
/// code is no comment BLOCK: two of them on consecutive lines would otherwise
/// fold, and collapsing that fold hides the code. A node that runs on to the
/// start of the next row still ends on its own row.
fn comment_line(node: Node<'_>, lines: &[&str]) -> Option<Marker> {
    let (start, end) = (node.start_position(), node.end_position());
    let spills_onto_next_row = end.column == 0 && end.row == start.row + 1;
    let line = lines.get(start.row)?;
    let own_line = line.get(..start.column)?.trim().is_empty();
    ((end.row == start.row || spills_onto_next_row) && own_line).then_some((
        start.row,
        start.row,
        line.len(),
    ))
}

/// Pair each `#region` with the `#endregion` that closes it.
///
/// A stack, so nested regions pair innermost-first the way the compiler reads
/// them. An unclosed `#region` folds nothing - the user is mid-edit, and a fold
/// running to the end of the file would collapse the rest of their work.
fn region_ranges(markers: &[(bool, Marker)]) -> Vec<FoldingRange> {
    let mut open: Vec<Marker> = Vec::new();
    let mut ranges = Vec::new();
    for (is_open, marker) in markers {
        if *is_open {
            open.push(*marker);
        } else if let Some(start) = open.pop() {
            // The fold ends ON the `#endregion` line. The directive node runs
            // to the start of the next row, so its END row is one line past the
            // text the user sees, and folding to it would swallow the line
            // below the region.
            ranges.push(span(start.0, marker.0, None, FoldingRangeKind::Region));
        }
    }
    ranges
}

/// One fold of `kind` per RUN of adjacent markers: import directives, or
/// comment lines.
///
/// Adjacent means consecutive rows: a blank line or any other statement ends
/// the run, so a second `using` block below a namespace folds as its own header
/// rather than being swallowed into the first.
fn run_ranges(markers: &[Marker], kind: FoldingRangeKind) -> Vec<FoldingRange> {
    let mut ranges = Vec::new();
    let mut run: Option<(Marker, Marker)> = None;
    for marker in markers {
        run = match run {
            Some((first, last)) if marker.0 == last.1 + 1 => Some((first, *marker)),
            Some((first, last)) => {
                ranges.extend(span_over_run(first, last, kind.clone()));
                Some((*marker, *marker))
            }
            None => Some((*marker, *marker)),
        };
    }
    if let Some((first, last)) = run {
        ranges.extend(span_over_run(first, last, kind));
    }
    ranges
}

/// The fold for one run, when the run actually spans more than a line.
fn span_over_run(first: Marker, last: Marker, kind: FoldingRangeKind) -> Option<FoldingRange> {
    (first.0 < last.1).then(|| span(first.0, last.1, Some(usize_to_u32(last.2)), kind))
}

/// A fold over whole lines, optionally stopping at a column on the last one.
fn span(
    start_row: usize,
    end_row: usize,
    end_character: Option<u32>,
    kind: FoldingRangeKind,
) -> FoldingRange {
    FoldingRange {
        start_line: usize_to_u32(start_row),
        start_character: Some(0),
        end_line: usize_to_u32(end_row),
        end_character,
        kind: Some(kind),
        collapsed_text: None,
    }
}

/// Recursively collect folding ranges from tree-sitter nodes.
fn collect_folding(node: Node<'_>, ranges: &mut Vec<FoldingRange>) {
    let kind = fold_kind(node);
    if kind.is_some() || is_structural(node.kind()) {
        let start = node.start_position();
        let end = node.end_position();
        if start.row < end.row {
            ranges.push(FoldingRange {
                start_line: usize_to_u32(start.row),
                start_character: Some(usize_to_u32(start.column)),
                end_line: usize_to_u32(end.row),
                end_character: Some(usize_to_u32(end.column)),
                kind,
                collapsed_text: None,
            });
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_folding(child, ranges);
    }
}

/// The LSP kind a node's own fold carries, when it carries one at all.
///
/// LSP 3.17 defines exactly three kinds, and `region` names a range the USER
/// marked out with `#region` — not every brace pair. Tagging declarations
/// `region` made "collapse the region" collapse the enclosing class and left an
/// editor unable to tell the two apart, so a structural fold carries NO kind,
/// which is what every other server does.
fn fold_kind(node: Node<'_>) -> Option<FoldingRangeKind> {
    // A comment that spans lines itself: C# `/* */`, F# `(* *)`. One-line
    // comments — `//`, `///` — fold as runs instead (`comment_line`).
    match node.kind() {
        "comment" | "block_comment" if node.start_position().row != node.end_position().row => {
            Some(FoldingRangeKind::Comment)
        }
        _ => None,
    }
}

/// Whether a node folds on its own shape: a body, a block, a declaration.
fn is_structural(kind: &str) -> bool {
    matches!(
        kind,
        // C# blocks / braces
        "class_declaration"
        | "struct_declaration"
        | "interface_declaration"
        | "enum_declaration"
        | "namespace_declaration"
        | "method_declaration"
        | "constructor_declaration"
        | "block"
        | "switch_body"
        | "record_declaration"
        // F# declarations (tree-sitter-fsharp). F# is a first-class citizen:
        // the same tree-sitter foldingRange contract covers both languages
        // ([SHARPLSP-SPEC] syntax-only table; CLAUDE.md aim #2). Only the
        // outer `type_definition` folds, not its inner record/union/etc.
        // defn, and a let-binding folds as its `function_or_value_defn` —
        // module-level lets are not wrapped in a `value_declaration`, so
        // that node only exists in some contexts and folding it here would
        // double-fold the same span there.
        | "named_module"
        | "module_defn"
        | "namespace"
        | "type_definition"
        | "type_extension"
        | "function_or_value_defn"
    )
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;
    use crate::tree_sitter_parse::{LangId, TsParsers};

    /// Every fold of `source` as `(start line, end line, kind)`.
    fn folds(lang: LangId, source: &str) -> Vec<(u32, u32, Option<FoldingRangeKind>)> {
        let tree = TsParsers::new().parse(lang, source, None).unwrap();
        folding_ranges(&tree, source)
            .into_iter()
            .map(|range| (range.start_line, range.end_line, range.kind))
            .collect()
    }

    fn comment_folds(lang: LangId, source: &str) -> Vec<(u32, u32)> {
        folds(lang, source)
            .into_iter()
            .filter(|(_, _, kind)| *kind == Some(FoldingRangeKind::Comment))
            .map(|(start, end, _)| (start, end))
            .collect()
    }

    /// tree-sitter-fsharp emits one `xml_doc` node per `///` line, so a
    /// multi-line guard on the node never saw a doc block (GitHub #219).
    #[test]
    fn a_run_of_fsharp_doc_lines_folds_as_one_comment() {
        let source = "module M\n\n/// Computes the area.\n/// Of a square.\n/// Exactly.\nlet area x = x * x\n";
        assert_eq!(comment_folds(LangId::FSharp, source), vec![(2, 4)]);
    }

    #[test]
    fn a_run_of_csharp_doc_lines_folds_as_one_comment() {
        let source = "class C\n{\n    /// <summary>\n    /// Area.\n    /// </summary>\n    int Area() => 1;\n}\n";
        assert_eq!(comment_folds(LangId::CSharp, source), vec![(2, 4)]);
    }

    #[test]
    fn fsharp_line_comments_fold_by_run_and_a_blank_line_ends_the_run() {
        let source = "module M\n// one\n// two\n\n// three\n// four\nlet x = 1\n";
        assert_eq!(comment_folds(LangId::FSharp, source), vec![(1, 2), (4, 5)]);
    }

    /// A lone doc line has nothing to collapse, and comments TRAILING code on
    /// consecutive lines are not a comment block: folding them would hide code.
    #[test]
    fn a_single_doc_line_and_trailing_comments_never_fold() {
        let source = "class C\n{\n    int a = 1; // one\n    int b = 2; // two\n    /// only line\n    void M() { }\n}\n";
        assert_eq!(
            comment_folds(LangId::CSharp, source),
            Vec::<(u32, u32)>::new()
        );
    }
}
