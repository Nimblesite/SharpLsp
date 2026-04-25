//! Postfix completion templates for C# and F#.
//!
//! When the user types `expr.if`, `expr.var`, etc., we offer completion
//! items that wrap the preceding expression in a language-appropriate
//! construct. The items use snippet syntax (`$0` for final cursor).

use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionTextEdit, InsertTextFormat, Position, Range,
    TextEdit,
};

use crate::tree_sitter_parse::LangId;

/// A postfix template definition.
struct Template {
    /// Trigger text (e.g. "if", "var", "not").
    trigger: &'static str,
    /// Label shown in the completion menu.
    label: &'static str,
    /// Detail text explaining the expansion.
    detail: &'static str,
    /// Snippet template for C#. `{expr}` is replaced with the expression.
    csharp_snippet: Option<&'static str>,
    /// Snippet template for F#. `{expr}` is replaced with the expression.
    fsharp_snippet: Option<&'static str>,
}

/// All available postfix templates.
const TEMPLATES: &[Template] = &[
    Template {
        trigger: "if",
        label: ".if",
        detail: "Wrap in if statement",
        csharp_snippet: Some("if ({expr})\n{{\n    $0\n}}"),
        fsharp_snippet: Some("if {expr} then\n    $0"),
    },
    Template {
        trigger: "not",
        label: ".not",
        detail: "Negate expression",
        csharp_snippet: Some("!{expr}"),
        fsharp_snippet: Some("not {expr}"),
    },
    Template {
        trigger: "var",
        label: ".var",
        detail: "Introduce local variable",
        csharp_snippet: Some("var ${1:name} = {expr};$0"),
        fsharp_snippet: Some("let ${1:name} = {expr}\n$0"),
    },
    Template {
        trigger: "null",
        label: ".null",
        detail: "Check for null",
        csharp_snippet: Some("if ({expr} is null)\n{{\n    $0\n}}"),
        fsharp_snippet: Some("if isNull {expr} then\n    $0"),
    },
    Template {
        trigger: "notnull",
        label: ".notnull",
        detail: "Check for not null",
        csharp_snippet: Some("if ({expr} is not null)\n{{\n    $0\n}}"),
        fsharp_snippet: None,
    },
    Template {
        trigger: "for",
        label: ".for",
        detail: "Iterate with for/foreach",
        csharp_snippet: Some("foreach (var ${1:item} in {expr})\n{{\n    $0\n}}"),
        fsharp_snippet: Some("for ${1:item} in {expr} do\n    $0"),
    },
    Template {
        trigger: "forr",
        label: ".forr",
        detail: "Iterate with reverse for loop",
        csharp_snippet: Some("for (var ${1:i} = {expr}.Count - 1; $1 >= 0; $1--)\n{{\n    $0\n}}"),
        fsharp_snippet: None,
    },
    Template {
        trigger: "while",
        label: ".while",
        detail: "Wrap in while loop",
        csharp_snippet: Some("while ({expr})\n{{\n    $0\n}}"),
        fsharp_snippet: Some("while {expr} do\n    $0"),
    },
    Template {
        trigger: "match",
        label: ".match",
        detail: "Pattern match on expression",
        csharp_snippet: Some("switch ({expr})\n{{\n    case $1:\n        $0\n        break;\n}}"),
        fsharp_snippet: Some("match {expr} with\n| ${1:_} -> $0"),
    },
    Template {
        trigger: "return",
        label: ".return",
        detail: "Return expression",
        csharp_snippet: Some("return {expr};"),
        fsharp_snippet: Some("{expr}"),
    },
    Template {
        trigger: "print",
        label: ".print",
        detail: "Print expression",
        csharp_snippet: Some("Console.WriteLine({expr});"),
        fsharp_snippet: Some("printfn \"%A\" {expr}"),
    },
    Template {
        trigger: "some",
        label: ".some",
        detail: "Wrap in Some/Option",
        csharp_snippet: None,
        fsharp_snippet: Some("Some {expr}"),
    },
    Template {
        trigger: "pipe",
        label: ".pipe",
        detail: "Pipe to function",
        csharp_snippet: None,
        fsharp_snippet: Some("{expr} |> $0"),
    },
    Template {
        trigger: "ignore",
        label: ".ignore",
        detail: "Pipe to ignore",
        csharp_snippet: None,
        fsharp_snippet: Some("{expr} |> ignore"),
    },
    Template {
        trigger: "cast",
        label: ".cast",
        detail: "Cast expression",
        csharp_snippet: Some("(${1:Type}){expr}"),
        fsharp_snippet: Some("{expr} :?> ${1:Type}"),
    },
    Template {
        trigger: "await",
        label: ".await",
        detail: "Await async expression",
        csharp_snippet: Some("await {expr}"),
        fsharp_snippet: Some("let! ${1:result} = {expr}\n$0"),
    },
    Template {
        trigger: "typeof",
        label: ".typeof",
        detail: "Type check",
        csharp_snippet: Some("{expr} is ${1:Type} ${2:name}"),
        fsharp_snippet: Some("match {expr} with\n| :? ${1:Type} as ${2:name} -> $0\n| _ -> ()"),
    },
];

