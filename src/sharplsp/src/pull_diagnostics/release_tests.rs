//! Closing a document frees its diagnostic memo and keeps every other open
//! document's memo warm; finishing a solution load frees every memo, so
//! documents never pulled again cannot stay resident. [LSPKIT-MEM-ADOPT] (#566)
use super::*;

#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries fixture I/O errors"
)]
mod contract {
    use std::sync::Weak;

    use lsp_types::Diagnostic;
    use serde_json::json;

    use super::*;
    use crate::config::DiagnosticsConfig;
    use crate::sidecar::fake_compiler::{answering, empty, Fake};

    /// Pull every one of `count` C# sources once and keep only weak handles to
    /// what each pull produced; the store's memo is then the only owner.
    fn pull_all(count: usize, version: i32) -> Result<Vec<Weak<Vec<Diagnostic>>>> {
        let store = store()?;
        (0..count)
            .map(|index| {
                let report = store.diagnostics(source(index)?.as_str(), version)?;
                Ok(Arc::downgrade(&report.items))
            })
            .collect()
    }

    /// The URI of the `index`th C# source.
    fn source(index: usize) -> Result<Uri> {
        let path = std::env::temp_dir().join(format!("sharplsp-release-{index}.cs"));
        crate::paths::path_to_lsp_uri(&path.to_string_lossy())
    }

    /// How many pulled results something still owns.
    fn held(results: &[Weak<Vec<Diagnostic>>]) -> usize {
        results
            .iter()
            .filter(|result| result.strong_count() > 0)
            .count()
    }

    #[test]
    fn closing_a_document_frees_only_its_memo_and_loading_a_solution_frees_every_memo() -> Result<()>
    {
        let runtime = tokio::runtime::Runtime::new()?;
        let compiler = Fake::connect(&runtime, answering(empty()));
        shutdown()?;
        let capabilities: lsp_types::ClientCapabilities =
            serde_json::from_value(json!({"textDocument":{"diagnostic":{}}}))?;
        let (sender, _receiver) = crossbeam_channel::unbounded();
        let config = DiagnosticsConfig::default();
        initialize(
            &capabilities,
            &config,
            &runtime,
            [Some(&compiler.manager), None],
            sender,
        )?;

        let first = pull_all(5, 1)?;
        assert_eq!(held(&first), 5, "the store memoizes every pulled document");
        begin_change();
        assert_eq!(
            held(&first),
            5,
            "invalidating alone keeps every memo resident"
        );
        release_closed(&source(0)?);
        assert_eq!(
            first.first().map(Weak::strong_count),
            Some(0),
            "closing a document frees its memo"
        );
        assert_eq!(
            held(&first),
            4,
            "closing one document keeps the others warm"
        );
        for index in 1..5 {
            release_closed(&source(index)?);
        }
        assert_eq!(held(&first), 0, "closing every document frees every memo");

        let second = pull_all(3, 2)?;
        assert_eq!(held(&second), 3, "pulls after a close memoize again");
        runtime.block_on(load_finished());
        assert_eq!(
            held(&second),
            0,
            "a finished solution load frees the old memos"
        );

        let third = pull_all(4, 3)?;
        assert_eq!(held(&third), 4, "pulls after a load memoize again");
        shutdown()
    }
}
