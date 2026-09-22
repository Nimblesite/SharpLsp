# CLAUDE.md
<!-- agent-pmo:a72c926 -->

⚠️ Never kill VS Code processes — not desktop, not browser. They belong to the user. ⚠️
⚠️ Don't ask the user questions — use your judgment. ⚠️
⚠️ Keep responses tight and to the point. Don't respond with a stream of messages. If a point is critical, punctuate it with an emoji  ⚠️ 

SharpLsp is an open-source, editor-agnostic .NET LSP (C# + F#) built in Rust. One LSP server = complete .NET development experience across every editor.

**Overall aim #1: FIX THE .NET DEVELOPER EXPERIENCE.**
Match and surpass Visual Studio, Rider, and C# Dev Kit without proprietary dependencies, licenses, or vendor lock-in.

**Overall aim #2: TREAT F# AS A FIRST CLASS CITIZEN.**
F# ahead of C# when building new features. F# never takes the backseat.

# Code

## Principles

## Invariants (Hard Rules)

- Sub agents are ⛔️ ILLEGAL
- There is no SharpLsp "legacy" code. If you find code that does not match the specs, delete it
- ***All screens MUST BE 100% reactive*** If underlying data changes, the screen must be listening and update accordingly. Use Signals to manage state in the VSIX and other extensions
- ***Zero code duplication*** Use Deslop (https://deslop.live/docs/for-ai/ - MCP or CLI) routinely before adding code and after editing.
- ***Functional Programming Style (All languages)*** `Result<T,E>` and `Option<T>` everywhere, expressions over statements — `match`, `if let`, iterator chains, pure functions, minimize side effects. Early returns with `?`. C#/F#'s nullability is fine instead of Option<T>
- Any function that can throw/panic must return Result<T,E> (outcome package in .NET - use the exhaustion analyzer)
- ***Never use RegEx or string matching on code*** Always use the actual AST/CST. Do not use line splicing, regex replacement, or string concatenation.
- `allow(clippy::` is not permitted without a strong, documented reason. **Aggressively remove** existing allows.
- All code files < 500 LOC. Functions < 20 LOC
- Aggressively move shared code to shared crates/modules
- Keep dependencies and versions in sync across: `.github/workflows/ci*.yml` (the PR pipeline is split into reusable workflows — see [DIST-CI-LAYOUT]), `.devcontainer/Dockerfile`
- Legacy code must be deleted, not copied. Move files instead of duplicating them.
- Never copy from C# Dev Kit, Rider, or Visual Studio. Reimplement from public APIs and protocols only

## Testing

- ***Never delete failing tests or remove/weaken assertions*** to make tests pass
- ***100% test coverage and high mutation score***
- ***Go heavy on spec derived assertions, not just coverage*** 
- ***Many user interactions per test, many assertions per user interaction*** aim for 2-3 user interactions with 3+ assertions for interaction
- ***Add failing tests for broken or missing functionality***
- Tests may ONLY be ignored if the functionality is missing entirely and you add GitHub issue specifying this
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

# Git

- Worktrees = ⛔️ ILLEGAL. Only one branch at a time is allowed

**Default to NOT touching git at all.** Use git only when the user has explicitly green-lit it for
the task (open a PR, merge, cut a branch). Absent that, leave commits, branches, pushes and merges
to the user and CI. Log BUG type GitHub issues when you encounter bugs in release.

The rules below govern the cases where you *have* been green-lit:

- **NEVER push to `main` directly.** Always PR → CI green → merge. No exceptions. `main` is
  protected by a ruleset that requires a PR and the `CI` status check, with branches up to date
  before merge — a direct push is rejected anyway.
- **Once you open a PR, OWN it until it is green.** Enable auto-merge (`gh pr merge --auto --squash`)
  so it lands the moment checks pass — but that does NOT end your job. Monitor the pipeline; when a
  check fails, pull the logs, fix the cause, push the fix, and loop until every required check
  passes. Never hand a PR back on a red or still-running pipeline.
- **NEVER list yourself as a commit co-author.** No `Co-Authored-By` trailer, no agent attribution
  in the commit message. This one is never overridable.
- **Work on exactly ONE branch at a time. Always.** Even when several agents share the repo — they
  share the single branch and coordinate through TMC, they do not cut their own.
- **NEVER start a new branch when a feature branch already exists.** Check first; work on the open one.
- **If multiple feature branches already exist, merge them into one IMMEDIATELY**, before any other work.
- **Worktrees are forbidden.** Never run `git worktree` unless the user explicitly demands one.

Branch naming: `feature/[ISSUE]-[slug]`, `fix/[ISSUE]-[slug]`, `chore/[slug]`, `release/[semver]`.
Default branch is `main`, never `master`. Squash-merge only; delete the branch after merge.

**Auto-memory is OFF.** Persistent rules go through a reviewed PR to this file — never auto-captured
memory. Pinned for every contributor by `"autoMemoryEnabled": false` in the committed
`.claude/settings.local.json`.

# Logging

Every diagnostic goes through a structured logging library — `tracing` in the Rust host,
`Microsoft.Extensions.Logging` in both sidecars, and the extension's own channel logger in the
editors. `println!`, `Console.WriteLine`, `printfn` and `console.log` are prohibited for diagnostics.

- **Log at entry/exit of significant operations** — LSP request handling, sidecar spawn/restart,
  workspace load, IPC round-trips. Levels: `error`, `warn`, `info`, `debug`, `trace`. Silent
  failures are forbidden.
- **Structured fields, not string interpolation.** `{ method: "textDocument/completion", uri, ms }`,
  never `"completion for {uri} took {ms}ms"`.
- **VS Code extension**: detailed structured logs to a file under the extension's state folder AND
  basic errors/diagnostics to the VS Code Output Channel — both sinks active at once, so a user can
  see failures without hunting for a file.
- **I/O sinks are async.** A log write never blocks an LSP request or the UI thread.
- **NEVER log PII** — names, emails, addresses, phone numbers, IPs.
- **NEVER log secrets.** No tokens, keys or connection strings. To confirm a key is loaded, log
  `"API key: present"` or a truncated hash — never the value. Source file *contents* are user data:
  log URIs, ranges and lengths, not the text.

## Duplication — [Deslop - MCP or CLI](https://deslop.live/docs/for-ai/) 

***CI MUST ratchet down duplication score*** Never increase the threshold

Use the Deslop MCP tools to prevent duplication, not just measure it:

- **BEFORE authoring** any function, method, class, helper, fixture, or test setup →
  call `find-similar`. `signals.fused ≥ 0.85` or an `identical`/`nearly_identical`
  bucket → **reuse the existing code, do not duplicate**; `0.6 ≤ fused < 0.85` → review
  the canonical occurrence and bias toward reuse; `fused < 0.6` or empty → proceed.
- **AFTER changing code** → `rescan`, then `top-offenders` (worst clusters by severity)
  and `cluster-by-id` (full member list for a cluster you plan to merge). Use
  `report-for-file` / `report-for-range` for a specific file or selection. Call
  `schema-doc` once per session to learn the report shape.

# Multi-Agent Coordination (too-many-cooks)

All agents MUST use tmc to coordinate. No exceptions.

1. **Register immediately** — call `mcp__too-many-cooks__register`. Store your key.
2. **Broadcast intent** — before starting work, broadcast what you plan to do and which files you'll touch.
3. **Lock before editing** — call `mcp__too-many-cooks__lock` (action: `acquire`) on every file before modifying it.
4. **Update your plan** — call `mcp__too-many-cooks__plan` (action: `update`) with your current goal.
5. **Check messages frequently** — call `mcp__too-many-cooks__message` (action: `get`) regularly.
6. **Release locks immediately** after editing. Don't hoard locks.
7. **Signal completion** — broadcast when you finish so other agents can proceed.

# Documentation Structure

All documentation lives in `docs/`.

- `docs/specs/` — **Specifications**: describe **how functionality works**. Source of truth for feature behavior, protocols, and architecture. Naming: `[COMPONENT]-[FEATURE]-SPEC.md`
- `docs/plans/` — **Implementation plans**: describe **how we are going to build it**. Each plan includes TODO checklists at the bottomm tracking progress toward the corresponding spec. Naming: `[COMPONENT]-[FEATURE]-PLAN.md`

`docs/specs/SHARPLSP-SPEC.md` is the **full technical specification** for the project. Always read the relevant spec before working on a feature, and update the corresponding plan's TODOs as work progresses.

All diagrams must be MERMAID diagrams, except for model design. Model design MUST use [typeDiagram](https://typediagram.dev/docs/language-reference.html), and you MUST generate the type code FROM the typeDiagram.

## Spec IDs

Every spec section MUST have a hierarchical ID: `[GROUP-TOPIC]` or `[GROUP-TOPIC-DETAIL]`. IDs are uppercase, hyphen-separated, NEVER numbered. The first word is the group — sections sharing a group must be adjacent. All code and tests implementing a spec section MUST reference its ID in a comment (e.g., `// Implements [AUTH-TOKEN-VERIFY]`).

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

See `docs/specs/SHARPLSP-SPEC.md` for the full technical specification.

## Bug Fix Process

1. Write a test that fails because of the bug
2. Run it and confirm the bug is the reason it fails
3. Fix the bug without changing the test
4. Run the test and confirm it passes

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
- CSS Budget 2k LOC
- Name classes after what the element IS, not what section it's in
- Avoid default LLM palettes such as purple

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
| `src/sharplsp/src/main.rs:138–262` `lsp-server`-based entrypoint | `lspkit-server` (hand-rolled JSON-RPC + `Dispatcher` + `Capabilities`) |
| `src/sharplsp/src/vfs.rs` `Vfs` document state | `lspkit-vfs::Vfs` + `lspkit-vfs::PositionEncoding` |
| `src/sharplsp/src/sidecar/protocol.rs` `Envelope` framing | `lspkit-sidecar::transport` (length-prefixed frames, payload format is consumer's choice) |
| `src/sharplsp/src/sidecar/transport.rs` `FramedTransport` | `lspkit-sidecar::transport::{read_frame, write_frame}` |
| `src/sharplsp/src/sidecar/manager.rs` `SidecarManager` (spawn / health / restart / correlation) | `lspkit-sidecar::lifecycle::Sidecar` + `lspkit-sidecar::correlator::Correlator` |
| `src/sharplsp/src/diagnostics.rs` + `pull_diagnostics.rs` diagnostic publication | `lspkit-server::diagnostics::DiagnosticsBus` |
| `src/sharplsp/src/config.rs` `sharplsp.toml` loader | `lspkit-config::load_from_ancestor` |
| `src/sharplsp/src/handlers.rs` syntax-only handlers | `lspkit-server::Dispatcher::register` per method name |
| `src/sharplsp/src/semantic_tokens.rs` `TokenCache` | (consumer-side cache; not in toolkit) |
| .NET sidecar projects (`src/sidecars/SharpLsp.Sidecar.*`) | (engine — stays here. `lspkit-sidecar` is pure transport and does not bundle .NET- or Roslyn-specific code) |

Code in this repo is **not** being removed — it stays canonical until the toolkit matures. This note exists so future agents reuse `lspkit` for new servers and avoid widening this repo's scaffolding.
