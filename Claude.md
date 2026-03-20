# CLAUDE.md

DO NOT USE GIT!!!!

WE TREAT THIS CODEBASE WITH RESPECT. THIS CODE WOULD PASS REVIEW AT Google, Meta AND Microsoft. WE DON'T ALLOW BAD CODE. NOT EVEN FOR ONE LINE. THIS CODEBASE RECEIVES A GRADE OF A+. ANYTHING LESS IS ILLEGAL AND YOU MUST FIX IT IMMEDIATELY.

Forge is an open-source, editor-agnostic .NET LSP (C# + F#) built in Rust. One LSP server = complete .NET development experience across every editor.

**Overall aim: FIX THE .NET DEVELOPER EXPERIENCE.**
Crush Visual Studio, Rider, and C# Dev Kit. Not approximate parity — full feature-for-feature superiority. Zero proprietary dependencies. Zero licenses. Zero vendor lock-in.

# Too Many Cooks - MANDATORY

REGISTER IMMEDIATELY!!!

COORDINATOR: dictate orders through plans and messages. DELEGATE!!!
OTHERS: do exactly as the coordinator says. CONSTANTLY CHECK MESSAGES AND COMPLY!!!

- Lock files before editing. Don't edit locked files.
- Respond to messages quickly. Others are waiting.

# Documentation Structure

- `docs/INDEX.md` — Full index of all docs
- `docs/specs/` — Specifications (naming: `[COMPONENT]-[FEATURE]-SPEC.md`)
- `docs/plans/` — Implementation plans (naming: `[COMPONENT]-[FEATURE]-PLAN.md`)

`docs/specs/LSP-ARCHITECTURE-SPEC.md` is the **single source of truth** for all shared LSP/DAP/config/commands. Editor-specific specs point back to it.

# Critical Docs

- [LSP Specification 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- [DAP Specification](https://microsoft.github.io/debug-adapter-protocol/specification)
- [Roslyn API Docs](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis)
- [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/)
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/)
- [salsa (incremental computation)](https://salsa-rs.github.io/salsa/)

# Architecture

Three-tier architecture:

- **Tier 1 — Rust LSP Host**: LSP connection (JSON-RPC over stdio), VFS, tree-sitter incremental parsing (C# + F#), salsa cache, request routing, sidecar lifecycle
- **Tier 2 — C# Sidecar (Roslyn)**: Long-running .NET process, MSBuildWorkspace, full Roslyn API (completions, diagnostics, refactorings, formatting)
- **Tier 3 — F# Sidecar (FCS)**: Long-running .NET process, FSharpChecker, Ionide.ProjInfo, Fantomas, FSharpLint

IPC: MessagePack over named pipes (Windows) / Unix domain sockets (Linux, macOS). 4-byte LE length prefix framing. Target <500us round-trip overhead.

C# and F# are equal first-class citizens. F# is NOT a second-class bolt-on.

See `forge-spec.docx` for the full technical specification.

# Rules

- `allow(clippy::` = ILLEGAL. If you must, add a damn good reason. **Aggressively remove** existing allows.
- Zero duplication. DRY AF!!! Check for existing code before writing new code
- All code files < 500 LOC
- Functions < 20 LOC
- Aggressively move shared code to shared crates/modules
- Keep dependencies and versions in sync across: `.github/workflows/ci.yml`, `.devcontainer/Dockerfile`
- Do not use Git unless asked
- There is NO SUCH THING AS LEGACY CODE. Legacy = DELETED
- Keep files under 500 LOC. Break up larger files
- Copying files is illegal. MOVE them instead
- Never copy from C# Dev Kit, Rider, or Visual Studio proprietary code. Reimplement from public APIs and protocols only

## Testing

Testing is absolutely critical. We aim for 100% test coverage and a high mutation score at all times. Focus on assertions; not just coverage.

- NEVER DELETE FAILING TESTS
- NEVER REMOVE ASSERTIONS THAT CAUSE TEST FAILURES
- ADD more failing tests for broken/missing functionality — NEVER remove them
- REDUCING TEST ASSERTIVENESS = DATA CENTER DISMANTLED
- Ignoring tests = ILLEGAL

## Core Principles

- Logging is critical. Can't see what's happening? Add more logging immediately (use `tracing` crate)
- 100% test coverage is only the start
- No unit tests. Only COARSE e2e tests
- Test against real .sln/.csproj/.fsproj files, not mocks

## Typescript Quality Standards

- Lints up to error on every rule
- Any function that may throw must be wrapped in try/catch and return Result<T,E>
- Regaularly run the linters and check for errors

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
