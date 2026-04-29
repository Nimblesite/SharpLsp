# SharpLsp

<p align="center">
  <strong>Open-source, editor-agnostic .NET language tooling for C# and F#.</strong><br>
  One LSP server, every editor, no proprietary toolchain lock-in.
</p>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:24px 0;">
  <section style="border:1px solid var(--border,#d0d7de);border-radius:8px;padding:16px;background:var(--surface-low,transparent);">
    <h3 style="margin-top:0;">One Server</h3>
    <p style="margin-bottom:0;">A single <code>sharplsp-lsp</code> process speaks standard LSP over stdio and serves every editor client.</p>
  </section>
  <section style="border:1px solid var(--border,#d0d7de);border-radius:8px;padding:16px;background:var(--surface-low,transparent);">
    <h3 style="margin-top:0;">C# + F#</h3>
    <p style="margin-bottom:0;">Roslyn powers C# semantics. FSharp.Compiler.Service powers F#. F# is a first-class target, not a bolt-on.</p>
  </section>
  <section style="border:1px solid var(--border,#d0d7de);border-radius:8px;padding:16px;background:var(--surface-low,transparent);">
    <h3 style="margin-top:0;">No Lock-In</h3>
    <p style="margin-bottom:0;">MIT licensed. No per-seat licenses, no Windows VM requirement, no editor-specific language engine.</p>
  </section>
</div>

SharpLsp is building the .NET development stack that should already exist: Visual Studio/Rider-grade language intelligence, solution awareness, diagnostics, refactoring, package management, debugging, and profiling through one open server.

## Why This Exists

.NET tooling is powerful, but the experience is fragmented:

- **Visual Studio** still sets the benchmark for .NET tooling, but it is Windows-only.
- **C# Dev Kit** is tied to VS Code, carries enterprise licensing constraints, and does not replace Visual Studio's profiler or performance tooling.
- **Rider** is excellent, but its .NET intelligence lives inside Rider instead of a reusable LSP server.
- **F#** too often trails behind C# instead of receiving equal first-class tooling.
- **Neovim, Zed, Helix, Emacs, and other editors** are left stitching together partial community workflows.

SharpLsp treats language tooling as infrastructure. The editor should be a preference, not the place where the .NET language engine is trapped.

## Architecture

SharpLsp is split into three parts:

- **Rust LSP host**: owns JSON-RPC, stdio transport, request routing, virtual files, tree-sitter syntax work, and sidecar lifecycle.
- **C# sidecar**: hosts Roslyn for semantic C# features.
- **F# sidecar**: hosts FSharp.Compiler.Service for semantic F# features.

That split keeps the editor protocol fast and portable while letting the .NET compilers do the semantic work they are built for.

## Install

### VS Code

Install the SharpLsp extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sharplsp.sharp-lsp). The extension ships with the `sharplsp-lsp` binary and both sidecars — no Rust toolchain or separate install required.

### Neovim & Zed

Neovim and Zed support are coming soon.

## Documentation

Full documentation is available at [sharplsp.dev/docs](https://sharplsp.dev/docs).

For the full argument behind the project, read [Why .NET Needs an Editor-Agnostic LSP](https://sharplsp.dev/blog/editor-agnostic-dotnet-lsp/).

## Contributing

Want to build from source or contribute? See the [Contributing guide](https://sharplsp.dev/docs/contributing/).

## License

[MIT](LICENSE)
