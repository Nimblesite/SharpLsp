# [PKG-MAINTENANCE] Package Maintenance Specification

The Rust host and sidecars implement two NuGet-maintenance operations exposed through Solution Explorer; the VS Code extension is a thin client.

Both operations MUST reuse [the Rust NuGet modules](../../src/sharplsp/src/nuget/): `edit` delegates formatting-preserving `PackageReference`/`PackageVersion` mutations to the C# sidecar's `Microsoft.Build.Construction.ProjectRootElement`, `parse` reads package items, `targets` enumerates workspaces and detects CPM, and `cli` runs `dotnet list`/`restore`. They MUST NOT introduce another XML editor or restore pipeline.

Unused-package detection MUST support Roslyn `.csproj` and FSharp.Compiler.Service `.fsproj` projects.

Primary entry points: [unused.rs](../../src/sharplsp/src/nuget/unused.rs), [consolidate.rs](../../src/sharplsp/src/nuget/consolidate.rs), [WorkspaceManager.Packages.cs](../../src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/WorkspaceManager.Packages.cs), and [package-maintenance.ts](../../src/editors/vscode/src/package-maintenance.ts).

## [PKG-UNUSED] Remove Unused Packages

Remove direct `<PackageReference>` entries whose assemblies are not referenced by project code. The action is available on project nodes and on the solution node, where it runs across every project.

### [PKG-UNUSED-DETECT-CS] C# detection (Roslyn)

For a `.csproj`, the C# sidecar resolves the project in its loaded `MSBuildWorkspace`, builds the `Compilation`, and calls `Compilation.GetUsedAssemblyReferences()`. Every `PortableExecutableReference` is classified as used or unused, and assembly paths are mapped to packages through [PKG-UNUSED-MAP]. A package is unused iff it contributes at least one compile-time assembly and none of those assemblies is in the used set.

### [PKG-UNUSED-DETECT-FS] F# detection (FCS)

For an `.fsproj`, the F# sidecar resolves package compile assemblies from `obj/project.assets.json`, builds isolated `FSharpProjectOptions` containing those `-r:` references without modifying persistent workspace options, runs `ParseAndCheckProject` with `keepAssemblyContents = true`, and walks typed assembly contents to collect assemblies whose entities are referenced. Classification and package mapping then follow the C# path.

### [PKG-ASSETS-FS] Restored-package reference resolution

`FSharpAssets` is the single source of truth for turning `obj/project.assets.json` into FCS `-r:` arguments. Persistent workspace options and unused-package analysis MUST use it so diagnostics, hover, and usage share one reference set.

Rules:

