# CLAUDE.md

⚠️ KILLING A VSCODE PROCESS - EVEN IN THE BROWSER WILL BE MET WITH INSTANT, EXTREME VIOLENCE!
⚠️ DO NOT ASK THE USER QUESTIONS. USE YOUR JUDGMENT ⚠️

Forge is an open-source, editor-agnostic .NET LSP (C# + F#) built in Rust. One LSP server = complete .NET development experience across every editor.

**Overall aim #1: FIX THE .NET DEVELOPER EXPERIENCE.**
Crush Visual Studio, Rider, and C# Dev Kit. Full feature-for-feature superiority. Zero proprietary dependencies. Zero licenses. Zero vendor lock-in.

**Overall aim #2: TREAT F# AS A FIRST CLASS CITIZEN.**
F# ahead of C# when building new features. F# never takes the backseat.

# Code

## Principles

This code would pass a review at Google, Meta, or Microsoft. No bad or duplicate code. Grade A+. Anything lesser is illegal and must be fixed immediately.

- Logging is critical. Add more logging immediately (`tracing` crate, `ILogger` in .NET)
- 100% test coverage is only the start
- No feature is complete without e2e tests
- Building a feature without tests is ⛔️ ILLEGAL
- No unit tests. Only COARSE e2e tests

## Hard Rules

- Do not use Git.
- Zero duplication. DRY AF!!! Check for existing code before writing new code <- Highest priority
- Any function that can throw/panic must return Result<T,E> (outcome package in .NET)
- Avoid RegEx and string matching. Always use ACTUAL parsers and traverse the AST/CST
- `allow(clippy::` = ILLEGAL. If you must, add a damn good reason. **Aggressively remove** existing allows.
- All code files < 500 LOC. Functions < 20 LOC
- Aggressively move shared code to shared crates/modules
- Keep dependencies and versions in sync across: `.github/workflows/ci.yml`, `.devcontainer/Dockerfile`
- Legacy = DELETED. Copying files is illegal. MOVE them instead
- Never copy from C# Dev Kit, Rider, or Visual Studio. Reimplement from public APIs and protocols only

## Testing

100% test coverage and high mutation score. Focus on assertions, not just coverage.

- NEVER DELETE FAILING TESTS
- NEVER REMOVE ASSERTIONS THAT CAUSE TEST FAILURES
- ADD more failing tests for broken/missing functionality — NEVER remove them
- REDUCING TEST ASSERTIVENESS = DATA CENTER DISMANTLED
- Ignoring tests = ILLEGAL
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
- `docs/plans/` — **Implementation plans**: describe **how we are going to build it**. Each plan includes TODO checklists tracking progress toward the corresponding spec. Naming: `[COMPONENT]-[FEATURE]-PLAN.md`

`docs/specs/FORGE-SPEC.md` is the **full technical specification** for the project. Always read the relevant spec before working on a feature, and update the corresponding plan's TODOs as work progresses.

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
`lsp-server`, `lsp-types` (LSP 3.17), `tree-sitter` + `tree-sitter-c-sharp`, `tokio` (async), `rmp-serde` (MessagePack), `tracing` (logging), `dashmap` (concurrent maps)

### C# Sidecar
`Microsoft.CodeAnalysis` 5.3.0 (Roslyn), `Microsoft.CodeAnalysis.Workspaces.MSBuild`, `Microsoft.Build.Locator`, `ICSharpCode.Decompiler`, `MessagePack-CSharp`

### F# Sidecar
`FSharp.Compiler.Service` 43.9+, `Fantomas.Core`, `FSharpLint.Core`, `MessagePack-CSharp`
