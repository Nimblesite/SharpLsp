---
layout: layouts/docs.njk
title: Getting Started
eleventyNavigation:
  key: Getting Started
  order: 1
---

# Getting Started with SharpLsp

SharpLsp is an open-source Language Server Protocol (LSP) implementation for .NET (C# + F#), built in Rust. One server, every editor. Full feature parity with Visual Studio, Rider, and C# Dev Kit — zero proprietary dependencies, zero licenses, zero vendor lock-in.

## Install

### VS Code

Install the SharpLsp extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=sharplsp.sharplsp).

The extension ships with the `sharplsp` binary and both sidecars bundled inside the VSIX. No Rust toolchain. No separate binary install. Open a `.sln` or `.csproj` and SharpLsp starts automatically.

<section class="callout">
  <h2><span class="material-symbols-outlined" aria-hidden="true">deployed_code</span>Prerequisite</h2>
  <ul class="requirement-list">
    <li><span class="material-symbols-outlined" aria-hidden="true">deployed_code</span><div><h3>.NET 10.0 SDK</h3><p>Required for project parsing and MSBuild integration. Ensure <code>dotnet</code> is on your PATH.</p></div></li>
  </ul>
</section>

### Neovim & Zed

Neovim and Zed support are coming soon.

<p class="next-link"><a href="/docs/architecture/">Next: Architecture <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span></a></p>