/// Extract the expression text before a `.trigger` at the cursor position.
///
/// Given line text `foo.bar.if` and cursor at col 10, extracts `foo.bar`
/// and the trigger `if`. Returns `(expr_start_col, expr_text, trigger)`.
fn extract_postfix_context(line_text: &str, col: u32) -> Option<(u32, String, String)> {
    let col = usize::try_from(col).ok()?;
    let before = line_text.get(..col)?;

    // Find the last dot — everything after is the (partial) trigger.
    let dot_pos = before.rfind('.')?;
    let trigger_part = before.get(dot_pos + 1..)?.to_string();
    let expr_part = before.get(..dot_pos)?.trim_end();

    if expr_part.is_empty() {
        return None;
    }

    // Walk backward from the dot to find the expression start.
    // Stop at statement-level delimiters: ; { } = , (but not within parens/brackets).
    let mut depth = 0i32;
    let mut start = 0;
    let bytes = expr_part.as_bytes();

    for i in (0..bytes.len()).rev() {
        let Some(&byte) = bytes.get(i) else {
            continue;
        };
        match byte {
            b')' | b']' => depth += 1,
            b'(' | b'[' => {
                depth -= 1;
                if depth < 0 {
                    start = i + 1;
                    break;
                }
            }
            b';' | b'{' | b'}' | b'=' | b',' if depth == 0 => {
                start = i + 1;
                break;
            }
            b' ' | b'\t' if depth == 0 && i > 0 => {
                // Check if this space separates a keyword from the expression.
                let word_before = expr_part.get(..i).unwrap_or("").trim_end();
                let last_word = word_before.rsplit_once(' ').map_or(word_before, |p| p.1);
                if matches!(
                    last_word,
                    "return" | "var" | "let" | "if" | "while" | "case" | "yield"
                ) {
                    start = i + 1;
                    break;
                }
            }
            _ => {}
        }
    }

    // Skip leading whitespace so the replacement range starts at the expression.
    while start < bytes.len() && matches!(bytes.get(start), Some(b' ' | b'\t')) {
        start += 1;
    }

    let expr_text = expr_part.get(start..)?.to_string();
    if expr_text.is_empty() {
        return None;
    }

    let start_u32 = u32::try_from(start).ok()?;
    Some((start_u32, expr_text, trigger_part))
}

