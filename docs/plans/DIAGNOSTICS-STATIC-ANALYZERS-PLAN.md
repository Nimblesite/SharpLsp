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
- [ ] Update `src/examples/config/sharplsp.example.toml` through a TOML parser/serializer, not line
      splicing.
- [x] Hot-reload workspace/static-analyzer config through
      `workspace/didChangeConfiguration` (shipped as `[analyzers] dead_code`/`monorepo`) — `configuration_live.rs` `reconfigure`;
      e2e `analyzer_settings_from_the_editor_or_the_file_apply_to_the_next_pull` (editor and on-disk edits).
- [x] Bump `global_state_version` and send `workspace/diagnostic/refresh` when
      monorepo/static-analyzer settings change — `configuration_live.rs` `reconfigure` →
      `pull_diagnostics::state::configure` invalidates the store (its revision) and schedules the
      refresh; `csharp_unused_public_types_are_dead_only_in_a_monorepo` waits for it after each switch.
- [x] Full-stack test: default config produces no unused-public-code
      diagnostics — same test, step 1: no `sharplsp.toml`, only the internal type is reported.
- [x] Full-stack test: `repository_kind = "standard"` suppresses the analyzer
      even when `unused_public_symbols = true` (shipped as `[analyzers] dead_code`/`monorepo`) — same e2e, step 2: `dead_code` on,
      no monorepo, the public F# function is not reported.
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

- [x] Build a Roslyn candidate collector from `ISymbol` data for public API
      surface — `DeadCodeAnalyzer.cs` `IsCandidate`/`Visibility`; `DeadCodeAnalyzerTests`
      `Monorepo_reports_unused_public_symbols_as_errors`.
- [x] Use `SymbolFinder.FindReferencesAsync` to count non-declaration references
      across the loaded solution graph — `SearchScope.cs`; `DeadCodeAnalyzerTests`
      `Types_referenced_only_through_members_are_not_flagged`.
- [ ] Count inheritance, interface implementation, overrides, attributes,
      construction, invocation, and member access as uses.
- [x] Roll member uses from outside a type up to the type (extension calls, static
      access, generated partials); members using each other keep nothing alive (#580).
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
- [x] Full-stack test: unused public C# type in a monorepo solution is reported —
      `configuration_live.rs` `csharp_unused_public_types_are_dead_only_in_a_monorepo`, step 2.
- [x] Full-stack test: public C# type referenced by another project is not
      reported — `configuration_live.rs` `a_public_csharp_type_another_project_uses_is_not_dead_in_a_monorepo`
      (a two-project `.slnx`: only the unused `Orphan` is reported).
- [ ] Full-stack test: public C# member used by reflection/framework attribute is
      suppressed.
- [x] Full-stack test: non-monorepo config reports no C# unused-public-code
      diagnostics — same test, steps 1 and 3: only the internal type is reported.

## Phase 4: F# Unused Public Symbols (P0)

Implements [ANALYZERS-UNUSED-PUBLIC], [ANALYZERS-REFERENCE-MODEL], and
[ANALYZERS-SUPPRESSION] for F#.

- [ ] Build an FCS candidate collector for public modules, types, values,
      functions, members, union cases, record fields, active patterns, delegates,
      and interfaces.
- [ ] Treat `.fsi` signature files as the public-surface authority when present.
- [x] Use FCS symbol-use APIs to count non-declaration references across all F#
      projects in the loaded solution graph — `FSharpAnalyzers.fs` `deadCodeDiagnostics`;
      `SidecarEndToEndTests.fs` (referenced bindings never flagged).
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
- [x] Full-stack test: unused public F# function in a monorepo solution is
      reported — `configuration_live.rs` step 3: `unusedPublic` reported as an error.
- [ ] Full-stack test: public F# value referenced by another project is not
      reported.
- [ ] Full-stack test: `.fsi` public-surface declarations receive diagnostics at
      the signature declaration where possible.
- [x] Full-stack test: non-monorepo config reports no F# unused-public-code
      diagnostics — `configuration_live.rs` step 2: only the private helper is reported.

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
- [x] Add code descriptions for `SLSPC0101` and `SLSPF0101` that link to the
      static analyzer docs — `RuleDocumentation.cs` (Common) points both at the website's
      Diagnostics › Dead code section; `DeadCodeAnalyzerTests` and `FSharpAnalyzersTests`
      assert the link, and that `SLSPF0102` carries none.
- [ ] Add future code action stubs using `Diagnostic.data`: suppress diagnostic,
      reduce visibility, and safe delete.
- [ ] Add performance regression fixture for a mixed 50-project solution.

---

## TODO

### Config

- [ ] Add `WorkspaceConfig.repository_kind` defaulting to `"standard"`.
- [ ] Add `DiagnosticsConfig.static_analyzers`.
- [x] Hot-reload monorepo/static-analyzer settings. (see the matching phase row)
- [ ] Update example config through a TOML parser/serializer.

### Pipeline

- [ ] Stream static analyzer diagnostics through `workspace/diagnostic` partial
      results.
- [ ] Cache static analyzer indexes by solution/project/document/config identity.
- [ ] Prevent open-file-only static analysis.
- [ ] Include static analyzer identity in `resultId` when needed.

### C#

- [x] Collect public C# symbols via Roslyn. (see the matching phase row)
- [x] Count solution-wide Roslyn semantic references. (see the matching phase row)
- [ ] Emit `SLSPC0101`.
- [x] Add C# monorepo/non-monorepo full-stack tests. (see the matching phase row)

### F#

- [ ] Collect public F# symbols via FCS and `.fsi` public surface.
- [x] Count solution-wide FCS semantic references. (see the matching phase row)
- [ ] Emit `SLSPF0101`.
- [x] Add F# monorepo/non-monorepo full-stack tests. (see the matching phase row)

### Cross-Language

- [ ] Share metadata identity between C# and F# indexes.
- [ ] Count C# to F# and F# to C# references.
- [ ] Suppress ambiguous cross-language cases.
