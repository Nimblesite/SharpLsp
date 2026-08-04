# Static Analyzer Specification `[ANALYZERS-STATIC]`

SharpLsp-owned analyzers run through the diagnostics pipeline. Repository-aware analyzers MUST use the loaded solution graph, never present open-file analysis as complete.

## [ANALYZERS-GOAL] Goal

The analyzers detect unused public C# and F# elements at the configured solution boundary. In monorepo mode, public symbols with no references in the loaded graph can be reported because the repository is the declared API boundary.

Standard repositories MUST NOT receive unused-public diagnostics because unloaded external consumers may exist.

## [ANALYZERS-MONOREPO-GATE] Monorepo Gate

SharpLsp classifies the workspace from explicit configuration, never from directory shape, project count, Git remotes, naming conventions, or solution size.

```toml
[workspace]
# Values: "standard", "monorepo"
repository_kind = "monorepo"

[diagnostics]
analyzers_enabled = true
solution_wide_analysis = true

[diagnostics.static_analyzers]
enabled = true
unused_public_symbols = true
```

The unused-public-code analyzers run only when all of these are true:

- `workspace.repository_kind == "monorepo"`
- `diagnostics.analyzers_enabled == true`
- `diagnostics.solution_wide_analysis == true`
- `diagnostics.static_analyzers.enabled == true`
- `diagnostics.static_analyzers.unused_public_symbols == true`

`repository_kind` defaults to `"standard"`, so unused-public analysis is off while ordinary compiler and package analyzers remain enabled.

Changing the monorepo gate or static analyzer settings via `workspace/didChangeConfiguration` bumps `global_state_version` and triggers `workspace/diagnostic/refresh`.

### [ANALYZERS-CONFIG-IMPL] Implemented Configuration (F#)

The F# sidecar gate is live. The Rust host reads an `[analyzers]` table from `sharplsp.toml` and pushes the flags to each sidecar via the `analyzers/configure` request immediately after `workspace/open` (see [config.rs](../../src/sharplsp/src/config.rs) `AnalyzersConfig` and [main.rs](../../src/sharplsp/src/main.rs) `configure_analyzers`):

```toml
[analyzers]
# Whether the dead-code analyzer runs at all (default true).
dead_code = true
# Whether the workspace is the entire world. true => unused PUBLIC symbols are
# dead-code ERRORS; false => only private/internal dead code is reported, as a
# warning (default false).
monorepo = false
```

`analyzers/configure` carries a positional MessagePack payload (`AnalyzerConfigRequest`: `[Key(0)] DeadCode`, `[Key(1)] Monorepo`). A sidecar keeps the flags as mutable state across re-opens. This `[analyzers]` table is the shipping schema; the richer `[workspace] repository_kind` / `[diagnostics.static_analyzers]` form above is the forward-compatible target the loader will also accept.

## [ANALYZERS-SOLUTION-SCOPE] Solution-Wide Scope

Static analyzer diagnostics are IDE-level workspace diagnostics. They are computed from the complete loaded solution graph and surfaced through `workspace/diagnostic` partial results.

`textDocument/diagnostic` may include salsa-memoized static analyzer diagnostics for the requested file after a solution-wide snapshot has been computed. It must not start a local-only unused-public-code analysis, because that would create false positives for symbols referenced outside the open document.

The analysis scope is every loaded C# and F# project in the configured `.sln` or `.slnx`.

## [ANALYZERS-UNUSED-PUBLIC] Unused Public Code Elements

A public code element is unused when it has a declaration in the loaded solution graph and no non-declaration semantic references anywhere in that same graph.

Declaration candidates are collected from compiler symbol APIs, not string matching:

| Language | Candidate symbols |
|---|---|
| C# | Public named types, delegates, enums, records, interfaces, constructors, methods, properties, indexers, events, fields, operators, conversion operators, and extension methods |
| F# | Public modules, types, union cases, record fields, values/functions, members, active patterns, delegates, interfaces, and members exposed through `.fsi` signature files |

For C#, "public" means symbols whose Roslyn accessibility makes them callable from another assembly, including public members and protected/protected-internal members on externally visible inheritable types.