/// Generate postfix completion items for the given position.
pub fn get_postfix_completions(
    source: &str,
    line: u32,
    character: u32,
    lang: LangId,
) -> Vec<CompletionItem> {
    let lines: Vec<&str> = source.lines().collect();
    let Some(line_idx) = usize::try_from(line).ok() else {
        return Vec::new();
    };

    let Some(line_text) = lines.get(line_idx) else {
        return Vec::new();
    };
    let Some((expr_start, expr_text, trigger_part)) = extract_postfix_context(line_text, character)
    else {
        return Vec::new();
    };

    let replace_range = Range::new(
        Position::new(line, expr_start),
        Position::new(line, character),
    );

    TEMPLATES
        .iter()
        .filter(|t| t.trigger.starts_with(&trigger_part))
        .filter_map(|t| {
            let snippet = match lang {
                LangId::CSharp => t.csharp_snippet,
                LangId::FSharp => t.fsharp_snippet,
            }?;

            let expanded = snippet.replace("{expr}", &expr_text);

            Some(CompletionItem {
                label: t.label.to_string(),
                kind: Some(CompletionItemKind::SNIPPET),
                detail: Some(t.detail.to_string()),
                insert_text_format: Some(InsertTextFormat::SNIPPET),
                text_edit: Some(CompletionTextEdit::Edit(TextEdit {
                    range: replace_range,
                    new_text: expanded,
                })),
                sort_text: Some(format!("0_{}", t.trigger)),
                ..CompletionItem::default()
            })
        })
        .collect()
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn extracts_simple_expression() {
        let (start, expr, trigger) = extract_postfix_context("foo.if", 6).unwrap();
        assert_eq!(start, 0);
        assert_eq!(expr, "foo");
        assert_eq!(trigger, "if");
    }

    #[test]
    fn extracts_chained_expression() {
        let (start, expr, trigger) = extract_postfix_context("foo.bar.var", 11).unwrap();
        assert_eq!(start, 0);
        assert_eq!(expr, "foo.bar");
        assert_eq!(trigger, "var");
    }

    #[test]
    fn extracts_after_assignment() {
        let (start, expr, trigger) = extract_postfix_context("    var x = myList.for", 22).unwrap();
        assert_eq!(expr, "myList");
        assert_eq!(trigger, "for");
        assert_eq!(start, 12);
    }

    #[test]
    fn extracts_method_call_expression() {
        let (start, expr, trigger) = extract_postfix_context("GetItems().if", 13).unwrap();
        assert_eq!(start, 0);
        assert_eq!(expr, "GetItems()");
        assert_eq!(trigger, "if");
    }

    #[test]
    fn returns_none_for_no_dot() {
        assert!(extract_postfix_context("foo", 3).is_none());
    }

    #[test]
    fn generates_csharp_if_postfix() {
        let items = get_postfix_completions("foo.if", 0, 6, LangId::CSharp);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, ".if");
        let text = match &items[0].text_edit {
            Some(CompletionTextEdit::Edit(e)) => &e.new_text,
            _ => panic!("expected text edit"),
        };
        assert!(text.contains("if (foo)"));
    }

    #[test]
    fn generates_fsharp_match_postfix() {
        let items = get_postfix_completions("xs.match", 0, 8, LangId::FSharp);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, ".match");
        let text = match &items[0].text_edit {
            Some(CompletionTextEdit::Edit(e)) => &e.new_text,
            _ => panic!("expected text edit"),
        };
        assert!(text.contains("match xs with"));
    }

    #[test]
    fn partial_trigger_matches() {
        let items = get_postfix_completions("x.fo", 0, 4, LangId::CSharp);
        let labels: Vec<_> = items.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&".for"));
        assert!(labels.contains(&".forr"));
    }

    #[test]
    fn fsharp_only_templates_excluded_for_csharp() {
        let items = get_postfix_completions("x.some", 0, 6, LangId::CSharp);
        assert!(items.is_empty());
    }

    #[test]
    fn csharp_only_templates_excluded_for_fsharp() {
        let items = get_postfix_completions("x.notnull", 0, 9, LangId::FSharp);
        assert!(items.is_empty());
    }

    #[test]
    fn returns_none_for_dot_with_empty_expr() {
        // Leading dot — no expression before it.
        assert!(extract_postfix_context(".if", 3).is_none());
    }

    #[test]
    fn returns_none_for_paren_open_before_expr() {
        // Expression preceded only by `(` which opens a depth < 0 stop.
        // "(x.if" with cursor at 5 — expr is "x", trigger is "if"
        let result = extract_postfix_context("(x.if", 5);
        // Should succeed: depth goes negative at `(` so start = 1 (after `(`).
        assert!(result.is_some());
        let (_, expr, trigger) = result.unwrap();
        assert_eq!(expr, "x");
        assert_eq!(trigger, "if");
    }

    #[test]
    fn extracts_after_keyword_with_space() {
        // "return expr.if" — the `return` keyword triggers the space-stop logic.
        let result = extract_postfix_context("return expr.if", 14);
        assert!(result.is_some());
        let (_, expr, trigger) = result.unwrap();
        assert_eq!(expr, "expr");
        assert_eq!(trigger, "if");
    }

    #[test]
    fn returns_none_when_out_of_line_bounds() {
        // Line only has 3 chars; requesting col 100 must return None.
        let items = get_postfix_completions("foo", 0, 100, LangId::CSharp);
        assert!(items.is_empty());
    }

    #[test]
    fn returns_empty_when_line_index_out_of_range() {
        // Source has 1 line; requesting line 99 must return empty.
        let items = get_postfix_completions("foo.if", 99, 6, LangId::CSharp);
        assert!(items.is_empty());
    }
}
