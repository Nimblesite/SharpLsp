//! Completion and symbol labels: the name highlighted by its kind, a symbol's
//! kind before it, and a completion's detail after it. Literal spans, never
//! parsed code: one server answers C#, F# and Razor buffers, so no one grammar
//! reads every label ([DIST-ZED-LABELS]).

use zed_extension_api::lsp::{Completion, CompletionKind, Symbol, SymbolKind};
use zed_extension_api::{CodeLabel, CodeLabelSpan};

/// The theme highlight a completion's kind shows its name in.
fn completion_highlight(kind: &CompletionKind) -> Option<&'static str> {
    match kind {
        CompletionKind::Method | CompletionKind::Function => Some("function"),
        CompletionKind::Constructor => Some("constructor"),
        CompletionKind::Field | CompletionKind::Property | CompletionKind::Event => {
            Some("property")
        }
        CompletionKind::Variable | CompletionKind::Value => Some("variable"),
        CompletionKind::Class
        | CompletionKind::Interface
        | CompletionKind::Struct
        | CompletionKind::Enum
        | CompletionKind::Module
        | CompletionKind::TypeParameter => Some("type"),
        CompletionKind::EnumMember | CompletionKind::Constant => Some("constant"),
        CompletionKind::Keyword => Some("keyword"),
        _ => None,
    }
}

/// The word a symbol's kind is shown with, and the highlight its name takes.
fn symbol_kind(kind: &SymbolKind) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        SymbolKind::Class => ("class", "type"),
        SymbolKind::Interface => ("interface", "type"),
        SymbolKind::Struct => ("struct", "type"),
        SymbolKind::Enum => ("enum", "type"),
        SymbolKind::Module => ("module", "type"),
        SymbolKind::Namespace => ("namespace", "type"),
        SymbolKind::Method => ("method", "function"),
        SymbolKind::Function => ("function", "function"),
        SymbolKind::Constructor => ("constructor", "constructor"),
        SymbolKind::Property => ("property", "property"),
        SymbolKind::Field => ("field", "property"),
        SymbolKind::Event => ("event", "property"),
        SymbolKind::EnumMember => ("member", "constant"),
        SymbolKind::Constant => ("constant", "constant"),
        SymbolKind::Variable => ("variable", "variable"),
        SymbolKind::TypeParameter => ("type parameter", "type"),
        _ => return None,
    })
}

/// A label whose first span is `name` in `highlight`, filtered on the name alone.
fn named(name: String, highlight: Option<&str>, prefix: Option<String>) -> CodeLabel {
    let start = prefix.as_ref().map_or(0, String::len);
    let range = start..start + name.len();
    let leading = prefix.map(|word| CodeLabelSpan::literal(word, Some("keyword".to_owned())));
    let spans = leading
        .into_iter()
        .chain([CodeLabelSpan::literal(name, highlight.map(str::to_owned))])
        .collect();
    CodeLabel {
        code: String::new(),
        spans,
        filter_range: range.into(),
    }
}

/// The detail the server gave a completion: its signature or type.
fn completion_detail(completion: &Completion) -> Option<String> {
    completion
        .label_details
        .as_ref()
        .and_then(|details| {
            details
                .detail
                .clone()
                .or_else(|| details.description.clone())
        })
        .or_else(|| completion.detail.clone())
        .filter(|detail| !detail.trim().is_empty())
}

/// A completion's name highlighted by its kind, its detail after it.
pub fn completion_label(completion: &Completion) -> CodeLabel {
    let highlight = completion.kind.as_ref().and_then(completion_highlight);
    let mut label = named(completion.label.clone(), highlight, None);
    if let Some(detail) = completion_detail(completion) {
        label.spans.push(CodeLabelSpan::literal(
            format!("  {detail}"),
            Some("comment".to_owned()),
        ));
    }
    label
}

