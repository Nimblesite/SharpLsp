# SharpLsp Formatting (Sequestered)

SharpLsp does **not** provide document formatting as an LSP feature. The recommended formatters are:

- **C#**: [CSharpier](https://csharpier.com/) -- the community-standard opinionated C# formatter
- **F#**: [Fantomas](https://github.com/fsprojects/fantomas) via the [Ionide](https://ionide.io/) extension -- the standard F# formatter

These tools are excellent at what they do. There is no reason to duplicate their work inside an LSP server.

## Why This Code Exists

The codebase contains a complete but **disabled** formatting implementation using Roslyn's `Formatter` API (C#) and Fantomas (F#). This code is sequestered -- not wired into the LSP server -- and excluded from code coverage.

It may become the foundation for a built-in SharpLsp formatter in the future, but there are no plans for this right now.

## Where The Code Lives

| Component | File(s) | Engine |
|-----------|---------|--------|
| Rust LSP handler | `src/formatting.rs` | Routes to sidecar (gated behind `cfg(feature = "formatting")`) |
| C# sidecar resolver | `sidecars/SharpLsp.Sidecar.CSharp/Workspace/FormattingResolver.cs` | Roslyn `Formatter.FormatAsync()` |
| C# sidecar handlers | `sidecars/SharpLsp.Sidecar.CSharp/CSharpSidecar.Features.cs` (formatting methods) | Delegates to resolver |
| C# workspace manager | `sidecars/SharpLsp.Sidecar.CSharp/Workspace/WorkspaceManager.Features.cs` (formatting methods) | Delegates to resolver |
| F# features | `sidecars/SharpLsp.Sidecar.FSharp/FSharpFeatures.fs` (formatting section) | Fantomas `CodeFormatter` |
| F# sidecar handlers | `sidecars/SharpLsp.Sidecar.FSharp/FSharpSidecar.fs` (formatting registrations) | Delegates to features |

## How It's Disabled

1. **Rust host**: `main.rs` sets all formatting capabilities to `None` and does not route formatting requests. The `mod formatting` is behind `#[cfg(feature = "formatting")]`.
2. **Cargo.toml**: Declares a `formatting` feature flag (off by default).
3. **C# sidecar**: Handler registrations still exist (the sidecar responds if asked) but the Rust host never asks. `FormattingResolver` and workspace formatting methods are marked `[ExcludeFromCodeCoverage]`.
4. **F# sidecar**: Handler registrations still exist but the Rust host never asks. Formatting functions are marked as sequestered in comments.
5. **Coverage**: `FormattingResolver.cs` is excluded via `coverlet.runsettings` `ExcludeByFile`. Workspace formatting methods have `[ExcludeFromCodeCoverage]` attributes.

## Supported Formatting Features (If Re-enabled)

| Feature | LSP Method | C# | F# |
|---------|-----------|----|----|
| Document formatting | `textDocument/formatting` | Roslyn `Formatter.FormatAsync()` | Fantomas `FormatDocumentAsync()` |
| Range formatting | `textDocument/rangeFormatting` | Roslyn `Formatter.FormatAsync(span)` | Fantomas range formatting |
| On-type formatting | `textDocument/onTypeFormatting` | Roslyn line formatting | N/A |
| Format preview | `textDocument/formattingPreview` | N/A | Fantomas diff preview |
