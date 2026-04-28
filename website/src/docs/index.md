---
layout: layouts/docs.njk
title: Getting Started
eleventyNavigation:
  key: Getting Started
  order: 1
---

# Getting Started with Forge

Forge is an ultra-fast, open-source Language Server Protocol (LSP) implementation for .NET, engineered entirely in Rust. It delivers sub-millisecond response times and minimal memory footprint, redefining the C# developer experience.

<img src="/assets/screenshots/vscode-getting-started-page.png" alt="" aria-hidden="true" style="position:absolute;width:1px;height:1px;opacity:0;margin:0;border:0;">

<section class="callout">
  <h2><span class="material-symbols-outlined" aria-hidden="true">fact_check</span>Prerequisites</h2>
  <ul class="requirement-list">
    <li><span class="material-symbols-outlined" aria-hidden="true">terminal</span><div><h3>Rust Toolchain</h3><p>Requires Rust 1.75.0 or later. We recommend installing via <code>rustup</code>.</p></div></li>
    <li><span class="material-symbols-outlined" aria-hidden="true">deployed_code</span><div><h3>.NET 10.0 SDK</h3><p>Required for project parsing and MSBuild integration. Ensure the SDK is in your PATH.</p></div></li>
  </ul>
</section>

## Installation

Install the Forge CLI directly from crates.io using Cargo:

```bash
$ cargo install forge-cli
```

## Basic Usage

<div class="usage-grid">
  <section class="usage-card">
    <h3><span class="material-symbols-outlined" aria-hidden="true">folder_open</span>Initialize Workspace</h3>
    <p>Generate a <code>forge.toml</code> configuration file in the root of your existing .NET solution.</p>
    <pre><code>$ forge init .</code></pre>
  </section>
  <section class="usage-card">
    <h3><span class="material-symbols-outlined" aria-hidden="true">play_arrow</span>Start Server</h3>
    <p>Launch the LSP server. Typically, your editor will run this command automatically.</p>
    <pre><code>$ forge dev --watch</code></pre>
  </section>
</div>

<p class="next-link"><a href="/docs/architecture/">Next: Architecture <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span></a></p>