For F#, implicit public accessibility counts as public unless the declaration is hidden by `private`, `internal`, a signature file, or compiler visibility rules. When a `.fsi` signature file exists, the signature file defines the public surface and diagnostics are reported at the signature declaration when possible.

When an enclosing public type/module is already reported unused, nested public members are suppressed in that diagnostic batch to avoid noisy cascades.

The Rust tree-sitter indexes may prefilter declaration ranges and file scopes for speed, but Roslyn/FCS symbol identity is the source of truth for every reported diagnostic.

## [ANALYZERS-REFERENCE-MODEL] Reference Model

References must be semantic references:

- C# uses Roslyn symbols and `SymbolFinder.FindReferencesAsync`.
- F# uses FSharp.Compiler.Service parse/check results and symbol-use APIs.
- Cross-language references through project references are counted by metadata identity where Roslyn and FCS expose a stable assembly/type/member identity.
- Generated code, `obj/`, `bin/`, package cache files, and metadata-only assemblies are not diagnostic targets.

The following count as uses:

- Construction, invocation, member access, field/property/event access, and delegate conversion.
- Inheritance, interface implementation, override binding, and attribute application.
- Pattern matching, union-case construction, record construction/update, and active-pattern use in F#.
- References from test projects in the loaded solution.

Declaration syntax, XML documentation text, comments, and unbound identifier text do not count as uses.

## [ANALYZERS-SUPPRESSION] Suppression And Known Entry Points

The analyzer must support normal IDE suppression mechanisms:

- `.editorconfig` severity for the SharpLsp diagnostic code.
- C# `#pragma warning disable` and `SuppressMessageAttribute`.
- F# `#nowarn` for the SharpLsp diagnostic code where supported by the F# sidecar mapping.
- SharpLsp config entries for project/path exclusions.

The analyzer must also avoid known entry points and convention-bound public surface:

- Program entry points, top-level program artifacts, source-generated entry points, and test framework entry points.
- Overrides and interface implementations when the base/interface contract is outside the loaded repo graph.
- Symbols annotated with recognized framework/reflection preservation attributes such as `DynamicallyAccessedMembers`, `DynamicDependency`, `JsonConstructor`, dependency injection attributes, routing attributes, serializer attributes, or JetBrains `PublicAPI`/`UsedImplicitly`.

The attribute list is configurable so teams can add framework-specific public entry points without changing SharpLsp.

## [ANALYZERS-DIAGNOSTICS] Diagnostic Shape

Unused-public-code diagnostics use the normal LSP `Diagnostic` shape:

| Language | Code | Source | Default severity | Tags |
|---|---|---|---|---|
| C# | `SLSPC0101` | `sharplsp-static-csharp` | Information | `Unnecessary` |
| F# | `SLSPF0101` | `sharplsp-static-fsharp` | Information | `Unnecessary` |

Message format:

```text
Public {kind} '{symbol}' has no references in the configured monorepo.
```

### [ANALYZERS-DEADCODE-SEVERITY] Severity (implemented, F#)

By project decision the F# dead-code analyzer (`SLSPF0101`) escalates severity in monorepo mode — an unreferenced symbol in a declared monorepo is a hard error, not a hint, because nothing outside the repo can be the missing consumer:

| Mode | Private/internal dead code | Public dead code |
|---|---|---|
| `monorepo = false` | **Warning** | not reported (assumed external API) |
| `monorepo = true`  | **Error**   | **Error** |

Reporting private/internal dead code (regardless of monorepo mode) extends beyond [ANALYZERS-UNUSED-PUBLIC]: a private/internal symbol can never be reached from outside its assembly, so its deadness is sound without the monorepo gate.

### [ANALYZERS-FSAC-PARITY] File-Local Analyzers (F#, FSAC parity)

The F# sidecar also runs two always-on file-local analyzers via FCS `EditorServices`, surfaced as `Hint` diagnostics so editors grey the range and can offer the matching code fix (parity with FsAutoComplete / Ionide):

#### [ANALYZERS-FSAC-UNUSED-OPEN] Unused open diagnostics

`UnusedOpens.getUnusedOpens` emits `SLSPF0102` with message `Unused 'open' statement; safe to remove.`

#### [ANALYZERS-FSAC-SIMPLIFY-NAME] Simplifiable name diagnostics

