# Rider Plugin Specification

**Parent:** [FORGE-SPEC.md](FORGE-SPEC.md)

https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html

## 1. Overview

The Forge Rider plugin wires the `forge-lsp` binary into JetBrains Rider (and
every other non-Community IntelliJ-based IDE that ships LSP support) and adds
a **Forge Solution Explorer** tool window that renders the full solution tree
by calling the same custom LSP requests the VS Code extension uses.

**Priority:** P1 — first-class parity with the VS Code extension is a stated
project goal.

**Target IDEs:** Rider 2023.2+ (primary), IntelliJ IDEA Ultimate 2023.2+,
WebStorm, PhpStorm, PyCharm Professional, CLion, GoLand, RustRover, DataGrip,
RubyMine, DataSpell. **Not** IntelliJ Community or Android Studio — LSP API
is paid-tier only.

## 2. Why Rider, not Community Edition

JetBrains gates the LSP API (`com.intellij.modules.lsp`) to paid products.
There is no workaround — even a hand-rolled lsp4j integration can't register
a language as a first-class Rider language because Rider owns C# / F#
language registration. The Forge plugin therefore declares a hard dependency
on the `com.intellij.modules.lsp` module and fails to load on Community.

## 3. Architecture

```
Rider JVM ──lsp4j──> forge-lsp (stdio, MessagePack for IPC to sidecars)
    │
    ├── ForgeLspServerSupportProvider   (extension point)
    │     └── ForgeLspServerDescriptor  (launches forge-lsp, sets env)
    │           └── ForgeLsp4jServer    (custom request interface)
    │
    └── ForgeSolutionToolWindow         (toolWindow extension point)
          └── ForgeSolutionTreeModel    (AsyncTreeModel + JTree)
                └── calls ForgeLsp4jServer.workspaceSymbols() /
                          nugetInstalled()
```

No sidecar, no webview, no MessagePack on the Rider side. The plugin is
**thin** — it does nothing the LSP server can't do, it only renders.

## 4. Build & Packaging

- **Language:** Kotlin (JetBrains-preferred, shorter boilerplate than Java).
- **Build tool:** Gradle with the `org.jetbrains.intellij.platform` plugin
  (v2.x), which is the current supported build flow. The older
  `gradle-intellij-plugin` (1.x) is legacy and must not be used.
- **JVM target:** 17 (Rider 2023.2+ ships JetBrains Runtime 17).
- **Kotlin target:** `jvmTarget = 17`, stdlib from the platform — do NOT
  bundle `kotlin-stdlib` to avoid classpath conflicts.
- **Source layout:** `editors/rider/` with the conventional Gradle structure:
  ```
  editors/rider/
  ├── build.gradle.kts
  ├── settings.gradle.kts
  ├── gradle.properties
  ├── gradle/wrapper/               (generated)
  ├── gradlew, gradlew.bat          (generated)
  └── src/main/
      ├── kotlin/com/forgelsp/rider/
      │   ├── lsp/ForgeLspServerSupportProvider.kt
      │   ├── lsp/ForgeLspServerDescriptor.kt
      │   ├── lsp/ForgeLsp4jServer.kt
      │   ├── toolwindow/ForgeSolutionToolWindowFactory.kt
      │   ├── toolwindow/ForgeSolutionTree.kt
      │   ├── toolwindow/ForgeSolutionTreeModel.kt
      │   └── toolwindow/nodes/*.kt
      └── resources/
          ├── META-INF/plugin.xml
          └── icons/forge.svg
  ```
- **Distribution artifact:** `forge-rider-plugin.zip`, produced by the
  `buildPlugin` Gradle task at `editors/rider/build/distributions/`.
  Copied to the repo root as `forge.zip` (alongside `forge.vsix`).
- **Gradle wrapper:** committed so contributors and CI don't need a system
  Gradle.
