# Infrastructure Plan

Core infrastructure improvements for the SharpLsp LSP host.

## F# Tree-sitter Grammar

- [x] Integrate ionide/tree-sitter-fsharp grammar into Rust host
- [x] Add `tree-sitter-fsharp` dependency to Cargo.toml (`0.3`)
- [x] Remove `anyhow::bail!("F# tree-sitter grammar not yet integrated")` from `tree_sitter_parse.rs`
- [x] Enable F# tree-sitter folding ranges and selection ranges; document symbols remain FCS-backed for richer navigation items

## Observability

- [ ] Add OpenTelemetry export to tracing infrastructure (tracing-opentelemetry crate)
- [ ] Configure OTLP exporter for traces and metrics

## Distribution

- [ ] Global tool installation support (`dotnet tool install -g sharplsp`)
- [ ] NuGet package manifest for dotnet tool packaging

## Incremental Computation

- [x] Implement the Rust-host salsa database as the only semantic-result memoization mechanism — `semantic_memo.rs`, one tracked query for hover, definition, type definition, declaration, references and document highlight
- [x] Replace and remove the interim, nonconformant `nav_cache.rs` `HashMap`; model document, solution, and sidecar-generation state as salsa inputs — the question input carries the document version, the workspace generation input moves on every edit, solution or target-framework switch, compiler change and compiler (re)connect
- [x] Cancel superseded semantic requests; input invalidation alone does not cancel in-flight sidecar work — `semantic/requests.rs` runs them off the input loop on the shared dispatcher; `semantic_memo_session.rs` pins `ContentModified` and `RequestCancelled`
- [x] Request coalescing and cancellation (150ms debounce window) — `server.debounce_ms` is applied at start and live; a request inside the window after an edit waits it out and ends there when the next keystroke supersedes it

## File Watching

- [x] Implement `workspace/didChangeWatchedFiles` notification handler (`service_notifications.rs` → `pull_diagnostics/changes.rs`, [DIAG-LSP-REFRESH])
- [x] React to .csproj/.fsproj/.sln changes and trigger sidecar reload (the serialized reload worker reopens each concerned compiler's workspace; `workspace_diagnostic_protocol/input_reload.rs`, `owned_projects.rs`)

## Sidecar Startup Performance

- [ ] Enable ReadyToRun (R2R) compilation for sidecar binaries (`PublishReadyToRun` in .csproj/.fsproj)
