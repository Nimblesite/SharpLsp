# Rider Plugin Implementation Plan

**Spec:** [RIDER-PLUGIN-SPEC.md](../specs/RIDER-PLUGIN-SPEC.md)

## Execution order

Phases 1 → 2 → 3 are strictly sequential (each depends on the previous).
Phases 4, 5, and 6 are independent and can land in any order once Phase 3
is stable. Phase 7 (Makefile) should happen as soon as Phase 1 is done so
the dev loop is usable from the repo root. Phase 8 (tests) tracks each
feature phase rather than batching at the end. Phases 9 and 10 are last.

## Definition of Done

The Rider plugin is "done" when:

1. Installing it into a fresh Rider loads cleanly with no errors.
2. Opening a .NET solution shows the full SharpLsp Solution tool window
   populated within 5 s.
3. Every top-level VS Code Solution Explorer feature has a working
   equivalent: project list, NuGet packages, project references,
   namespace/type/symbol tree, double-click navigation, right-click
   actions, auto-refresh on file changes.
4. `make ci` passes with `build-rider` and `test-rider` in the matrix.
5. The plugin zip is < 500 KB.

## Phase summaries

**Phase 1 — Gradle scaffold.** Stand up `editors/rider/` with a Gradle
wrapper, `build.gradle.kts` using the 2.x `org.jetbrains.intellij.platform`
plugin targeting Rider 2024.3, a `plugin.xml` that depends on
`com.intellij.modules.lsp`, and just enough Kotlin stubs for
`./gradlew buildPlugin` to produce a non-empty `build/distributions/*.zip`.

**Phase 2 — LSP server integration.** Wire `SharpLspLspServerSupportProvider`
to the `platform.lsp.serverSupportProvider` extension point; have it start
a `SharpLspLspServerDescriptor` on any `.cs` / `.csx` / `.fs` / `.fsx` / `.fsi`
file. The descriptor resolves `sharplsp-lsp` with the same priority list as
the VS Code extension (setting override → `~/.local/bin` → `$PATH`) and
exposes a custom `SharpLspLsp4jServer` subinterface of `LanguageServer` that
declares `@JsonRequest("sharplsp/...")` methods for every SharpLsp custom
endpoint we consume.

**Phase 3 — Solution Explorer tool window.** `SharpLspSolutionToolWindowFactory`
registered at the `toolWindow` extension point. The tree is a
`StructureTreeModel` wrapped in an `AsyncTreeModel`, with one node class per
hierarchy level: `SolutionRootNode`, `ProjectNode`, `DependenciesNode`,
`NuGetPackageNode`, `ProjectReferenceNode`, `NamespaceNode`, `TypeNode`,
`MemberNode`. Children load lazily: expanding a project node fires the
LSP round-trip for that project's symbols. Loading placeholders use
`AnimatedIcon.Default`; errors become red leaves with a retry action.

**Phase 4 — Navigation and actions.** Double-click opens the target file
at the symbol's range via `OpenFileDescriptor`. A context menu exposes
"Reveal in Explorer" / "Open csproj" / "Copy path" on project nodes and
"Remove package" on NuGet leaves (which fires `sharplsp/nuget/uninstall`,
already shipping on the Rust side). Toolbar: Refresh, Collapse All, filter
text box.

**Phase 5 — Auto-refresh on filesystem changes.** The tool window
subscribes to `VirtualFileManager.VFS_CHANGES`, filters events to
`.sln` / `.csproj` / `.fsproj` / `Directory.Build.props` /
`Directory.Packages.props`, debounces 300 ms, and reloads only the affected
subtree.

**Phase 6 — Settings.** Project-level `PersistentStateComponent` stored in
`workspace.xml`, plus a `Settings → Tools → SharpLsp` panel with three knobs:
server path override, log level (maps to `RUST_LOG`), auto-load solution on
open. `SharpLspLspServerDescriptor.createCommandLine()` reads these on every
server launch.

