# CLAUDE.md

⚠️ Never kill VS Code processes — not desktop, not browser. They belong to the user. ⚠️ 

⚠️ Don't ask the user questions — use your judgment. ⚠️ 

⚠️ Don't use git. Especially critical: don't stamp yourself as coauthor on commits ⚠️

> "Git" here means **version-control operations**: commits, branches, merges, rebases, tags, pushes — and never stamping yourself as coauthor. It does **NOT** mean GitHub. **GitHub issues are allowed and encouraged** — use the `gh` CLI to file, comment on, and manage issues for bugs and tracking. GitHub ≠ Git.

SharpLsp is an open-source, editor-agnostic .NET LSP (C# + F#) built in Rust. One LSP server = complete .NET development experience across every editor.

**Overall aim #1: FIX THE .NET DEVELOPER EXPERIENCE.**
Match — and ultimately go beyond — Visual Studio, Rider, and C# Dev Kit. Full feature-for-feature parity, then more. Zero proprietary dependencies. Zero licenses. Zero vendor lock-in.

**Overall aim #2: TREAT F# AS A FIRST CLASS CITIZEN.**
F# ahead of C# when building new features. F# never takes the backseat.

# Code

## Principles

This code would pass a review at Google, Meta, or Microsoft. No bad or duplicate code. Grade A+. Anything less must be fixed immediately.

- Logging is critical. Use structured logging: `tracing` crate in Rust, `ILogger` + Serilog in .NET. No raw `println!`/`Console.WriteLine`/`console.log` for diagnostics
- 100% test coverage is only the start
- Use libraries like Signals for reactivity
- No feature is complete without e2e tests
- Building a feature without tests is not allowed
- No unit tests. Only COARSE e2e tests

## Hard Rules

- Do not use Git.
- All screens MUST BE 100% reactive. If underlying data changes, the screen must be listening and update accordingly
- Zero duplication. Apply DRY rigorously. Check for existing code before writing new code — highest priority
- Any function that can throw/panic must return Result<T,E> (outcome package in .NET)
- Avoid RegEx and string matching. Always use ACTUAL parsers and traverse the AST/CST
- **NEVER hand-manipulate structured files.** XML (csproj/fsproj/props/vsixmanifest), JSON, TOML, YAML, solution files, etc. MUST be loaded into a proper document model, mutated via the DOM/AST, and serialized back. Line splicing, regex replacement, and string concatenation on structured files are not permitted. No exceptions for "performance" or "formatting preservation" — use a parser that preserves trivia (e.g. `Microsoft.Build.Construction` for MSBuild, `XDocument`/`quick-xml` with trivia preservation for XML, `serde_json` with `preserve_order` for JSON).
- `allow(clippy::` is not permitted without a strong, documented reason. **Aggressively remove** existing allows.
- All code files < 500 LOC. Functions < 20 LOC
- Aggressively move shared code to shared crates/modules
- Keep dependencies and versions in sync across: `.github/workflows/ci.yml`, `.devcontainer/Dockerfile`
- Legacy code must be deleted, not copied. Move files instead of duplicating them.
- Never copy from C# Dev Kit, Rider, or Visual Studio. Reimplement from public APIs and protocols only

## Testing

100% test coverage and high mutation score. Focus on assertions, not just coverage.

- Never delete failing tests
- Never remove assertions that cause test failures
- Add more failing tests for broken/missing functionality — never remove them
- Do not reduce test assertiveness to make tests pass
- Tests must not be skipped or ignored
- Test against real .sln/.csproj/.fsproj files, not mocks

## Rust Quality Standards

- Run clippy and fmt routinely, fix violations immediately
- All lints at highest strictness (see Cargo.toml `[lints]`)
- `unsafe` code forbidden (`unsafe_code = "deny"`)
- `unwrap()` is ALWAYS a violation. Use `?` with proper error types
- No `panic!`, `todo!`, `unimplemented!` — return `Result<T,E>`

## .NET Sidecar Quality Standards

- C# sidecar targets net10.0
- Use nullable reference types everywhere (`<Nullable>enable</Nullable>`)
- No `#pragma warning disable` without justification
- MessagePack serialization must be AOT-compatible
- Sidecar crash must never take down the Rust host

## Functional Programming Style

- `Result<T,E>` and `Option<T>` everywhere
- Expressions over statements — `match`, `if let`, iterator chains
- Pure functions, minimize side effects. Early returns with `?`

## Duplication — Deslop

Code duplication is debt. SharpLsp is Rust + C# + F# — all Deslop-supported. The
ratcheted duplication ceiling lives in `.deslop.toml` (`[threshold].max_duplication_percent`)
and is the committed source of truth — **never** a hardcoded number in CI YAML or an
env var. Ratchet **down only**; raising it requires written PR justification. (See
[CI-DESLOP].)

Use the Deslop MCP tools to prevent duplication, not just measure it:

- **BEFORE authoring** any function, method, class, helper, fixture, or test setup →
  call `find-similar`. `signals.fused ≥ 0.85` or an `identical`/`nearly_identical`
  bucket → **reuse the existing code, do not duplicate**; `0.6 ≤ fused < 0.85` → review
  the canonical occurrence and bias toward reuse; `fused < 0.6` or empty → proceed.
- **AFTER changing code** → `rescan`, then `top-offenders` (worst clusters by severity)
  and `cluster-by-id` (full member list for a cluster you plan to merge). Use
  `report-for-file` / `report-for-range` for a specific file or selection. Call
  `schema-doc` once per session to learn the report shape.
- **NEVER silence findings** by widening the threshold, marking code `hidden`, or
  splitting it into trivially different shapes.

# Multi-Agent Coordination (too-many-cooks)

All agents MUST use tmc to coordinate. No exceptions.

1. **Register immediately** — call `mcp__too-many-cooks__register`. Store your key.
2. **Broadcast intent** — before starting work, broadcast what you plan to do and which files you'll touch.
3. **Lock before editing** — call `mcp__too-many-cooks__lock` (action: `acquire`) on every file before modifying it.
4. **Update your plan** — call `mcp__too-many-cooks__plan` (action: `update`) with your current goal.
5. **Check messages frequently** — call `mcp__too-many-cooks__message` (action: `get`) regularly.
6. **Release locks immediately** after editing. Don't hoard locks.
7. **Signal completion** — broadcast when you finish so other agents can proceed.

```
register -> broadcast intent -> acquire locks -> update plan -> do work -> release locks -> broadcast completion
```

# Documentation Structure

All documentation lives in `docs/`.

- `docs/specs/` — **Specifications**: describe **how functionality works**. Source of truth for feature behavior, protocols, and architecture. Naming: `[COMPONENT]-[FEATURE]-SPEC.md`
- `docs/plans/` — **Implementation plans**: describe **how we are going to build it**. Each plan includes TODO checklists at the bottomm tracking progress toward the corresponding spec. Naming: `[COMPONENT]-[FEATURE]-PLAN.md`

`docs/specs/SHARPLSP-SPEC.md` is the **full technical specification** for the project. Always read the relevant spec before working on a feature, and update the corresponding plan's TODOs as work progresses.

## Spec IDs

Every spec section MUST have a hierarchical ID: `[GROUP-TOPIC]` or `[GROUP-TOPIC-DETAIL]`. IDs are uppercase, hyphen-separated, NEVER numbered. The first word is the group — sections sharing a group must be adjacent. All code and tests implementing a spec section MUST reference its ID in a comment (e.g., `// Implements [AUTH-TOKEN-VERIFY]`).

Always propagate these to code and tests. We want as much cross-referencing as possible

# Critical Docs

- [LSP Specification 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- [DAP Specification](https://microsoft.github.io/debug-adapter-protocol/specification)
- [Roslyn API Docs](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis)
- [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/)
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/)

# Architecture

Three-tier architecture:

- **Tier 1 — Rust LSP Host**: LSP connection (JSON-RPC over stdio), VFS, tree-sitter incremental parsing (C# + F#), request routing, sidecar lifecycle
- **Tier 2 — C# Sidecar (Roslyn)**: Long-running .NET process, MSBuildWorkspace, full Roslyn API (completions, diagnostics, refactorings, formatting)
- **Tier 3 — F# Sidecar (FCS)**: Long-running .NET process, FSharpChecker, Fantomas, FSharpLint

IPC: MessagePack over named pipes (Windows) / Unix domain sockets (Linux, macOS). 4-byte LE length prefix framing. Target <500us round-trip overhead.

C# and F# are equal first-class citizens. F# is NOT a second-class bolt-on.

See `docs/specs/SHARPLSP-SPEC.md` for the full technical specification.

## Code Structure

- Small, focused functions (<20 lines)
- Low cognitive complexity (clippy::cognitive_complexity enabled)
- Descriptive variable names (no single letters except in closures)
- Group related functionality into modules
- Public APIs must have documentation

## Bug Fix Process

1. Write a test that fails because of the bug
2. Run the test — confirm it fails BECAUSE of the bug
3. Repeat until it's failing for the right reason
4. Fix the bug (do NOT change the test)
5. Run the test — confirm it passes

## Performance Targets

- Cold start: <3s to first LSP response
- Completions: <100ms p50, <200ms p95
- Go-to-definition: <100ms p50, <250ms p95
- Diagnostics refresh: <500ms from keystroke
- tree-sitter re-parse: <1ms per keystroke
- Document symbols / folding: <10ms (tree-sitter, Rust-only)
- Sidecar crash recovery: <3s

## Request Routing

| Category | Handler | Latency Target | Examples |
|----------|---------|---------------|----------|
| Syntax-only | Rust (tree-sitter) | <5ms | documentSymbol, foldingRange, selectionRange |
| Semantic | Sidecar (Roslyn/FCS) | <200ms | completion, hover, definition, references, rename |
| Hybrid | Rust + Sidecar | <100ms | semanticTokens |
| Cached | Rust (salsa) | <1ms | Repeat requests for unchanged documents |

## Website and CSS

- **MINIMIZE CSS CLASSES** — consolidate where possible
- Name classes after what the element IS, not what section it's in
- **Do not use common LLM colors like purple** — use RNG and color wheels

## Key Technology Stack

### Rust Host
`lsp-server`, `lsp-types` (LSP 3.17), `tree-sitter` + `tree-sitter-c-sharp`, `tokio` (async), `rmp-serde` (MessagePack), `tracing` (logging), `dashmap` (concurrent maps)

### C# Sidecar
`Microsoft.CodeAnalysis` 5.3.0 (Roslyn), `Microsoft.CodeAnalysis.Workspaces.MSBuild`, `Microsoft.Build.Locator`, `ICSharpCode.Decompiler`, `MessagePack-CSharp`

### F# Sidecar
`FSharp.Compiler.Service` 43.9+, `Fantomas.Core`, `FSharpLint.Core`, `MessagePack-CSharp`

## Migration to `lspkit`

The cross-cutting LSP + cross-language sidecar scaffolding in this repo (LSP server, VFS, sidecar transport + lifecycle, diagnostics pipeline, TOML config) is being distilled into the generic `lspkit-*` workspace at `/Users/christianfindlay/Documents/Code/lsp_toolkit`. The .NET-specific semantic engines (Roslyn, FCS) stay here; the protocol shells are what migrate.

**For new LSP infrastructure work:** prefer `lspkit-*` crates over reinventing it here.
**For changes to existing scaffolding in this repo:** flag in the PR description if the patch duplicates `lspkit` functionality, and reference the upstream crate.

Mapping (current → toolkit crate):

| Current path | Toolkit crate |
|---|---|
| `src/main.rs:138–262` `lsp-server`-based entrypoint | `lspkit-server` (hand-rolled JSON-RPC + `Dispatcher` + `Capabilities`) |
| `src/vfs.rs` `Vfs` document state | `lspkit-vfs::Vfs` + `lspkit-vfs::PositionEncoding` |
| `src/sidecar/protocol.rs` `Envelope` framing | `lspkit-sidecar::transport` (length-prefixed frames, payload format is consumer's choice) |
| `src/sidecar/transport.rs` `FramedTransport` | `lspkit-sidecar::transport::{read_frame, write_frame}` |
| `src/sidecar/manager.rs` `SidecarManager` (spawn / health / restart / correlation) | `lspkit-sidecar::lifecycle::Sidecar` + `lspkit-sidecar::correlator::Correlator` |
| `src/diagnostics.rs` + `pull_diagnostics.rs` diagnostic publication | `lspkit-server::diagnostics::DiagnosticsBus` |
| `src/config.rs` `sharplsp.toml` loader | `lspkit-config::load_from_ancestor` |
| `src/handlers.rs` syntax-only handlers | `lspkit-server::Dispatcher::register` per method name |
| `src/semantic_tokens.rs` `TokenCache` | (consumer-side cache; not in toolkit) |
| .NET sidecar projects (`sidecars/SharpLsp.Sidecar.*`) | (engine — stays here. `lspkit-sidecar` is pure transport and does not bundle .NET- or Roslyn-specific code) |

Code in this repo is **not** being removed — it stays canonical until the toolkit matures. This note exists so future agents reuse `lspkit` for new servers and avoid widening this repo's scaffolding.