- **Fail-safe**: a missing or malformed assets file yields no references; the caller falls back to framework-only options.
- **Existence-gated**: compile paths that do not exist on disk are dropped because a missing-assembly reference would produce a false diagnostic.
- **SDK cache precedence**: resolve each compile assembly against every declared `packageFolders` root in order, selecting the first physical file. A missing primary-cache assembly MUST NOT hide a valid fallback-cache assembly or its compiler diagnostics. Preserve the primary root as metadata; re-evaluate physical precedence when a cache changes without requiring another restore (GitHub #481).
- **Placeholders are never references**: NuGet emits path-qualified `_._` compile placeholders (for example `lib/netstandard1.0/_._`) that can exist physically. The filter MUST compare the filename component, not the whole compile key; passing `_._` to FCS attaches FS0229/FS3160 startup errors to every checked file (GitHub #160).

### [PKG-UNUSED-MAP] Assembly → package mapping

NuGet restores package assemblies as `<root>/<package-id-lowercased>/<version>/lib/<tfm>/<assembly>.dll`; the package ID is the segment immediately below the global packages root. Assemblies outside a package, including framework and project references, are ignored and never reported as unused packages.

A package is reported unused only when it has a resolvable compile assembly that is provably unused. Packages with no compile-time assembly, including analyzers, build/tooling, MSBuild-only packages, and runtime metapackages, are never flagged.

### [PKG-UNUSED-REQUEST] Request flow

`sharplsp/nuget/unused` accepts `{ projectPath }` for one `.csproj` or `.fsproj`. The host selects the sidecar by file extension, forwards `project/unusedPackages`, intersects returned candidate IDs with direct `<PackageReference>` IDs so transitive dependencies are never removed, and returns `{ projectPath, unused: [{ id, version }] }`. Solution-node analysis enumerates descendant projects in the editor and sends one request per project.

Removal MUST reuse `sharplsp/nuget/uninstall` per package ID, including trivia-preserving XML removal and a background restore.

### [PKG-UNUSED-UI] UX

- Command `sharplsp.removeUnusedPackages`, shown on `viewItem == project` and `viewItem == solution` in `sharplsp.solutionExplorer`.
- Detect first; if none are unused, inform and stop. Otherwise show a modal listing the packages to remove and require explicit confirmation.
- On the solution node, detection and confirmation aggregate across all projects; the confirmation names each project and its unused packages.
- After removal the Solution Explorer refreshes reactively.

## [PKG-CONSOLIDATE] Consolidate Shared Packages to Directory.Build.props

Hoist NuGet packages referenced by two or more projects into a solution-root `Directory.Build.props`, declare each once, and remove their per-project `<PackageReference>` entries. The action is available on the solution node.

### [PKG-CONSOLIDATE-SCAN] Scan

Enumerate every project under the solution directory through `targets` and parse direct `<PackageReference>` IDs and versions. A package is shared when it appears in at least two projects. When versions differ, select the highest by semantic ordering with lexical fallback and report the divergence.

### [PKG-CONSOLIDATE-APPLY] Apply

1. Ensure a `Directory.Build.props` exists at the solution root; create a minimal `<Project></Project>` if absent.
2. For each shared package, use the C# sidecar's MSBuild DOM edit requests to add it to `Directory.Build.props` and remove it from every declaring project.
3. With Central Package Management (`Directory.Packages.props` and `ManagePackageVersionsCentrally=true`), write a versionless `Directory.Build.props` entry; the existing central `<PackageVersion>` remains authoritative.
4. Fire a single background restore for the modified files.

Because hoisted packages apply solution-wide, the result MUST name each moved package, selected version, and edited project.

### [PKG-CONSOLIDATE-REQUEST] Request flow

`sharplsp/nuget/consolidate` accepts `{ solutionPath, dryRun }`. With `dryRun: true`, it returns the preview without modifying files. Apply mode uses the C# sidecar for MSBuild DOM edits and returns `{ message, moved: [{ id, version, fromProjects: [...] }], propsFile: string | null, modifiedFiles }`; a non-empty edit set triggers one background restore.

### [PKG-CONSOLIDATE-UI] UX

- Command `sharplsp.consolidatePackages`, shown on `viewItem == solution`.
- Scan first; if nothing is shared, inform and stop. Otherwise show a modal summarising what will move, then apply on confirmation and refresh.

## [PKG-VULN] Vulnerable Package Diagnostics And Fixes

Plan: [PACKAGE-VULNERABILITY-PLAN](../plans/PACKAGE-VULNERABILITY-PLAN.md). Bug: GitHub #578.

Today a vulnerable package only surfaces through the build task's `$msCompile` problem matcher. NuGet reports
every advisory level as a **warning** (`NU1901` low, `NU1902` moderate, `NU1903` high, `NU1904` critical), so a
high or critical advisory is shown in yellow, pinned to line 1 of the project file, and no fix is offered.

### [PKG-VULN-DIAG] SharpLsp-owned diagnostics

- The host publishes its own diagnostic for each vulnerable package on the `<PackageReference>` /
  `<PackageVersion>` element that declares it, including in `Directory.Packages.props` and shared props (the
  version-owning file per [NUGET-REQUESTS-UPDATE-CONFIRM]). Never on line 1.
- F# `.fsproj` first, then C# `.csproj`; both through the same Rust module.
- Code is NuGet's own (`NU1901`–`NU1904`), `source = "sharplsp-nuget"`, message names the package, resolved
  version, advisory severity and GHSA id, `codeDescription.href` = the advisory URL.
- Transitive advisories (`NuGetAuditMode = all`) are reported on the direct reference that brings the package in,
  naming the path (`A → B → MessagePack 3.1.7`).
- Data comes from the existing [cli.rs](../../src/sharplsp/src/nuget/cli.rs) path
  (`dotnet list package --vulnerable --include-transitive --format json`) plus NuGet's public
  `VulnerabilityInfo` service resource for affected ranges; no second HTTP/CLI path. The project's own
  `NuGetAudit`, `NuGetAuditLevel` and `NuGetAuditSuppress` are honoured: a suppressed advisory is not reported.
- Refreshed after restore, after any package edit, and when the advisory feed's cache expires; a feed failure is
  logged and leaves the last known diagnostics marked stale, never cleared silently.

### [PKG-VULN-SEVERITY] Severity mapping (configurable)

Advisory severity maps to LSP severity through `sharplsp.toml` ([CONFIG-RESOLUTION]). Defaults — high and
critical are **red**:

```toml
[nuget.vulnerabilities]
critical = "error"        # NU1904
high = "error"            # NU1903
moderate = "warning"      # NU1902
low = "information"       # NU1901
# Values: "error" | "warning" | "information" | "hint" | "none"
enforce_in_build = false  # true => error-mapped codes also fail `dotnet build`
```

- Unknown keys or values are config errors; live-reloaded under `[CONFIG-RESOLUTION-LIVE]` with a diagnostic
  refresh.
- `enforce_in_build = true` writes the error-mapped codes into `WarningsAsErrors` in the solution's
  `Directory.Build.props` (XML DOM, list merge), so the build task's problem matcher is red too. This is the
  associated rule of the update fix ([FIXALL-RULES-TABLE]).
- The VS Code `$msCompile` diagnostic for the same code and project is superseded: the build task's matcher
  output stays in the Problems panel only for codes SharpLsp does not own, so one advisory never shows twice.

### [PKG-VULN-FIX] "Update to known-good version" quick fix

- On a vulnerable-package diagnostic, `textDocument/codeAction` offers
  `Update <Package> to <version> (fixes <GHSA>)`.
- **Known-good version**: the lowest published, listed, non-deprecated stable version greater than the resolved
  one that is outside **every** advisory range for the package (not just the reported one), compared with NuGet
  version semantics.
- Within the [NUGET-REQUESTS-UPDATE-BOUNDS] line it is a normal `quickfix`; when the only good version crosses a
  major (or `0.x` minor) boundary, the title says so (`… — major update 3 → 4`) and resolving it requires the
  explicit confirmation of [NUGET-REQUESTS-UPDATE-CONFIRM]. No known-good version → no fix, and the diagnostic
  says "no patched version published".
- Transitive: the fix pins the package with a direct `PackageReference` (or a `PackageVersion` when CPM has
  `CentralPackageTransitivePinningEnabled`) at the known-good version, or updates the direct parent when a parent
  version that pulls the fixed one exists — the lower-impact choice is offered first.
- Applied via `sharplsp/nuget/install` with an exact version and [NUGET-XML-DOM], then restore; a failed restore is
  reported as failure with the attempted version ([REFACTOR-NEVER-SILENT]).
- **Fix all** ([FIXALL-SCOPES]): `Update all vulnerable packages` at project and solution scope, plus
  *Fix all and enforce* (writes `enforce_in_build`).

### [PKG-VULN-TESTS] Tests

Real F# and C# fixture projects referencing a controlled vulnerable version on a local feed with a local
advisory resource: assert range on the element, severity per mapping (all four levels, and every remapped
value), transitive path message, suppression honoured, known-good selection skips a later still-vulnerable
version, major-boundary confirmation, transitive pin under CPM, restore failure reporting, and that the build
fails after *fix and enforce* when a vulnerable version is reintroduced.

## [PKG-NONGOALS] Non-Goals

- Transitive / framework / analyzer package pruning (cannot be proven unused).
- Rewriting version ranges, floating versions, or condition-bearing references.
- Per-`<PackageReference>` metadata (`PrivateAssets`, `IncludeAssets`) merging beyond a straight hoist; references carrying item metadata or conditions are skipped rather than flattened.
