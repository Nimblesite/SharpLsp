---
layout: layouts/docs.njk
title: Editor Setup
eleventyNavigation:
  key: Editor Setup
  order: 3
---

# Editor Setup

![SharpLsp editor support](/assets/screenshots/vscode-editors-page.png)

SharpLsp is editor-agnostic at the LSP layer. The VS Code extension is the primary supported surface. Neovim and Zed support are coming soon.

**Prerequisite:** [.NET 10.0 SDK](https://dotnet.microsoft.com/download) installed and `dotnet` on your PATH.

## VS Code

Install the SharpLsp extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sharplsp-lsp.sharplsp). The extension ships with the `sharplsp-lsp` binary and both sidecars bundled inside the VSIX — no Rust toolchain or separate binary install required.

The extension automatically manages the `sharplsp-lsp` server lifecycle and provides the Solution Explorer, profiler, NuGet browser, test lens, and editor status integration. No additional configuration is required.

## Neovim

Coming soon.

## Zed

Coming soon.
