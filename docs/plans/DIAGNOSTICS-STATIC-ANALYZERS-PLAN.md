# DIAGNOSTICS-STATIC-ANALYZERS-PLAN

Implementation plan for
[DIAGNOSTICS-STATIC-ANALYZERS-SPEC](../specs/DIAGNOSTICS-STATIC-ANALYZERS-SPEC.md).

This plan adds SharpLsp-owned static analyzers to the existing pull diagnostics
pipeline. The first rules report unused public C# and F# code elements, but only
when the workspace is explicitly configured as a monorepo.

## Phase 1: Config Gate And Wiring (P0)

Implements [ANALYZERS-MONOREPO-GATE] and [ANALYZERS-SOLUTION-SCOPE].

- [ ] Add `WorkspaceConfig` to `SharpLspConfig` with
      `repository_kind: "standard" | "monorepo"` and default `"standard"`.
- [ ] Add `StaticAnalyzersConfig` under diagnostics with `enabled`,
      `unused_public_symbols`, path/project exclusions, and configurable
      implicit-use attribute names.
- [ ] Reject unknown workspace/static-analyzer config fields with the existing
      TOML strictness.
- [ ] Update `sharplsp.example.toml` through a TOML parser/serializer, not line
      splicing.
- [ ] Hot-reload workspace/static-analyzer config through
      `workspace/didChangeConfiguration`.
- [ ] Bump `global_state_version` and send `workspace/diagnostic/refresh` when
      monorepo/static-analyzer settings change.
- [ ] Full-stack test: default config produces no unused-public-code
      diagnostics.
- [ ] Full-stack test: `repository_kind = "standard"` suppresses the analyzer
      even when `unused_public_symbols = true`.
- [ ] Full-stack test: `repository_kind = "monorepo"` enables the analyzer only
      when `solution_wide_analysis` and `analyzers_enabled` are also true.

## Phase 2: Static Analyzer Diagnostics Pipeline (P0)

Implements [ANALYZERS-DIAGNOSTICS], [ANALYZERS-PERFORMANCE], and
[ANALYZERS-TRUTH].

- [ ] Define sidecar DTOs for static analyzer diagnostics, including stable
      symbol identity and config hash.
- [ ] Use Rust tree-sitter indexes as an optional declaration/range prefilter;
      keep Roslyn/FCS symbol identity as the reporting authority.
- [ ] Merge static analyzer diagnostics into `workspace/diagnostic` partial
      results after compiler/analyzer diagnostics.
- [ ] Allow `textDocument/diagnostic` to return cached static analyzer
      diagnostics for the requested file after a workspace pass exists.
- [ ] Prevent `textDocument/diagnostic` from starting local-only static analysis.
- [ ] Extend `resultId` construction to include static analyzer config/index
      identity when static diagnostics are present.
- [ ] Add cache invalidation for project reload, document change, signature file
      change, project-reference change, and config change.
- [ ] Emit structured trace events when the analyzer is gated off, skipped due to
      incomplete workspace state, or suppresses a likely framework entry point.
- [ ] Full-stack test: workspace diagnostics in unopened files include static
      analyzer diagnostics.
- [ ] Full-stack test: repeated workspace pull returns unchanged/static-cache
      results without recomputing the pass.
- [ ] Full-stack test: unloaded or failed projects suppress unused-public-code
      diagnostics instead of reporting false positives.

## Phase 3: C# Unused Public Symbols (P0)

Implements [ANALYZERS-UNUSED-PUBLIC], [ANALYZERS-REFERENCE-MODEL], and
[ANALYZERS-SUPPRESSION] for C#.

- [ ] Build a Roslyn candidate collector from `ISymbol` data for public API
      surface.
- [ ] Use `SymbolFinder.FindReferencesAsync` to count non-declaration references
      across the loaded solution graph.
- [ ] Count inheritance, interface implementation, overrides, attributes,
      construction, invocation, and member access as uses.
- [ ] Suppress nested-member cascades when the containing public type is already
      reported unused.
- [ ] Exclude generated files, `obj/`, `bin/`, metadata-only symbols, and package
      cache files.
- [ ] Honor `.editorconfig`, `#pragma warning disable`, and
      `SuppressMessageAttribute`.
- [ ] Recognize configured implicit-use attributes plus the built-in framework
      list from the spec.
- [ ] Emit `SLSPC0101` diagnostics with source `sharplsp-static-csharp`,
      severity Information, and tag `Unnecessary`.