- **Binary resolution:** the plugin does **not** bundle `forge-lsp`. It
  resolves the binary identically to the VS Code extension:
  1. `forge.server.path` setting (per-project, stored in workspace.xml)
  2. `~/.local/bin/forge-lsp`
  3. Anything on `$PATH`
  4. Clear error with install instructions if none found
  This keeps the plugin zip under 200 KB and sidesteps Rider's plugin-size
  warnings.

## 5. LSP Integration

### 5.1 `ForgeLspServerSupportProvider`

Registered via `com.intellij.platform.lsp.serverSupportProvider`. On
`fileOpened()` it checks the file extension (`.cs`, `.csx`, `.fs`, `.fsx`,
`.fsi`) and returns a shared `ForgeLspServerDescriptor` keyed by project.
One server per Rider project, not per file.

### 5.2 `ForgeLspServerDescriptor`

- `isSupportedFile(VirtualFile)` — whitelist of C# / F# extensions.
- `createCommandLine()` — builds a `GeneralCommandLine` pointing at the
  resolved `forge-lsp` binary, sets `RUST_LOG=info`, inherits the project's
  `VIRTUAL_FILE_DELIMITER` and working directory.
- `lsp4jServerClass = ForgeLsp4jServer::class.java` — this is the hook
  JetBrains documents for custom requests. The returned class extends
  `org.eclipse.lsp4j.services.LanguageServer` with `@JsonRequest` and
  `@JsonNotification` methods matching `forge/*`.
- `createLsp4jClient()` — default client, we don't need server→client
  notifications yet (restoreProgress is VS Code-only for now).

### 5.3 `ForgeLsp4jServer` (custom interface)

```kotlin
interface ForgeLsp4jServer : LanguageServer {
    @JsonRequest("forge/workspaceSymbols")
    fun workspaceSymbols(params: WorkspaceSymbolsParams): CompletableFuture<WorkspaceSymbolsResponse>

    @JsonRequest("forge/nuget/installed")
    fun nugetInstalled(params: NuGetInstalledParams): CompletableFuture<NuGetInstalledResponse>

    @JsonRequest("forge/nuget/targets")
    fun nugetTargets(params: NuGetTargetsParams): CompletableFuture<NuGetTargetsResponse>

    @JsonRequest("forge/loadSolution")
    fun loadSolution(params: LoadSolutionParams): CompletableFuture<LoadSolutionResponse>
}
```

All DTOs are plain Kotlin data classes with `@JvmField`-compatible shapes
matching the JSON wire format the Rust side already emits. **Zero schema
drift** — the Rust server is the source of truth.

## 6. Solution Explorer Tool Window

### 6.1 Registration

```xml
<extensions defaultExtensionNs="com.intellij">
  <toolWindow id="ForgeSolution"
              anchor="left"
              icon="/icons/forge.svg"
              factoryClass="com.forgelsp.rider.toolwindow.ForgeSolutionToolWindowFactory"/>
</extensions>
```

The tool window opens on the left, below Rider's own Solution Explorer so
the two sit side by side. The Forge panel is clearly branded "Forge" so
users can tell it apart.

### 6.2 Structure

Top-level nodes, in order:

1. **Solution root** — the `.sln` or `.slnx` file discovered in the project root (or
   picked via a right-click action if multiple).
2. **Projects** — one node per `.csproj` / `.fsproj` in the solution. Each
   project node has three children:
   - **Dependencies**
     - **Packages** — from `forge/nuget/installed`, one leaf per installed
       NuGet package with version
     - **Project References** — parsed from the csproj XML on the Rider
       side (lightweight, no LSP round-trip)
   - **Source** — namespaces → types → members, sourced from
     `forge/workspaceSymbols`. Lazy: we only ask the LSP for a project's
     symbols the first time its node is expanded.

### 6.3 Async / background behaviour

- All LSP calls run on a bounded `AppExecutorUtil` background pool — never
  on the EDT. The tree uses `AsyncTreeModel` wrapping a
  `StructureTreeModel` so expansion and data load don't freeze the UI.
- Loading state is a spinning `AnimatedIcon.Default` leaf on the expanding
  node until the real children arrive — matches Rider's built-in
  "Loading..." convention.
