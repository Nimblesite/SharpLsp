---
layout: layouts/docs.njk
title: Getting Started
eleventyNavigation:
  key: Getting Started
  order: 1
---

# Getting Started with SharpLsp

SharpLsp is an open-source Language Server Protocol implementation for .NET, with C# and F# semantic engines behind one Rust host. The project is working toward Visual Studio- and Rider-grade tooling without proprietary language services or per-seat licensing. It is under active development and VS Code is the supported editor integration today.

{% video "getting-started" %}

## Install

### VS Code

Install the SharpLsp extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp), or from [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp) in Cursor, Windsurf, and VSCodium.

The VSIX bundles the `sharplsp` host and both .NET sidecars. You do not need a Rust toolchain or a separate SharpLsp binary. Open a workspace containing a `.sln`, `.slnx`, `.csproj`, or `.fsproj` and the extension starts the server.

<section class="callout">
  <h2>Automatic .NET setup</h2>
  <ul class="requirement-list">
    <li><span class="requirement-icon" aria-hidden="true">.NET</span><div><h3>.NET 10 SDK</h3><p>SharpLsp needs an SDK for MSBuild and compiler services. On activation, the extension locates a compatible SDK or asks Microsoft’s .NET Install Tool to acquire one. The language service and F# Interactive can use that acquired SDK without <code>dotnet</code> already on PATH. Build/test commands and some NuGet operations still launch <code>dotnet</code> by name and therefore require it on PATH.</p></div></li>
  </ul>
</section>

The current release includes C# and F# completion, hover, navigation, diagnostics, symbols, code actions, rename, semantic tokens, inlay hints, solution tooling, NuGet workflows, debugging, and profiling. Projects that target .NET Framework 4.6.2–4.8.1 get the same language features on every OS, and on Windows they also [run and test](/blog/dotnet-framework-windows-vs-code/) on the desktop CLR. Some features remain partial; the individual pages document their current limits.

### Other editors

The server uses standard LSP wherever possible. Every GitHub release publishes standalone server archives and a Rider plugin, and [Zed](/docs/zed/) runs SharpLsp through a dev extension. Packaged integrations for Neovim, Helix, and Emacs are not released yet.

<p class="next-link"><a href="/docs/architecture/">Next: Architecture <span aria-hidden="true">→</span></a></p>
