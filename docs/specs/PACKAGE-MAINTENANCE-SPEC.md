# Package Maintenance Spec

Solution-Explorer context-menu actions that keep a .NET solution's NuGet
references tidy. Two operations, both editor-agnostic (the logic lives in the
Rust host / sidecars; the VS Code extension is a thin shell).

All NuGet plumbing reuses the existing `src/nuget/` module — `xml_edit`
(trivia-preserving `PackageReference`/`PackageVersion` edits), `targets`
(workspace/solution enumeration + CPM detection), `cli` (`dotnet list` /
`restore`) and the `sharplsp/nuget/*` request family. No new XML editor, no new
restore pipeline.

C# and F# are equal first-class citizens: unused-package detection is wired for
both Roslyn (`.csproj`) and FSharp.Compiler.Service (`.fsproj`).

## [PKG-UNUSED] Remove Unused Packages

Remove direct `<PackageReference>` entries whose assemblies are not referenced
by any code in the project. Available on **project** nodes and on the
**solution** node (where it runs across every project).

### [PKG-UNUSED-DETECT-CS] C# detection (Roslyn)

For a `.csproj`, the C# sidecar resolves the project in its loaded
`MSBuildWorkspace`, builds the `Compilation`, and calls
`Compilation.GetUsedAssemblyReferences()` — Roslyn's canonical "which references
are actually used" API. Every `PortableExecutableReference` is classified as
used / unused; assembly file paths are mapped back to packages
(see [PKG-UNUSED-MAP]). A package is **unused** iff it contributes at least one
compile-time assembly to the compilation and **none** of those assemblies is in
the used set.

### [PKG-UNUSED-DETECT-FS] F# detection (FCS)

For an `.fsproj`, the F# sidecar resolves the package's compile assemblies from
`obj/project.assets.json`, builds an **isolated** `FSharpProjectOptions` that
includes those `-r:` references (the persistent workspace options are left
untouched so other F# features are unaffected), runs `ParseAndCheckProject`
with `keepAssemblyContents = true`, and walks the typed assembly contents to
collect the set of assemblies whose entities are actually referenced. The
used/unused classification and package mapping are identical to the C# path.

### [PKG-ASSETS-FS] Restored-package reference resolution

`FSharpAssets` is the single source of truth for turning `obj/project.assets.json`
into FCS `-r:` reference arguments, shared by the persistent workspace options
and the unused-package analysis so the compiler sees one reference set across
diagnostics, hover, and usage.

Rules:

- **Fail-safe**: a missing or malformed assets file yields no references (the
  caller falls back to framework-only options) rather than an error.
- **Existence-gated**: compile paths that do not exist on disk are dropped —
  a missing-assembly reference would itself surface as a false diagnostic.
- **Placeholders are never references**: NuGet emits `_._` placeholder files
  ("no assemblies for this TFM") **path-qualified** in the compile section
  (e.g. `lib/netstandard1.0/_._` from `netstandard.library`), and the
  placeholder physically exists inside the package folder. The filter must
  match the *filename component*, not the whole compile key — handing `_._`
  to FCS as a reference attaches FS0229/FS3160 startup errors to **every**
  checked file: standing phantom errors no edit can clear (GitHub #160,
  observed against FsToolkit.ErrorHandling).

### [PKG-UNUSED-MAP] Assembly → package mapping

NuGet restores package assemblies under the global packages folder as
`<root>/<package-id-lowercased>/<version>/lib/<tfm>/<assembly>.dll`. The package
id is the path segment immediately under the global packages root. The mapping
is a pure function over the assembly path and is therefore unit-testable without
a live compilation. Assemblies that do not resolve to a package (framework
reference assemblies, project-to-project references) are ignored — they are
never reported as unused packages.

Conservatism is mandatory: a package is only ever reported unused when it has a
resolvable compile assembly that is provably not used. Packages contributing no
compile-time assembly (analyzers, build/tooling, MSBuild-only, runtime
metapackages) are **never** flagged, because their usage cannot be proven from
the compilation reference set.

### [PKG-UNUSED-REQUEST] Request flow

`sharplsp/nuget/unused` (host request): params carry the project path (and
optional solution-wide flag). The host picks the sidecar by file extension,
forwards a `project/unusedPackages` sidecar request, intersects the returned
candidate ids with the project's direct `<PackageReference>` ids (a transitive
dependency is never in the project file and must never be "removed"), and
returns `{ projectPath, unused: [{ id, version }] }`.

Removal reuses the existing `sharplsp/nuget/uninstall` request per package id —
trivia-preserving XML removal plus a background restore. The host does not
invent a second removal path.

### [PKG-UNUSED-UI] UX

- Command `sharplsp.removeUnusedPackages`, shown on `viewItem == project` and
  `viewItem == solution` in `sharplsp.solutionExplorer`.
- Detect first; if none are unused, inform and stop. Otherwise show a modal
  listing the packages to be removed and require explicit confirmation
  (destructive, behaviour-changing).
- On the solution node, detection + confirmation aggregate across all projects;
  the confirmation names each project and its unused packages.
- After removal the Solution Explorer refreshes reactively.

## [PKG-CONSOLIDATE] Consolidate Shared Packages to Directory.Build.props

Hoist NuGet packages that are referenced by **two or more** projects in the
solution into a single solution-root `Directory.Build.props`, declaring each
once and removing the per-project `<PackageReference>` entries. Available on the
**solution** node.

### [PKG-CONSOLIDATE-SCAN] Scan

Enumerate every project under the solution directory (reuse `targets`). Parse
each project's direct `<PackageReference>` ids + versions. A package is
**shared** when it appears in ≥ 2 projects. When versions differ across
projects the highest (by semantic ordering, lexical fallback) is chosen and the
divergence is reported.

### [PKG-CONSOLIDATE-APPLY] Apply

1. Ensure a `Directory.Build.props` exists at the solution root (create a
   minimal `<Project></Project>` if absent).
2. For each shared package, add it to `Directory.Build.props` and remove it from
   every project that declared it, via `xml_edit`.
3. CPM-aware: when the solution has Central Package Management
   (`Directory.Packages.props` with `ManagePackageVersionsCentrally=true`), the
   hoisted `Directory.Build.props` entry is written **versionless** and the
   version is ensured in `Directory.Packages.props` (`<PackageVersion>`), matching
   the existing install behaviour.
4. Fire a single background restore for the modified files.

Hoisting to `Directory.Build.props` makes a package apply solution-wide; the
result message states exactly which packages moved, at which version, and which
projects were edited so the behaviour change is explicit and auditable.

### [PKG-CONSOLIDATE-REQUEST] Request flow

`sharplsp/nuget/consolidate` (host request): params carry the solution path
(and/or workspace root). Pure Rust — no sidecar. Returns
`{ moved: [{ id, version, fromProjects: [...] }], propsFile, modifiedFiles }`.

### [PKG-CONSOLIDATE-UI] UX

- Command `sharplsp.consolidatePackages`, shown on `viewItem == solution`.
- Scan first; if nothing is shared, inform and stop. Otherwise show a modal
  summarising what will move, then apply on confirmation and refresh.

## Non-goals

- Transitive / framework / analyzer package pruning (cannot be proven unused).
- Rewriting version ranges, floating versions, or condition-bearing references.
- Per-`<PackageReference>` metadata (`PrivateAssets`, `IncludeAssets`) merging
  beyond a straight hoist — references carrying item metadata are reported and
  skipped rather than silently flattened.
