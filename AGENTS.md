# AGENTS.md
<!-- agent-pmo:a72c926 -->

SharpLsp is an open-source, editor-agnostic .NET LSP (C# + F#) built in Rust. One LSP server = complete .NET development experience across every editor. Key Technology Stack: C#, Rust, Typescript

**Overall aim #1: FIX THE .NET DEVELOPER EXPERIENCE.**
Match and surpass Visual Studio, Rider, and C# Dev Kit — no proprietary dependencies, licenses, or vendor lock-in.

**Overall aim #2: TREAT F# AS A FIRST CLASS CITIZEN.**
F# ahead of C# on every new feature. F# never takes the back seat.

# Code

## Invariants (Hard Rules)

- ⚠️ Never kill VS Code processes — desktop or browser. They belong to the user
- ⚠️ Don't ask the user questions. Use your judgment
- ⚠️ Keep responses tight. Never reply with a stream of messages; punctuate a critical point with an emoji
- ⛔️ Sub agents are ILLEGAL
- There is no SharpLsp "legacy" code. Code that does not match the specs is deleted, never copied — move files, don't duplicate them
- **All screens MUST BE 100% reactive.** When the data changes, the screen is listening and updates. Manage state with Signals in the VSIX and other extensions
- **Zero code duplication.** Run Deslop (https://deslop.live/docs/for-ai/ — MCP or CLI) before adding code and after editing
- ⛔️ **Paths are handled in ONE place per tier** — [SHARPLSP-ARCHITECTURE-PATHS]. Every operation on a path
  string (normalising, comparing, keying a map, choosing the case rule, resolving against a directory,
  splitting into directory/name/stem, testing the extension, converting to or from a URI) lives in that
  tier's path module and nowhere else: `SharpLsp.Sidecar.Common.NativePaths` (both sidecars),
  `src/sharplsp/src/paths.rs` (host), `src/editors/vscode/src/paths.ts` (extension). Outside it, never
  call `System.IO.Path`, `std::path` string operations, `node:path`, `StringComparison.OrdinalIgnoreCase`,
  `ToUpperInvariant`/`ToLowerInvariant`, or `OperatingSystem.IsWindows()` on a path. Never scatter, never repeat
- **Functional style, every language.** `Result<T,E>` and `Option<T>` everywhere, expressions over statements — `match`, `if let`, iterator chains, pure functions, minimal side effects. Early returns with `?`. C#/F# nullability stands in for `Option<T>`
- Anything that can throw or panic returns `Result<T,E>` (`outcome` in .NET — use the exhaustion analyzer)
- **Never use RegEx or string matching on code.** Always use the real AST/CST — no line splicing, regex replacement, or string concatenation
- `allow(clippy::` needs a strong, documented reason. **Aggressively remove** existing allows
- All code files < 500 LOC. Functions < 20 LOC
- Aggressively move shared code into shared crates/modules
- Keep dependencies and versions in sync across `.github/workflows/ci*.yml` (split into reusable workflows — see [DIST-CI-LAYOUT]) and `.devcontainer/Dockerfile`
- Never copy from C# Dev Kit, Rider, or Visual Studio. Reimplement from public APIs and protocols only

## Testing

- **Never delete failing tests or remove/weaken assertions** to make tests pass
- **100% test coverage and a high mutation score**
- **Go heavy on spec-derived assertions**, not just coverage
- **Many user interactions per test, many assertions per interaction** — aim for 2-3 interactions, 3+ assertions each
- **Add failing tests for broken or missing functionality**
- Ignore a test ONLY when the functionality is missing entirely, and file a GitHub issue saying so
- Test against real .sln/.csproj/.fsproj files, not mocks

## Rust Quality Standards

- Run clippy and fmt routinely; fix violations immediately
- All lints at highest strictness (see Cargo.toml `[lints]`)
- `unsafe` is forbidden (`unsafe_code = "deny"`)
- `unwrap()` is ALWAYS a violation — use `?` with proper error types
- No `panic!`, `todo!`, `unimplemented!` — return `Result<T,E>`

## .NET Sidecar Quality Standards

- C# sidecar targets net10.0
- Nullable reference types everywhere (`<Nullable>enable</Nullable>`)
- No `#pragma warning disable` without justification
- MessagePack serialization must be AOT-compatible
- A sidecar crash must never take down the Rust host

# Git

⛔️ Don't touch git unless the user asks or a skill demands it.

- ⛔️ ONE feature branch, always, and never `git worktree`. Work the open one; never cut a second.
  Several open → merge them immediately
- ⛔️ Never push to `main`. PR → CI green → squash-merge → delete the branch
- ⛔️ Never attribute a commit to yourself: no `Co-Authored-By`, no agent name. Never overridable
- Own every PR until green: `gh pr merge --auto --squash`, then read the logs, fix and push until
  all checks pass
- Branch naming: `feature/[ISSUE]-[slug]`, `fix/[ISSUE]-[slug]`, `chore/[slug]`, `release/[semver]`
- Log BUG issues for release bugs
- Auto-memory is OFF (`autoMemoryEnabled: false`) — persistent rules land via a reviewed PR here

# Logging

Structured logger only — `tracing` (Rust), `Microsoft.Extensions.Logging` (sidecars), channel
logger (editors). `println!`, `Console.WriteLine`, `printfn`, `console.log` are prohibited.

- ⛔️ NEVER log PII (names, emails, addresses, phones, IPs), secrets, or file *contents* — log
  `"API key: present"`, URIs, ranges and lengths
- Log entry/exit of significant operations: LSP requests, sidecar spawn/restart, workspace load,
  IPC round-trips. No silent failures
- Structured fields, never interpolation: `{ method, uri, ms }`
- VS Code extension: a file under its state folder AND the Output Channel, both always on
- I/O sinks are async: a write never blocks a request or the UI thread

## Duplication — [Deslop](https://deslop.live/docs/for-ai/) (MCP or CLI)

**CI MUST ratchet the duplication score down.** Never raise the threshold.

- **BEFORE authoring** any function, method, class, helper, fixture or test setup → `find-similar`:
  `fused ≥ 0.85`, or an `identical`/`nearly_identical` bucket → **reuse it, do not duplicate**;
  `0.6 ≤ fused < 0.85` → read the canonical occurrence and bias toward reuse; below → proceed
- **AFTER changing code** → `rescan`, then `top-offenders` and `cluster-by-id`. `report-for-file` /
  `report-for-range` cover one file or selection; `schema-doc` once per session for the report shape

# Multi-Agent Coordination (too-many-cooks)

⛔️ All agents MUST coordinate through the `mcp__too-many-cooks__*` tools. No exceptions.

- `register` first; store your key
- Broadcast intent before starting: what you'll do, which files
- `lock` (`acquire`) every file before editing; release immediately after — don't hoard locks
- `plan` (`update`) your current goal; `message` (`get`) frequently
- Broadcast when you finish so other agents can proceed

# Documentation Structure

All spec sections have a heirarchically structured, non-numeric name. This is always cross-referenced between specs, code, plans and tests. 

All documentation lives in `docs/`.

- `docs/specs/` — **specifications**: how functionality works. Source of truth for behavior, protocols and architecture. Naming: `[COMPONENT]-[FEATURE]-SPEC.md`
- `docs/plans/` — **implementation plans**: how we are going to build it. Each plan ends with TODO checklists tracking progress toward its spec. Naming: `[COMPONENT]-[FEATURE]-PLAN.md`

`docs/specs/SHARPLSP-SPEC.md` is the **full technical specification**. Read the relevant spec before working on a feature, and update the matching plan's TODOs as work progresses.

All diagrams are MERMAID, except model design: that MUST use [typeDiagram](https://typediagram.dev/docs/language-reference.html), and you MUST generate the type code FROM the typeDiagram.

## Spec IDs

Every spec section MUST have a hierarchical ID: `[GROUP-TOPIC]` or `[GROUP-TOPIC-DETAIL]` — uppercase, hyphen-separated, NEVER numbered. The first word is the group; sections sharing one must be adjacent. Code and tests implementing a section MUST cite its ID in a comment (e.g. `// Implements [AUTH-TOKEN-VERIFY]`).

# Critical Docs

- [LSP Specification 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- [DAP Specification](https://microsoft.github.io/debug-adapter-protocol/specification)
- [Roslyn API Docs](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis)
- [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/)
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/)

# Architecture

Three tiers:

- **Tier 1 — Rust LSP Host**: LSP connection (JSON-RPC over stdio), VFS, tree-sitter incremental parsing (C# + F#), request routing, sidecar lifecycle
- **Tier 2 — C# Sidecar (Roslyn)**: long-running .NET process, MSBuildWorkspace, full Roslyn API (completions, diagnostics, refactorings, formatting)
- **Tier 3 — F# Sidecar (FCS)**: long-running .NET process, FSharpChecker, Fantomas, FSharpLint

IPC: MessagePack over named pipes (Windows) / Unix domain sockets (Linux, macOS), 4-byte LE length-prefix framing. Target <500us round-trip overhead.

## Bug Fix Process

1. Write a test that fails because of the bug
2. Run it and confirm the bug is why it fails
3. Fix the bug without changing the test
4. Run the test and confirm it passes

## Request Routing

| Category | Handler | Latency Target | Examples |
|----------|---------|---------------|----------|
| Syntax-only | Rust (tree-sitter) | <5ms | documentSymbol, foldingRange, selectionRange |
| Semantic | Sidecar (Roslyn/FCS) | <200ms | completion, hover, definition, references, rename |
| Hybrid | Rust + Sidecar | <100ms | semanticTokens |
| Cached | Rust (salsa) | <1ms | Repeat requests for unchanged documents |

## Website and CSS

- **MINIMIZE CSS CLASSES** — consolidate wherever possible
- CSS budget: 2k LOC
- Name classes after what the element IS, not the section it sits in
- Avoid default LLM palettes such as purple

## Migration to `lspkit`

The cross-cutting LSP + sidecar scaffolding here (LSP server, VFS, sidecar transport + lifecycle, diagnostics pipeline, TOML config) is being distilled into the generic `lspkit-*` workspace at `/Users/christianfindlay/Documents/Code/lsp_toolkit`. The .NET semantic engines (Roslyn, FCS) stay; the protocol shells migrate.

**New LSP infrastructure:** prefer `lspkit-*` crates over reinventing it here.
**Changes to scaffolding here:** flag in the PR description if the patch duplicates `lspkit` functionality, and reference the upstream crate.

