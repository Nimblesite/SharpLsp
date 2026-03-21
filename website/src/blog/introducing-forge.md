---
layout: layouts/blog.njk
title: Introducing Forge
date: 2026-03-20
author: Forge Team
tags: posts
excerpt: An open-source .NET LSP built in Rust — bringing first-class C# and F# support to every editor.
---

# Introducing Forge

We are building Forge — an open-source, editor-agnostic Language Server for C# and F#.

## The Problem

.NET developers have been locked into proprietary tooling for too long. Visual Studio is Windows-only and heavy. Rider requires a license. C# Dev Kit is closed-source and limited to VS Code. If you use Neovim, Helix, Emacs, or Zed — you are a second-class citizen.

## The Solution

Forge is a single LSP server that delivers a complete .NET development experience across every editor. Built in Rust for speed, powered by Roslyn and FSharp.Compiler.Service for accuracy.

### Key Design Decisions

- **Rust host** for sub-millisecond tree-sitter parsing and incremental computation
- **.NET sidecars** for full semantic analysis — no reimplementation, no approximation
- **F# as a first-class citizen** — not a bolt-on afterthought
- **Zero proprietary dependencies** — MIT licensed, open to contributions

## Performance Targets

We are targeting aggressive latency goals:

- Completions: <100ms p50
- Go-to-definition: <100ms p50
- Diagnostics refresh: <500ms from keystroke
- Cold start: <3s to first LSP response

## Get Involved

Forge is open source. Check out the [GitHub repository](https://github.com/MelbourneDeveloper/forge) and join us in building the .NET tooling developers deserve.
