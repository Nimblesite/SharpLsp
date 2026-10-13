---
layout: layouts/docs.njk
title: Editor Setup
eleventyNavigation:
  key: Editor Setup
  order: 3
---

# Editor Setup

![SharpLsp editor support](/assets/screenshots/vscode-editors-page.png)

SharpLsp is editor-agnostic at the protocol layer. VS Code and its Open VSX forks are the supported, packaged clients today; a Rider plugin and standalone server archives ship with every release, and the other integrations remain development work.

## VS Code

Install [SharpLsp from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp), or from [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) in Cursor, Windsurf, and VSCodium. The VSIX includes the Rust host and the C# and F# sidecars, so no separate SharpLsp installation is needed.

During activation the extension:

1. locates a compatible .NET 10 SDK or acquires one through Microsoft's .NET Install Tool;
2. resolves the bundled binaries for the current platform;
3. starts the language client and sidecars;
4. discovers a solution or project in the workspace.

The extension also supplies the Solution Explorer, NuGet browser, profiler, debugger integration, test CodeLens, F# Interactive commands, build commands, and status/output views.

### Workspace Trust

In an untrusted workspace, SharpLsp runs only its bundled binaries. Workspace values that could select an executable or inject arguments—such as `sharplsp.lspPath`, sidecar paths, extra server arguments, FSI arguments, and the debug-adapter path—are ignored until the workspace is trusted.

### Custom Development Binaries

In a trusted workspace, the `sharplsp.lspPath`, `sharplsp.csharpSidecarPath`, and `sharplsp.fsharpSidecarPath` settings can point the extension at local development builds. Leave them empty for the bundled release binaries.

## Other LSP Clients

A generic editor can speak LSP 3.17 to the host over stdio. Every [release](https://github.com/Nimblesite/SharpLsp/releases) publishes a standalone server archive per platform with the host and both sidecars side by side, plus a Rider plugin (`sharplsp-rider.zip`) that launches it. Packaged Zed, Neovim, Helix, and Emacs integrations are planned, not current release surfaces.

For repository builds, see [Contributing](/docs/contributing/).
