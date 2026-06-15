# DIAGNOSTICS-STATIC-ANALYZERS-SPEC

SharpLsp-owned static analyzers fill gaps left by compiler diagnostics, Roslyn
IDE analyzers, FSharpLint, and third-party analyzer packages. They are part of
the diagnostics pipeline, but they are solution-wide by design: an analyzer that
needs repository context must never pretend that an open-file-only answer is
complete.

## [ANALYZERS-GOAL] Goal

The first SharpLsp static analyzers detect unused public code elements in C# and
F# at the configured solution/repository boundary.

These diagnostics exist because public code is normally treated as externally
reachable by compilers and ordinary IDE analyzers. In a monorepo, the repository
can be the real API boundary, so SharpLsp can report public surface area that is
not referenced anywhere in the loaded solution graph.

The feature is opt-in for monorepos only. Standard repositories must not receive
unused-public-code diagnostics, because a public symbol may be consumed by an
unloaded external product, package consumer, plugin, or runtime integration.

## [ANALYZERS-MONOREPO-GATE] Monorepo Gate

SharpLsp classifies the workspace from explicit configuration, never from
directory shape, project count, Git remotes, naming conventions, or solution
size.

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

The default `repository_kind` is `"standard"`. This means the analyzer is off by
default even though `diagnostics.analyzers_enabled` remains on by default for
ordinary compiler and package analyzer diagnostics.

Changing the monorepo gate or static analyzer settings via
`workspace/didChangeConfiguration` bumps `global_state_version` and triggers
`workspace/diagnostic/refresh`.

## [ANALYZERS-SOLUTION-SCOPE] Solution-Wide Scope

Static analyzer diagnostics are IDE-level workspace diagnostics. They are
computed from the complete loaded solution graph and surfaced through
`workspace/diagnostic` partial results.

`textDocument/diagnostic` may include cached static analyzer diagnostics for the
requested file after a solution-wide snapshot has been computed. It must not
start a local-only unused-public-code analysis, because that would create false
positives for symbols referenced outside the open document.

The initial implementation scope is every C# and F# project loaded from the
configured `.sln` or `.slnx`. If SharpLsp later supports multi-solution
workspaces, the analysis universe becomes every loaded project in the configured
workspace solution set.

## [ANALYZERS-UNUSED-PUBLIC] Unused Public Code Elements

A public code element is unused when it has a declaration in the loaded
solution graph and no non-declaration semantic references anywhere in that same
graph.

Declaration candidates are collected from compiler symbol APIs, not string
matching:

| Language | Candidate symbols |
|---|---|
| C# | Public named types, delegates, enums, records, interfaces, constructors, methods, properties, indexers, events, fields, operators, conversion operators, and extension methods |
| F# | Public modules, types, union cases, record fields, values/functions, members, active patterns, delegates, interfaces, and members exposed through `.fsi` signature files |

For C#, "public" means symbols whose Roslyn accessibility makes them callable
from another assembly, including public members and protected/protected-internal
members on externally visible inheritable types.

For F#, implicit public accessibility counts as public unless the declaration is
hidden by `private`, `internal`, a signature file, or compiler visibility rules.
When a `.fsi` signature file exists, the signature file defines the public
surface and diagnostics are reported at the signature declaration when possible.

When an enclosing public type/module is already reported unused, nested public
members are suppressed in that diagnostic batch to avoid noisy cascades.

The Rust tree-sitter indexes may prefilter declaration ranges and file scopes for
speed, but Roslyn/FCS symbol identity is the source of truth for every reported
diagnostic.

## [ANALYZERS-REFERENCE-MODEL] Reference Model

References must be semantic references:

- C# uses Roslyn symbols and `SymbolFinder.FindReferencesAsync`.
- F# uses FSharp.Compiler.Service parse/check results and symbol-use APIs.
- Cross-language references through project references are counted by metadata
  identity where Roslyn and FCS expose a stable assembly/type/member identity.
- Generated code, `obj/`, `bin/`, package cache files, and metadata-only
  assemblies are not diagnostic targets.

The following count as uses:

- Construction, invocation, member access, field/property/event access, and
  delegate conversion.
- Inheritance, interface implementation, override binding, and attribute
  application.
- Pattern matching, union-case construction, record construction/update, and
  active-pattern use in F#.
- References from test projects in the loaded solution.

Declaration syntax, XML documentation text, comments, and unbound identifier text
do not count as uses.

## [ANALYZERS-SUPPRESSION] Suppression And Known Entry Points

The analyzer must support normal IDE suppression mechanisms:

- `.editorconfig` severity for the SharpLsp diagnostic code.
- C# `#pragma warning disable` and `SuppressMessageAttribute`.
- F# `#nowarn` for the SharpLsp diagnostic code where supported by the F# sidecar
  mapping.
- SharpLsp config entries for project/path exclusions.

The analyzer must also avoid known entry points and convention-bound public
surface:

- Program entry points, top-level program artifacts, source-generated entry
  points, and test framework entry points.
- Overrides and interface implementations when the base/interface contract is
  outside the loaded repo graph.
- Symbols annotated with recognized framework/reflection preservation attributes
  such as `DynamicallyAccessedMembers`, `DynamicDependency`, `JsonConstructor`,
  dependency injection attributes, routing attributes, serializer attributes, or
  JetBrains `PublicAPI`/`UsedImplicitly`.

The attribute list is configurable so teams can add framework-specific public
entry points without changing SharpLsp.

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

Diagnostics include a stable symbol identity in `Diagnostic.data` so future code
actions can offer safe-delete, visibility reduction, or suppression insertion.

## [ANALYZERS-PERFORMANCE] Performance And Caching

Static analyzers are lower priority than compiler diagnostics. A
`workspace/diagnostic` request must stream compiler/analyzer diagnostics first
and static analyzer diagnostics as later partial results.

Each sidecar owns a language-specific static analysis index keyed by:

- Solution snapshot identity.
- Project version.
- Document version.
- `global_state_version`.
- Static analyzer config hash.

Workspace changes invalidate only affected project indexes when possible. A
full invalidation is required when project references, analyzer config,
signature files, or workspace kind changes.

Targets:

| Metric | Target |
|---|---|
| First static analyzer partial result | <2s after workspace initialization for a 50-project solution |
| Full unused-public-code pass | <15s for a 50-project solution |
| Cached repeat workspace pull | <50ms before partial-result streaming completes |
| Additional memory | <250MB for a 50-project solution |

## [ANALYZERS-TRUTH] Truth Guarantees

The analyzer must prefer silence over false positives:

- If the workspace is not explicitly configured as a monorepo, return no
  unused-public-code diagnostics.
- If a project is unloaded or failed to load, return no unused-public-code
  diagnostics for symbols that could be referenced by that project.
- If cross-language identity cannot be proven for a symbol, do not report it as
  unused.
- If the analyzer cannot distinguish a framework entry point from ordinary public
  API, suppress the diagnostic and emit structured trace logging for future rule
  tuning.
