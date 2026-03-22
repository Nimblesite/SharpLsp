# CLAUDE.md

⚠️ KILLING A VSCODE PROCESS - EVEN IN THE BROWSER WILL BE MET WITH INSTANT, EXTREME VIOLENCE!
⚠️ DO NOT KILL VSCODE PROCESSES

Forge is an open-source, editor-agnostic .NET LSP (C# + F#) built in Rust. One LSP server = complete .NET development experience across every editor.

**Overall aim #1: FIX THE .NET DEVELOPER EXPERIENCE.**
Crush Visual Studio, Rider, and C# Dev Kit. Not approximate parity — full feature-for-feature superiority. Zero proprietary dependencies. Zero licenses. Zero vendor lock-in.

**Overall aim #2: TREAT F# AS A FIRST CLASS CITIZEN.**
F# deserves a top notch development experience. We will put F# ahead of C# when building new features so that F# never takes the backseat.

# Code

## Principles

We treat this codebase with respect. This code would pass a review at Google, Meta, or Microsoft. We don't allow bad or duplicate code. Not even one line. This codebase receives a grade A+. Anything lesser in quality is illegal and must be fixed immediately.

- Logging is critical. Can't see what's happening? Add more logging immediately (use `tracing` crate, `ILogger` in .NET)
- 100% test coverage is only the start
- No unit tests. Only COARSE e2e tests

## Hard Rules

- Do not use Git.
- Zero duplication. DRY AF!!! Check for existing code before writing new code <- Highest priority
- Any function that can throw/panic must be wrapped in try/catch and return Result<T,E> (outcome package in .NET)
- Avoid RegEx and string matching. Always use ACTUAL parsers and traverse the AST/CST
- `allow(clippy::` = ILLEGAL. If you must, add a damn good reason. **Aggressively remove** existing allows.
- All code files < 500 LOC. Break up larger files
- Functions < 20 LOC
- Aggressively move shared code to shared crates/modules
- Keep dependencies and versions in sync across: `.github/workflows/ci.yml`, `.devcontainer/Dockerfile`
- There is NO SUCH THING AS LEGACY CODE. Legacy = DELETED
- Copying files is illegal. MOVE them instead
- Never copy from C# Dev Kit, Rider, or Visual Studio proprietary code. Reimplement from public APIs and protocols only

## Testing

Testing is absolutely critical. We aim for 100% test coverage and a high mutation score at all times. Focus on assertions; not just coverage.

- NEVER DELETE FAILING TESTS
- NEVER REMOVE ASSERTIONS THAT CAUSE TEST FAILURES
- ADD more failing tests for broken/missing functionality — NEVER remove them
- REDUCING TEST ASSERTIVENESS = DATA CENTER DISMANTLED
- Ignoring tests = ILLEGAL
- Test against real .sln/.csproj/.fsproj files, not mocks

## TypeScript Quality Standards

- Lints up to error on every rule
- Any function that may throw must be wrapped in try/catch and return Result<T,E>
- Regularly run the linters and check for errors

## Rust Quality Standards

- Run clippy and fmt routinely, fix violations immediately
- All lints at highest strictness (see Cargo.toml `[lints]`)
- Add lints to Cargo.toml if in doubt. Never remove
- `unsafe` code forbidden (`unsafe_code = "deny"`)
- `unwrap()` is ALWAYS a violation. Use `?` with proper error types
- No `panic!`, `todo!`, `unimplemented!` — handle all cases, return `Result<T,E>`

## .NET Sidecar Quality Standards

- C# sidecar targets .NET 9.0+
- Use nullable reference types everywhere (`<Nullable>enable</Nullable>`)
- No `#pragma warning disable` without justification
- MessagePack serialization must be AOT-compatible
- Sidecar crash must never take down the Rust host

## Functional Programming Style

- `Result<T,E>` and `Option<T>` everywhere
- Expressions over statements — `match`, `if let`, iterator chains
- Pure functions, minimize side effects
- Pattern matching over casting or unwrapping
- Early returns with `?` for clean error propagation

# Multi-Agent Coordination (too-many-cooks)

When multiple agents work on this repo simultaneously, **all agents MUST use tmc to coordinate**. No exceptions.

## Rules

1. **Register immediately** — first thing on startup, call `mcp__too-many-cooks__register` with a descriptive name. Store your key.
2. **Broadcast intent** — before starting work, send a broadcast message (`to_agent: "*"`) stating what you plan to do and which files you'll touch.
3. **Lock before editing** — call `mcp__too-many-cooks__lock` (action: `acquire`) on every file before modifying it. If locked by another agent, message them to coordinate.
4. **Update your plan** — call `mcp__too-many-cooks__plan` (action: `update`) with your current goal and task so other agents can see what you're doing.
5. **Check messages frequently** — call `mcp__too-many-cooks__message` (action: `get`) regularly. Respond to other agents promptly.
6. **Release locks immediately** — release file locks as soon as you're done editing. Don't hoard locks.
7. **Signal completion** — broadcast when you finish a task so other agents can proceed with dependent work.

## Workflow

```
register -> broadcast intent -> acquire locks -> update plan -> do work -> release locks -> broadcast completion
```

Failing to coordinate = merge conflicts, duplicated work, and wasted time. **Use tmc or don't touch the repo.**

# Documentation Structure

All documentation lives in `docs/`.

- `docs/specs/` — **Specifications**: describe **how functionality works**. Source of truth for feature behavior, protocols, and architecture. Naming: `[COMPONENT]-[FEATURE]-SPEC.md`
- `docs/plans/` — **Implementation plans**: describe **how we are going to build it**. Each plan includes TODO checklists tracking progress toward the corresponding spec. Naming: `[COMPONENT]-[FEATURE]-PLAN.md`

`docs/specs/FORGE-SPEC.md` is the **full technical specification** for the project. Always read the relevant spec before working on a feature, and update the corresponding plan's TODOs as work progresses.

# Critical Docs

- [LSP Specification 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- [DAP Specification](https://microsoft.github.io/debug-adapter-protocol/specification)
- [Roslyn API Docs](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis)
- [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/)
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/)
- [salsa (incremental computation)](https://salsa-rs.netlify.app/)

# Architecture

Three-tier architecture:

- **Tier 1 — Rust LSP Host**: LSP connection (JSON-RPC over stdio), VFS, tree-sitter incremental parsing (C# + F#), salsa cache, request routing, sidecar lifecycle
- **Tier 2 — C# Sidecar (Roslyn)**: Long-running .NET process, MSBuildWorkspace, full Roslyn API (completions, diagnostics, refactorings, formatting)
- **Tier 3 — F# Sidecar (FCS)**: Long-running .NET process, FSharpChecker, Ionide.ProjInfo, Fantomas, FSharpLint

IPC: MessagePack over named pipes (Windows) / Unix domain sockets (Linux, macOS). 4-byte LE length prefix framing. Target <500us round-trip overhead.

C# and F# are equal first-class citizens. F# is NOT a second-class bolt-on.

See `docs/specs/FORGE-SPEC.md` for the full technical specification.

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
`lsp-server`, `lsp-types` (LSP 3.17), `salsa` (incremental), `tree-sitter` + `tree-sitter-c-sharp` + `tree-sitter-fsharp`, `tokio` (async), `rmp-serde` (MessagePack), `interprocess` (IPC), `tracing` (logging), `notify` (file watching), `dashmap` (concurrent maps)

### C# Sidecar
`Microsoft.CodeAnalysis` 5.3.0+ (Roslyn), `Microsoft.CodeAnalysis.Workspaces.MSBuild`, `Microsoft.Build.Locator`, `ICSharpCode.Decompiler`, `MessagePack-CSharp`

### F# Sidecar
`FSharp.Compiler.Service` 43.12+, `Ionide.ProjInfo`, `Fantomas`, `FSharpLint.Core`, `FSharp.Analyzers.SDK`, `MessagePack-CSharp`