**Phase 7 — Build infrastructure.** New Makefile targets: `build-rider`,
`package-rider` (alias), `test-rider`, `lint-rider`, `clean-rider`. Wire
`build-rider` into the top-level `build` and `test-rider` into `test`.
Copy the produced plugin zip to the repo root as `sharplsp-rider.zip` for
parity with `sharplsp.vsix` and `sharplsp-zed-extension.tar.gz`. Gracefully skip
with a warning if no JVM is available so the rest of the repo still
builds.

**Phase 8 — Tests.** Unit tests for DTO round-tripping, path resolution,
and tree-model construction. Integration test via `BasePlatformTestCase`
that loads a minimal .sln and asserts the tool window populates. Coverage
target: 80 % line coverage (excluding generated lsp4j glue).

**Phase 9 — CI.** Add a `build-rider` + `test-rider` matrix job in
`.github/workflows/ci.yml` requiring JDK 17, caching Gradle. Upload the
plugin zip as a release artifact alongside the VSIX.

**Phase 10 — Docs.** Add Rider rows to `CSDEVKIT-PARITY-PLAN.md` and
`SHARPLSP-SPEC.md` editor matrix. Troubleshooting note: LSP is paid-tier
only — Community editions are not supported.

## TODOs

### Phase 1: Gradle scaffold

- [x] Create `editors/rider/` directory
- [x] Write `settings.gradle.kts` — `rootProject.name = "sharplsp-rider"`
- [x] Write `build.gradle.kts` using `org.jetbrains.intellij.platform` 2.14
- [x] Write `gradle.properties` pinning platform version (Rider 2024.3)
- [x] Write `src/main/resources/META-INF/plugin.xml` — depends on
      `com.intellij.modules.lsp`, registers tool window + settings + LSP
      support provider extension points
- [x] Add `gradle/wrapper/gradle-wrapper.properties` + `gradlew` shim
- [x] Commit a `.gitignore` for `build/`, `.gradle/`, `.idea/`
- [ ] `./gradlew buildPlugin` produces a non-empty `build/distributions/*.zip`
      *(blocked — Phase 2/3 Kotlin stubs need full implementation)*

### Phase 2: LSP server integration

- [ ] `SharpLspLspServerSupportProvider` implements
      `com.intellij.platform.lsp.api.LspServerSupportProvider`
- [ ] `SharpLspLspServerDescriptor` extends `ProjectWideLspServerDescriptor`
      and overrides:
    - [ ] `isSupportedFile(VirtualFile)` — `.cs`, `.csx`, `.fs`, `.fsx`, `.fsi`
    - [ ] `createCommandLine()` — resolves `sharplsp-lsp` via the same
          priority list as the VS Code extension
    - [ ] `lsp4jServerClass` — points at `SharpLspLsp4jServer`
- [ ] `SharpLspLsp4jServer` interface with `@JsonRequest` methods for
      `sharplsp/workspaceSymbols`, `sharplsp/nuget/installed`, `sharplsp/nuget/targets`,
      `sharplsp/loadSolution`
- [ ] DTO data classes matching the Rust JSON wire format exactly
- [ ] Smoke test: open a `.cs` file in a dev Rider, verify the LSP status
      bar shows "sharplsp-lsp running"

### Phase 3: Solution Explorer tool window

- [ ] `SharpLspSolutionToolWindowFactory` registered via `toolWindow` EP
- [ ] `SharpLspSolutionTreeModel` extends `StructureTreeModel` with
      `AsyncTreeModel` wrapping
- [ ] Node hierarchy:
    - [ ] `SolutionRootNode` — displays .sln filename, loads projects lazily
    - [ ] `ProjectNode` — three child groups: Dependencies / Source
    - [ ] `DependenciesNode` — Packages + Project References
    - [ ] `NuGetPackageNode` — leaf, icon = package, tooltip with version
    - [ ] `ProjectReferenceNode` — leaf, icon = project link
    - [ ] `NamespaceNode` — from workspaceSymbols response
    - [ ] `TypeNode` — class/struct/interface/enum/record
    - [ ] `MemberNode` — method/property/field/event, with access modifier
          icon