- [ ] Full-stack test: unused public C# type in a monorepo solution is reported.
- [ ] Full-stack test: public C# type referenced by another project is not
      reported.
- [ ] Full-stack test: public C# member used by reflection/framework attribute is
      suppressed.
- [ ] Full-stack test: non-monorepo config reports no C# unused-public-code
      diagnostics.

## Phase 4: F# Unused Public Symbols (P0)

Implements [ANALYZERS-UNUSED-PUBLIC], [ANALYZERS-REFERENCE-MODEL], and
[ANALYZERS-SUPPRESSION] for F#.

- [ ] Build an FCS candidate collector for public modules, types, values,
      functions, members, union cases, record fields, active patterns, delegates,
      and interfaces.
- [ ] Treat `.fsi` signature files as the public-surface authority when present.
- [ ] Use FCS symbol-use APIs to count non-declaration references across all F#
      projects in the loaded solution graph.
- [ ] Count pattern matching, union-case construction, record construction/update,
      active-pattern use, member access, and interface/override binding as uses.
- [ ] Suppress nested-member cascades when the containing public module/type is
      already reported unused.
- [ ] Exclude generated files, `obj/`, `bin/`, metadata-only symbols, and package
      cache files.
- [ ] Honor `.editorconfig`, mapped `#nowarn` support, and configured
      implicit-use attributes.
- [ ] Emit `SLSPF0101` diagnostics with source `sharplsp-static-fsharp`,
      severity Information, and tag `Unnecessary`.
- [ ] Full-stack test: unused public F# function in a monorepo solution is
      reported.
- [ ] Full-stack test: public F# value referenced by another project is not
      reported.
- [ ] Full-stack test: `.fsi` public-surface declarations receive diagnostics at
      the signature declaration where possible.
- [ ] Full-stack test: non-monorepo config reports no F# unused-public-code
      diagnostics.

## Phase 5: Cross-Language References (P1)

Implements the cross-language part of [ANALYZERS-REFERENCE-MODEL].

- [ ] Define a shared metadata identity DTO for C# and F# public symbols.
- [ ] Count C# references to F# public symbols through project-reference metadata.
- [ ] Count F# references to C# public symbols through project-reference metadata.
- [ ] Suppress diagnostics when cross-language identity is ambiguous.
- [ ] Full-stack test: C# calls public F# function, F# symbol is not reported.
- [ ] Full-stack test: F# calls public C# method, C# symbol is not reported.
- [ ] Full-stack test: ambiguous metadata identity suppresses instead of reporting
      a false positive.

## Phase 6: Editor Experience And Follow-Up Actions (P1)

- [ ] VS Code e2e test: monorepo static diagnostics appear in Problems for
      unopened files after `workspace/diagnostic`.
- [ ] VS Code e2e test: changing `repository_kind` triggers
      `workspace/diagnostic/refresh` and removes/adds diagnostics.
- [ ] Add code descriptions for `SLSPC0101` and `SLSPF0101` that link to the
      static analyzer docs.
- [ ] Add future code action stubs using `Diagnostic.data`: suppress diagnostic,
      reduce visibility, and safe delete.
- [ ] Add performance regression fixture for a mixed 50-project solution.

---

## TODO

### Config

- [ ] Add `WorkspaceConfig.repository_kind` defaulting to `"standard"`.
- [ ] Add `DiagnosticsConfig.static_analyzers`.
- [ ] Hot-reload monorepo/static-analyzer settings.
- [ ] Update example config through a TOML parser/serializer.

### Pipeline

- [ ] Stream static analyzer diagnostics through `workspace/diagnostic` partial
      results.
- [ ] Cache static analyzer indexes by solution/project/document/config identity.
- [ ] Prevent open-file-only static analysis.
- [ ] Include static analyzer identity in `resultId` when needed.

### C#

- [ ] Collect public C# symbols via Roslyn.
- [ ] Count solution-wide Roslyn semantic references.
- [ ] Emit `SLSPC0101`.
- [ ] Add C# monorepo/non-monorepo full-stack tests.

### F#

- [ ] Collect public F# symbols via FCS and `.fsi` public surface.
- [ ] Count solution-wide FCS semantic references.
- [ ] Emit `SLSPF0101`.
- [ ] Add F# monorepo/non-monorepo full-stack tests.

### Cross-Language

- [ ] Share metadata identity between C# and F# indexes.
- [ ] Count C# to F# and F# to C# references.
- [ ] Suppress ambiguous cross-language cases.