- Errors surface as a red leaf with the error message; right-click →
  "Retry" re-fires the request.

### 6.4 Actions on tree nodes

- **Double-click a file leaf** — opens it in the editor at the symbol's
  range.
- **Double-click a symbol** — opens the file and navigates to the symbol.
- **Right-click a project** — "Reveal in Explorer", "Open csproj", "Copy
  path".
- **Right-click a NuGet package** — "Remove package" (future; gated on the
  Rust host shipping `forge/nuget/uninstall` with restore, which it
  already does — so this is wirable day one).
- **Toolbar** — "Refresh" (re-fetches top level), "Collapse All", filter
  text box.

### 6.5 Auto-refresh

The tool window subscribes to VFS events for `.sln`, `.slnx`, `.csproj`, `.fsproj`,
`Directory.Build.props`, `Directory.Packages.props`. Any change re-fires
the appropriate subtree load — no full reload. Debounced 300 ms so a
multi-file save burst doesn't thrash.

## 7. Error handling

- LSP binary not found → toast notification with a "Configure" button
  that opens the settings panel. Tool window shows a single "forge-lsp not
  installed" node with install instructions as a tooltip.
- Server crash → lsp4j automatically restarts it (JetBrains LSP API
  contract). The tool window shows a stale tree with a warning banner
  until the first successful `workspaceSymbols` round-trip.
- Custom request returns an error → the failing subtree shows a red leaf
  with the error text. The rest of the tree continues to work.

## 8. Settings

Single settings panel at **Settings → Tools → Forge**:

- **Server path** — override for `forge-lsp` binary location (default:
  auto-detect).
- **Log level** — dropdown (error / warn / info / debug / trace),
  translates to `RUST_LOG`.
- **Auto-load solution on open** — bool, default true.

Stored in project-level `workspace.xml` via `PersistentStateComponent`.

## 9. Testing

### 9.1 Unit tests

- `ForgeLspServerDescriptor.createCommandLine()` builds the expected
  command on macOS / Linux / Windows given a known binary path.
- DTO round-trip: serialize a known JSON fixture → deserialize → assert
  structure matches `forge/workspaceSymbols` schema.
- Tree model: given a canned `WorkspaceSymbolsResponse`, the tree renders
  the expected node hierarchy with correct icons.

### 9.2 Integration tests

Rider's test framework (`BasePlatformTestCase`) loads a test project with
a real `.sln` or `.slnx` plus one `.csproj`, spawns a fake stdio server that echoes
canned JSON responses, and asserts:

- The tool window populates within 5 s of project open.
- Double-clicking a symbol node opens the correct file at the correct
  offset.
- A VFS change to the `.csproj` triggers exactly one subtree reload.

### 9.3 Smoke test against a real forge-lsp

A manual dev-loop test, run from `make test-rider`:

1. `make install` — binaries in `~/.local/bin` and `~/.local/lib/forge`.
2. `./gradlew runIde` — boots a sandboxed Rider instance with the plugin.
3. Open `examples/HelloForge.sln` or `examples/HelloForge.slnx`.
4. Assert the Forge Solution tool window renders the project tree.

## 10. Editor Support Matrix (updated)

| Editor | LSP | Solution Explorer | NuGet Browser | Profiler |
|--------|-----|-------------------|---------------|----------|
| VS Code | ✅ | ✅ webview tree | ✅ webview | ✅ |
| Rider / IntelliJ Ultimate | ✅ | ✅ **tool window** | ⏳ future | ⏳ |
| Neovim | ✅ | CLI `/forge-tree` | CLI | ❌ |
| Helix | ✅ | CLI | CLI | ❌ |
| Zed | ✅ | `/forge-tree` slash command | ❌ (no extension UI) | ❌ |

The Rider plugin brings genuine feature parity with VS Code for the Solution
Explorer use case. NuGet Browser and Profiler UIs remain VS Code-only until
the Rider plugin grows them — their data flows (`forge/nuget/*`,
`forge/profiler/*`) are already LSP-native so future parity is purely a
rendering job.