- [ ] Loading placeholder: spinner leaf while a child load is in flight
- [ ] Error placeholder: red leaf with message + retry action

### Phase 4: Navigation and actions

- [ ] Double-click on a file / symbol leaf opens the file at the symbol's
      range via `OpenFileDescriptor`
- [ ] Right-click context menu:
    - [ ] `RevealInExplorerAction` on project nodes
    - [ ] `OpenProjectFileAction` on project nodes
    - [ ] `CopyPathAction` on any path-backed node
    - [ ] `RemoveNuGetPackageAction` on NuGet package leaves (fires
          `sharplsp/nuget/uninstall`)
- [ ] Toolbar actions: Refresh, Collapse All, filter text box

### Phase 5: Auto-refresh on filesystem changes

- [ ] Subscribe to `VirtualFileManager.VFS_CHANGES` for the project
- [ ] Filter events to `.sln`, `.csproj`, `.fsproj`, `Directory.Build.props`,
      `Directory.Packages.props`
- [ ] Debounce 300 ms, then reload the smallest affected subtree
- [ ] Integration test: modifying a csproj triggers exactly one reload

### Phase 6: Settings

- [ ] `ForgeSettings` — `PersistentStateComponent<ForgeSettings.State>`,
      project-level, stored in `workspace.xml`
- [ ] `ForgeSettingsConfigurable` registered at `Settings → Tools → SharpLsp`
- [ ] Fields: server path, log level, auto-load solution
- [ ] `SharpLspLspServerDescriptor` reads settings when building the command
      line

### Phase 7: Build infrastructure

- [ ] Add `build-rider` Makefile target — calls `./gradlew buildPlugin`
      and copies the zip to repo root as `sharplsp-rider.zip` — **but only if**
      the environment has a JVM; otherwise skip with a warning
- [ ] Add `package-rider` Makefile target — alias for `build-rider` for
      naming symmetry with `package-zed`
- [ ] Add `test-rider` Makefile target — `./gradlew test`
- [ ] Add `lint-rider` Makefile target — `./gradlew check`
- [ ] Add `clean-rider` Makefile target — `./gradlew clean`
- [ ] Wire `build-rider` into the top-level `build` target
- [ ] Wire `test-rider` into the top-level `test` target
- [ ] Update README `Install` section with a one-paragraph Rider block

### Phase 8: Tests

- [ ] Unit tests for DTO round-tripping (JSON fixture → Kotlin → assert)
- [ ] Unit tests for `createCommandLine()` path resolution (mock FS)
- [ ] Unit tests for tree model node construction from a canned response
- [ ] `BasePlatformTestCase` integration test that boots a minimal project
      and asserts the tool window populates
- [ ] Coverage target: 80 % line coverage on plugin code (excluding
      generated lsp4j glue)

### Phase 9: CI

- [ ] Add `build-rider` + `test-rider` to `.github/workflows/ci.yml`
      under a matrix job that requires JDK 17
- [ ] Cache `~/.gradle/caches` and `~/.gradle/wrapper`
- [ ] Verify the Rider plugin zip is uploaded as a build artifact on tag
      releases alongside the VSIX

### Phase 10: Docs

- [ ] `docs/specs/RIDER-PLUGIN-SPEC.md` — sibling (done in this change)
- [ ] Add a row for Rider to the `CSDEVKIT-PARITY-PLAN.md` feature matrix
- [ ] Update `docs/specs/SHARPLSP-SPEC.md` editor matrix with Rider
- [ ] Add a troubleshooting note: "LSP API is paid-tier only — Community
      editions are not supported"