`SimplifyNames.getSimplifiableNames` emits `SLSPF0103` with message `Redundant qualifier; '{name}' is sufficient here.`

These are independent of the monorepo gate and the `dead_code` flag.

Diagnostics include stable symbol identity in `Diagnostic.data`.

The raw FCS findings (`open` ranges and `(range, relativeName)` simplifications) are computed once in [FSharpLocalAnalysis.fs](../../src/sidecars/SharpLsp.Sidecar.FSharp/FSharpLocalAnalysis.fs) (`getFileAnalyzerFindings`) and shared by both the hint producer above and the code fixes below, so the greyed range and the offered fix can never disagree.

#### [ANALYZERS-FSAC-CODEFIX-UNUSED-OPEN] "Remove unused open" code fix

The `textDocument/codeAction` handler turns each `SLSPF0102` finding overlapping the request range into a `Remove unused open` quick fix ([FSharpCodeFixes.fs](../../src/sidecars/SharpLsp.Sidecar.FSharp/FSharpCodeFixes.fs) `removeUnusedOpenActions`). Resolving it deletes the whole `open` line — from the start of its first line through the start of the line after its last — matching FsAutoComplete. E2E: the F# sidecar IPC suite (`code action offers remove-unused-open …`) and the VSIX suite (`F# LSP — Code Fixes`).

#### [ANALYZERS-FSAC-CODEFIX-SIMPLIFY-NAME] "Simplify name" code fix

Each `SLSPF0103` finding overlapping the request range becomes a `Simplify name` quick fix (`simplifyNameActions`). FCS reports the simplifiable `Range` as the **redundant qualifier prefix including its trailing dot**, so the fix deletes that span (e.g. `System.DateTime.MinValue` → `DateTime.MinValue` when `System` is open). E2E: the IPC suite (`code action offers simplify-name …`) and the VSIX suite.

#### [ANALYZERS-FSAC-CODEFIX-INTERFACE-STUB] "Implement interface" code fix

A type-informed code action handles missing **interface members**. When the cursor is on an `interface IFoo …` declaration with unimplemented members, FCS `InterfaceStubGenerator` (`TryFindInterfaceDeclaration` → `GetImplementedMemberSignatures` → `FormatInterface`) generates `member _.X … = failwith "…"` stubs for the missing members ([FSharpCodeActions.fs](../../src/sidecars/SharpLsp.Sidecar.FSharp/FSharpCodeActions.fs) `tryGenerateInterfaceStub`, wired into `getCodeActions` Phase 4). E2E: the IPC suite (`code action offers implement-interface stub …`) and the VSIX suite (`F# LSP — Implement Interface`).

## [ANALYZERS-PERFORMANCE] Performance And Salsa Queries

Static analyzers are lower priority than compiler diagnostics. A `workspace/diagnostic` request must stream compiler/analyzer diagnostics first and static analyzer diagnostics as later partial results.

Static-analysis memoization belongs exclusively to the Rust host's salsa database. Sidecars compute requested language results and MUST NOT retain a second result cache. Salsa query inputs are:

- Solution snapshot identity.
- Project version.
- Document version.
- `global_state_version`.
- Static analyzer config hash.

Workspace changes invalidate only affected project indexes when possible. A full invalidation is required when project references, analyzer config, signature files, or workspace kind changes.

Targets:

| Metric | Target |
|---|---|
| First static analyzer partial result | <2s after workspace initialization for a 50-project solution |
| Full unused-public-code pass | <15s for a 50-project solution |
| Salsa-memoized repeat workspace pull | <50ms before partial-result streaming completes |
| Additional memory | <250MB for a 50-project solution |

## [ANALYZERS-TRUTH] Truth Guarantees

The analyzer must prefer silence over false positives:

- If the workspace is not explicitly configured as a monorepo, return no unused-public-code diagnostics.
- If a project is unloaded or failed to load, return no unused-public-code diagnostics for symbols that could be referenced by that project.
- If cross-language identity cannot be proven for a symbol, do not report it as unused.
- If the analyzer cannot distinguish a framework entry point from ordinary public API, suppress the diagnostic and emit structured trace logging for future rule tuning.