/// A symbol's kind and its name highlighted by that kind; none for a kind .NET never answers.
pub fn symbol_label(symbol: &Symbol) -> Option<CodeLabel> {
    let (word, highlight) = symbol_kind(&symbol.kind)?;
    Some(named(
        symbol.name.clone(),
        Some(highlight),
        Some(format!("{word} ")),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(label: &CodeLabel) -> Vec<(String, Option<String>)> {
        label
            .spans
            .iter()
            .filter_map(|span| match span {
                CodeLabelSpan::Literal(literal) => {
                    Some((literal.text.clone(), literal.highlight_name.clone()))
                }
                CodeLabelSpan::CodeRange(_) => None,
            })
            .collect()
    }

    fn completion(label: &str, kind: Option<CompletionKind>, detail: Option<&str>) -> Completion {
        Completion {
            label: label.to_owned(),
            label_details: None,
            detail: detail.map(str::to_owned),
            kind,
            insert_text_format: None,
        }
    }

    fn owned(spans: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        spans
            .iter()
            .map(|(text, highlight)| ((*text).to_owned(), highlight.map(str::to_owned)))
            .collect()
    }

    #[test]
    fn a_method_completion_shows_its_name_as_a_function_and_its_signature_after_it() {
        let method = completion(
            "Greet",
            Some(CompletionKind::Method),
            Some("string Greet(string)"),
        );
        let label = completion_label(&method);
        let expected = [
            ("Greet", Some("function")),
            ("  string Greet(string)", Some("comment")),
        ];
        assert_eq!(text(&label), owned(&expected));
        assert_eq!((label.filter_range.start, label.filter_range.end), (0, 5));
        assert!(
            label.code.is_empty(),
            "literal spans only: no grammar reads them"
        );
    }

    #[test]
    fn a_property_shows_its_type_and_a_blank_detail_shows_nothing() {
        let typed = completion("Count", Some(CompletionKind::Property), Some(": int"));
        let label = completion_label(&typed);
        let expected = [("Count", Some("property")), ("  : int", Some("comment"))];
        assert_eq!(text(&label), owned(&expected));
        let blank = completion("let", Some(CompletionKind::Keyword), Some("  "));
        let keyword = completion_label(&blank);
        assert_eq!(text(&keyword), owned(&[("let", Some("keyword"))]));
    }

    #[test]
    fn every_completion_kind_has_its_highlight_and_an_unknown_kind_none() {
        let cases = [
            (CompletionKind::Function, Some("function")),
            (CompletionKind::Constructor, Some("constructor")),
            (CompletionKind::Field, Some("property")),
            (CompletionKind::Event, Some("property")),
            (CompletionKind::Variable, Some("variable")),
            (CompletionKind::Class, Some("type")),
            (CompletionKind::Module, Some("type")),
            (CompletionKind::EnumMember, Some("constant")),
            (CompletionKind::Snippet, None),
            (CompletionKind::Other(99), None),
        ];
        for (kind, highlight) in cases {
            let label = completion_label(&completion("x", Some(kind), None));
            assert_eq!(text(&label), owned(&[("x", highlight)]));
        }
        let untyped = completion_label(&completion("x", None, None));
        assert_eq!(text(&untyped), owned(&[("x", None)]));
    }

    #[test]
    fn a_symbol_shows_its_kind_then_its_name_filtered_on_the_name() {
        let cases = [
            (SymbolKind::Class, "Greeter", "class ", "type"),
            (SymbolKind::Module, "Calculator", "module ", "type"),
            (SymbolKind::Method, "Greet", "method ", "function"),
            (SymbolKind::Function, "add", "function ", "function"),
            (SymbolKind::Property, "Name", "property ", "property"),
            (SymbolKind::EnumMember, "Circle", "member ", "constant"),
            (SymbolKind::TypeParameter, "T", "type parameter ", "type"),
        ];
        for (kind, name, word, highlight) in cases {
            let label = symbol_label(&Symbol {
                kind,
                name: name.to_owned(),
            })
            .expect("a label");
            assert_eq!(
                text(&label),
                owned(&[(word, Some("keyword")), (name, Some(highlight))])
            );
            let start = u32::try_from(word.len()).expect("short word");
            let end = start + u32::try_from(name.len()).expect("short name");
            assert_eq!(
                (label.filter_range.start, label.filter_range.end),
                (start, end)
            );
        }
    }

    #[test]
    fn a_symbol_kind_dotnet_never_answers_has_no_custom_label() {
        for kind in [SymbolKind::File, SymbolKind::String, SymbolKind::Other(42)] {
            assert!(symbol_label(&Symbol {
                kind,
                name: "x".to_owned()
            })
            .is_none());
        }
    }
}
