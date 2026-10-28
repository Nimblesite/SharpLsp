# AGENTS.md
<!-- agent-pmo:a72c926 -->

SharpLsp is an open-source, editor-agnostic .NET LSP (C# + F#) built in Rust: one server, the complete .NET development experience in every editor. Stack: C#, Rust, TypeScript

All large files like videos MUST go in Git LFS

**Aim #1: Fix the .NET developer experience.**
Match and surpass Visual Studio, Rider, and C# Dev Kit — no proprietary dependencies, licenses, or vendor lock-in.

**Aim #2: Treat F# as a first-class citizen.**
F# ahead of C# on every new feature. F# never takes the back seat.

# Workflow

- **Sub agents are illegal.** Delegate by spawning `pi` sessions (Kimi 3.1 -> GLM 5.3 -> Deepseek 4.1 and flash equivalents) — you are **responsible** for their output
- **Plans (`docs/plans/`) are the backlog and GitHub issues is for problem tracking.** Work toward checking off their items; delete a plan once it is complete
- **Closing a GitHub issue requires testing a released, published version** No closing issues as you fix the bug
- ⛔️ **Never attribute a commit to yourself**: no `Co-Authored-By`, no agent name. *Never overridable*
- **Coordinate with other agents** through Too Many Cooks or built-in messaging: lock the files you edit, and never edit a file another agent has locked
- **Never kill VS Code processes** — desktop or browser. They belong to the user
- **Don't ask the user questions.** Use your judgment
- **Keep responses tight.** Never reply with a stream of messages; punctuate a critical point with an emoji

# Code

## Invariants (Hard Rules)

- **No SharpLsp code is "legacy".** Code that doesn't match the specs is deleted, never copied — move files, don't duplicate them
- **All screens must be 100% reactive** to data changes. Manage state with Signals in the VSIX and other extensions
- **Zero code duplication.** Run Deslop (see *Duplication*) before adding code and after editing
- **Minimize GitHub spend** Check that action usage isn't unnecessarily spending money
- **Paths are handled in *one* place per tier** — [SHARPLSP-ARCHITECTURE-PATHS]. Every path-string operation
  (normalise, compare, key, case rule, resolve, split, extension test, URI conversion) lives only in that
  tier's path module: `SharpLsp.Sidecar.Common.NativePaths` (sidecars), `src/sharplsp/src/paths.rs` (host),
  `src/editors/vscode/src/paths.ts` (extension). Elsewhere, *never* call `System.IO.Path`, `std::path`
  string operations, `node:path`, `StringComparison.OrdinalIgnoreCase`, `ToUpperInvariant`/`ToLowerInvariant`,
  or `OperatingSystem.IsWindows()` on a path
- **Functional style, every language.** `Result<T,E>` and `Option<T>` everywhere, expressions over statements — `match`, `if let`, iterator chains, pure functions, minimal side effects, early returns with `?`. C#/F# nullability stands in for `Option<T>`
- **Anything that can throw or panic returns `Result<T,E>`** (`outcome` in .NET — use the exhaustion analyzer)
- **Never use regex or string matching on code.** Use the real AST/CST — no line splicing, regex replacement, or string concatenation
- **`allow(clippy::` needs a strong, documented reason.** Aggressively remove existing allows
- **Code files < 500 LOC. Functions < 20 LOC**
- Aggressively move shared code into shared crates/modules
- Keep dependency versions in sync across `.github/workflows/ci*.yml` (reusable workflows — [DIST-CI-LAYOUT]) and `.devcontainer/Dockerfile`
- **Never copy from C# Dev Kit, Rider, or Visual Studio.** Reimplement from public APIs and protocols only

## Testing

- **Never delete failing tests or remove/weaken assertions** to make tests pass
- **100% test coverage** and a high mutation score
- Go heavy on **spec-derived assertions**, not just coverage
- **Many user interactions per test, many assertions per interaction** — aim for 2-3 interactions, 3+ assertions each
- **Add failing tests** for broken or missing functionality
- Ignore a test *only* when the functionality is entirely missing, and file a GitHub issue for it
- Test against **real** .sln/.csproj/.fsproj files, not mocks

## Bug Fix Process

1. Write a test that fails because of the bug
2. Run it and confirm the bug is why it fails
3. Fix the bug **without changing the test**
4. Run the test and confirm it passes

## Rust Quality Standards

- Run clippy and fmt routinely; fix violations immediately
- All lints at highest strictness (Cargo.toml `[lints]`)
- **`unsafe`, `unwrap()` is forbidden** (`unsafe_code = "deny"`)
- **No `panic!`, `todo!`, `unimplemented!`** — return `Result<T,E>` and use `?`

## .NET Sidecar Quality Standards

- C# sidecar targets net10.0
- Nullable reference types everywhere (`<Nullable>enable</Nullable>`)
- No `#pragma warning disable` without justification
- MessagePack serialization must be AOT-compatible
- **A sidecar crash must never take down the Rust host**

## Duplication — [Deslop](https://deslop.live/docs/for-ai/) (MCP or CLI)

**CI must ratchet the duplication score down.** *Never* raise the threshold.

- **Before authoring** any function, method, class, helper, fixture or test setup → `find-similar`:
  `fused ≥ 0.85` or an `identical`/`nearly_identical` bucket → **reuse it**;
  `0.6 ≤ fused < 0.85` → read the canonical occurrence and bias toward reuse; below → proceed
- **After changing code** → `rescan`, then `top-offenders` and `cluster-by-id`. `report-for-file` /
  `report-for-range` cover one file or selection; `schema-doc` once per session for the report shape

## Website and CSS

- **Minimize CSS classes** — consolidate wherever possible
- CSS budget: **2k LOC**
- Name classes after what the element *is*, not the section it sits in
- All docs and blogs etc. use "prose" classes
- Thorough tests in pipeline and each test must run in at least two form factors: desktop landscape and phone portrait
- Avoid default LLM palettes such as purple

## Logging

**Structured loggers only**: `tracing` (Rust), Serilog (sidecars), channel logger (editors) — never `println!`, `Console.WriteLine`, `printfn`, `console.log`.

- ⛔️ **Never log PII, secrets or file contents** — only presence, URIs, ranges, lengths
- Structured fields, *never* interpolation: `{ method, uri, ms }`
- Log entry/exit of LSP requests, sidecar spawn/restart, workspace load, IPC round-trips. **No silent failures**
- Async sinks; never block requests or the UI thread. VS Code: state-folder file + Output Channel

# Git

> ⛔️ **Don't make git changes like creating new branches or worktrees** unless the user asks or a skill demands it.
- Commit and push to submodules before commiting and pushing the feature branch
- Commit and push after each major change
- **One feature branch**, never `git worktree`. Work the open one; several open → merge them immediately
- **Never push to `main`.** PR → CI green → squash-merge → delete the branch
- **Own every PR until green**: `gh pr merge --auto --squash`, then fix and push until all checks pass
- Branch naming: `feature/[ISSUE]-[slug]`, `fix/[ISSUE]-[slug]`, `chore/[slug]`, `release/[semver]`
- **Files over 4 MB live in Git LFS.** Before committing one, add its rule to the root `.gitattributes`
  (`*.ext filter=lfs diff=lfs merge=lfs -text`, or the exact path for a normally small type) and confirm
  with `git lfs ls-files`. Move a raw-committed file with `git lfs migrate import --no-rewrite <path>`;
  *never* rewrite `main` history. Workflows consuming LFS files check out with `lfs: true`
- File a bug issue for each release bug
- Auto-memory is **off** (`autoMemoryEnabled: false`) — persistent rules land via a reviewed PR here

# Documentation Structure

All documentation lives in `docs/`:

- `docs/specs/` — **specifications**: the source of truth for behavior, protocols and architecture. Naming: `[COMPONENT]-[FEATURE]-SPEC.md`
- `docs/plans/` — **implementation plans**, each ending in TODO checklists tracking progress toward its spec. Naming: `[COMPONENT]-[FEATURE]-PLAN.md`

`docs/specs/SHARPLSP-SPEC.md` is the **full technical specification**. **Read the relevant spec before starting a feature**; update the matching plan's TODOs as you go.

All diagrams are **Mermaid**, except model design: that **must** use [typeDiagram](https://typediagram.dev/docs/language-reference.html), with the type code generated *from* it.

## Spec IDs

Every spec section **must** have a hierarchical ID: `[GROUP-TOPIC]` or `[GROUP-TOPIC-DETAIL]` — uppercase, hyphen-separated, **never numbered**. The first word is the group; sections sharing one must be adjacent. IDs are cross-referenced across specs, plans, code and tests: code and tests implementing a section **must cite its ID** in a comment (e.g. `// Implements [AUTH-TOKEN-VERIFY]`).

# Architecture

- **Tier 1 — Rust LSP Host**: LSP connection (JSON-RPC over stdio), VFS, tree-sitter incremental parsing (C# + F#), request routing, sidecar lifecycle
- **Tier 2 — C# Sidecar (Roslyn)**: long-running .NET process, MSBuildWorkspace, full Roslyn API (completions, diagnostics, refactorings, formatting)
- **Tier 3 — F# Sidecar (FCS)**: long-running .NET process, FSharpChecker, Fantomas, FSharpLint

IPC: MessagePack over named pipes (Windows) / Unix domain sockets (Linux, macOS), 4-byte LE length-prefix framing. Target <500us round-trip overhead.

## Request Routing

| Category | Handler | Latency Target | Examples |
|----------|---------|---------------|----------|
| Syntax-only | Rust (tree-sitter) | <5ms | documentSymbol, foldingRange, selectionRange |
| Semantic | Sidecar (Roslyn/FCS) | <200ms | completion, hover, definition, references, rename |
| Hybrid | Rust + Sidecar | <100ms | semanticTokens |
| Cached | Rust (salsa) | <1ms | Repeat requests for unchanged documents |

## lspkit — https://github.com/Nimblesite/lspkit

**lspkit is the shared toolkit under every Nimblesite language server, and home of the profiler.** Git submodule `lspkit/` (`git submodule update --init`), pinned until its next crates.io/npm release.

- **The profiler is lspkit's.** Its crates (`lsp-profiler`, `lsp-profiler-dotnet`), .NET engine (`lspkit/dotnet/`), VS Code UI (`lspkit/packages/lsp-profiler-ui`) and spec (`lspkit/docs/specs/LSP-PROFILER-SPEC.md`) live there; SharpLsp only mounts it ([PROFILER-SHARED-LIBRARY]). Change lspkit first, then move the submodule pointer. *Never* fork profiler code back here
- **Migrate onto lspkit surgically.** The scaffolding here (server loop, VFS, sidecar transport and lifecycle, diagnostics pipeline, TOML config, DAP glue) duplicates `lspkit-*` crates and `@nimblesite/lspkit-debug`. Replace one piece per reviewable change, tests passing. The Roslyn and FCS engines stay; the protocol shells move
- **New LSP infrastructure goes in lspkit.** A patch that duplicates lspkit scaffolding says so in its PR description and names the crate that should own it
- **Wiring:** Cargo path dependencies point into `lspkit/crates/` (excluded from the root workspace); `make _build-dotnet` publishes the engine to `target/profiler-engine`; `make _build-profiler-ui` builds the UI package `npm ci` packs into the extension. CI checks out the public submodule without a token

# Critical Docs

- [LSP Specification 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- [DAP Specification](https://microsoft.github.io/debug-adapter-protocol/specification)
- [Roslyn API Docs](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis)
- [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/)
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/)
