# Infrastructure Plan

Core infrastructure improvements for the Forge LSP host.

## F# Tree-sitter Grammar

- [ ] Integrate ionide/tree-sitter-fsharp grammar into Rust host
- [ ] Add `tree-sitter-fsharp` dependency to Cargo.toml
- [ ] Remove `anyhow::bail!("F# tree-sitter grammar not yet integrated")` from `tree_sitter_parse.rs`
- [ ] Enable tree-sitter syntax features for F# (documentSymbol, foldingRange, selectionRange)

## Observability

- [ ] Add OpenTelemetry export to tracing infrastructure (tracing-opentelemetry crate)
- [ ] Configure OTLP exporter for traces and metrics

## Distribution

- [ ] Global tool installation support (`dotnet tool install -g forge-lsp`)
- [ ] NuGet package manifest for dotnet tool packaging

## Incremental Computation

- [ ] Evaluate salsa database for incremental caching of semantic results
- [ ] Request coalescing and cancellation (150ms debounce window) — config exists, wire up active debouncing

## File Watching

- [ ] Implement `workspace/didChangeWatchedFiles` notification handler
- [ ] React to .csproj/.fsproj/.sln changes and trigger sidecar reload

## Sidecar Startup Performance

- [ ] Enable ReadyToRun (R2R) compilation for sidecar binaries (`PublishReadyToRun` in .csproj/.fsproj)
