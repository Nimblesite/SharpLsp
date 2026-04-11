# Rider Plugin Implementation Plan

**Spec:** [RIDER-PLUGIN-SPEC.md](../specs/RIDER-PLUGIN-SPEC.md)

## Phase 1: Gradle scaffold

- [ ] Create `editors/rider/` directory
- [ ] Write `settings.gradle.kts` — `rootProject.name = "forge-rider"`
- [ ] Write `build.gradle.kts` using `org.jetbrains.intellij.platform` 2.x
- [ ] Write `gradle.properties` pinning platform version (Rider 2024.3)
- [ ] Write `src/main/resources/META-INF/plugin.xml` — depends on
      `com.intellij.modules.lsp`, registers tool window + settings + LSP
      support provider extension points
- [ ] Add `gradle/wrapper/gradle-wrapper.properties` + `gradlew` shim
- [ ] Commit a `.gitignore` for `build/`, `.gradle/`, `.idea/`
- [ ] `./gradlew buildPlugin` produces a non-empty `build/distributions/*.zip`

## Phase 2: LSP server integration

- [ ] `ForgeLspServerSupportProvider` implements
      `com.intellij.platform.lsp.api.LspServerSupportProvider`
- [ ] `ForgeLspServerDescriptor` extends `ProjectWideLspServerDescriptor`
      and overrides:
      - [ ] `isSupportedFile(VirtualFile)` — `.cs`, `.csx`, `.fs`, `.fsx`, `.fsi`
      - [ ] `createCommandLine()` — resolves `forge-lsp` via the same
            priority list as the VS Code extension
      - [ ] `lsp4jServerClass` — points at `ForgeLsp4jServer`
- [ ] `ForgeLsp4jServer` interface with `@JsonRequest` methods for
      `forge/workspaceSymbols`, `forge/nuget/installed`, `forge/nuget/targets`,
      `forge/loadSolution`
- [ ] DTO data classes matching the Rust JSON wire format exactly
- [ ] Smoke test: open a `.cs` file in a dev Rider, verify the LSP status
      bar shows "forge-lsp running"

## Phase 3: Solution Explorer tool window

- [ ] `ForgeSolutionToolWindowFactory` registered via `toolWindow` EP
- [ ] `ForgeSolutionTreeModel` extends `StructureTreeModel` with
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

## Phase 4: Navigation and actions

- [ ] Double-click on a file / symbol leaf opens the file at the symbol's
      range via `OpenFileDescriptor`
- [ ] Right-click context menu:
  - [ ] `RevealInExplorerAction` on project nodes
  - [ ] `OpenProjectFileAction` on project nodes
  - [ ] `CopyPathAction` on any path-backed node
  - [ ] `RemoveNuGetPackageAction` on NuGet package leaves (fires
        `forge/nuget/uninstall`)
- [ ] Toolbar actions: Refresh, Collapse All, filter text box

## Phase 5: Auto-refresh on filesystem changes

- [ ] Subscribe to `VirtualFileManager.VFS_CHANGES` for the project
- [ ] Filter events to `.sln`, `.csproj`, `.fsproj`, `Directory.Build.props`,
      `Directory.Packages.props`
- [ ] Debounce 300 ms, then reload the smallest affected subtree
- [ ] Integration test: modifying a csproj triggers exactly one reload

## Phase 6: Settings

- [ ] `ForgeSettings` — `PersistentStateComponent<ForgeSettings.State>`,
      project-level, stored in `workspace.xml`
- [ ] `ForgeSettingsConfigurable` registered at
      `Settings → Tools → Forge`
- [ ] Fields: server path, log level, auto-load solution
- [ ] `ForgeLspServerDescriptor` reads settings when building the command
      line

## Phase 7: Build infrastructure

- [ ] Add `build-rider` Makefile target — calls `./gradlew buildPlugin`
      and copies the zip to repo root as `forge.zip` — **but only if** the
      environment has a JVM; otherwise skip with a warning (so CI without
      JVM still builds the rest of the repo)
- [ ] Add `package-rider` Makefile target — alias for `build-rider` for
      naming symmetry with `package-zed`
- [ ] Add `test-rider` Makefile target — `./gradlew test`
- [ ] Add `lint-rider` Makefile target — `./gradlew detekt` if detekt is
      configured, otherwise `./gradlew check`
- [ ] Add `clean-rider` Makefile target — `./gradlew clean`
- [ ] Wire `build-rider` into the top-level `build` target
- [ ] Wire `test-rider` into the top-level `test` target
- [ ] Update `editors/` README section with one-paragraph Rider install
      steps matching the compact format the user chose for VSIX

## Phase 8: Tests

- [ ] Unit tests for DTO round-tripping (JSON fixture → Kotlin → assert)
- [ ] Unit tests for `createCommandLine()` path resolution (mock FS)
- [ ] Unit tests for tree model node construction from a canned response
- [ ] `BasePlatformTestCase` integration test that boots a minimal project
      and asserts the tool window populates
- [ ] Coverage target: 80 % line coverage on plugin code (excluding
      generated lsp4j glue)

## Phase 9: CI

- [ ] Add `build-rider` + `test-rider` to `.github/workflows/ci.yml`
      under a matrix job that requires JDK 17
- [ ] Cache `~/.gradle/caches` and `~/.gradle/wrapper`
- [ ] Verify the Rider plugin zip is uploaded as a build artifact on tag
      releases alongside the VSIX

## Phase 10: Docs

- [ ] `docs/specs/RIDER-PLUGIN-SPEC.md` — this file's sibling
- [ ] Add a row for Rider to the CSDEVKIT-PARITY-PLAN.md feature matrix
- [ ] Update `docs/specs/FORGE-SPEC.md` editor matrix with Rider
- [ ] Add a troubleshooting note: "LSP API is paid-tier only — Community
      editions are not supported"

## Execution order

Phase 1 → 2 → 3 in sequence (each depends on the previous). Phases 4, 5,
6 are independent and can land in any order once 3 is stable. Phase 7
(Makefile) can happen as soon as Phase 1 is done so the dev loop is
usable. Phase 8 (tests) should track each feature phase, not be a
separate pass at the end. Phases 9 and 10 are last.

## Definition of Done

The Rider plugin is "done" when:

1. Installing it into a fresh Rider loads cleanly with no errors.
2. Opening a .NET solution shows the full Forge Solution tool window
   populated within 5 s.
3. Every top-level VS Code Solution Explorer feature has a working
   equivalent: project list, nuget packages, project references,
   namespace/type/symbol tree, double-click navigation, right-click
   actions, auto-refresh on file changes.
4. `make ci` passes with `build-rider` and `test-rider` in the matrix.
5. The plugin zip is < 500 KB.
