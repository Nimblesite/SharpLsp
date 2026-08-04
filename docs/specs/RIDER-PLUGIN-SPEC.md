# Rider Plugin Specification `[RIDER-PLUGIN]`

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md)

## Overview `[RIDER-OVERVIEW]`

The SharpLsp Rider plugin wires the `sharplsp` binary into JetBrains Rider (and every other non-Community IntelliJ-based IDE that ships LSP support) and adds a **SharpLsp Solution Explorer** tool window that renders the full solution tree by calling the same custom LSP requests the VS Code extension uses.

**Target IDEs:** Rider 2026.1 (primary), IntelliJ IDEA Ultimate 2023.2+, WebStorm, PhpStorm, PyCharm Professional, CLion, GoLand, RustRover, DataGrip, RubyMine, DataSpell. **Not** IntelliJ Community or Android Studio — LSP API is paid-tier only.

The plugin uses JetBrains' [LSP API](https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html).

## Paid-platform scope `[RIDER-PLATFORM-SCOPE]`

JetBrains gates `com.intellij.modules.lsp` to paid products. The plugin declares that module as a hard dependency and MUST refuse to load where it is absent.

## Architecture `[RIDER-ARCHITECTURE]`

```
Rider JVM ──lsp4j──> sharplsp (stdio; sidecars remain host-owned)
    │
    ├── ForgeLspServerSupportProvider   (extension point)
    │     └── ForgeLspServerDescriptor  (launches sharplsp, sets env)
    │           └── ForgeLsp4jServer    (custom request interface)
    │
    └── ForgeSolutionToolWindow         (toolWindow extension point)
          └── ForgeTreeNode hierarchy
                └── calls ForgeLsp4jServer.workspaceSymbols() /
                          nugetInstalled()
```

The plugin owns no sidecar, webview, or MessagePack transport; it launches the Rust host and renders LSP responses. Implementations: [`lsp/`](../../src/editors/rider/src/main/kotlin/com/forgelsp/rider/lsp) and [`toolwindow/`](../../src/editors/rider/src/main/kotlin/com/forgelsp/rider/toolwindow).

## Build and Packaging `[RIDER-BUILD]`

- **Language:** Kotlin 2.3.
- **Build tool:** Gradle with `org.jetbrains.intellij.platform` 2.14. The older `gradle-intellij-plugin` (1.x) is legacy and must not be used.
- **JVM target:** 21 for Rider 2026.1.
- **Kotlin target:** JVM toolchain 21, stdlib from the platform — do NOT bundle `kotlin-stdlib` to avoid classpath conflicts.
- **Source layout:** `src/editors/rider/` with the conventional Gradle structure:
  ```
  src/editors/rider/
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
      │   ├── toolwindow/ForgeSolutionToolWindow.kt
      │   └── toolwindow/nodes/*.kt
      └── resources/
          ├── META-INF/plugin.xml
          └── icons/forge.svg
  ```
- **Distribution artifact:** `sharplsp-rider-plugin.zip`, produced by the `buildPlugin` Gradle task at `src/editors/rider/build/distributions/`. Copied to `dist/sharplsp-rider.zip` alongside the other packaged editor artifacts.
- **Gradle wrapper:** committed so contributors and CI don't need a system Gradle.
- **Binary resolution:** the plugin does **not** bundle `sharplsp`. It resolves the binary identically to the VS Code extension:
  1. `sharplsp.lspPath` setting (per-project, stored in workspace.xml)
  2. `~/.local/bin/sharplsp`
  3. Anything on `$PATH`
  4. Clear error with install instructions if none found The plugin zip MUST remain below 200 KB.

## LSP Integration `[RIDER-LSP]`

### `ForgeLspServerSupportProvider` `[RIDER-LSP-PROVIDER]`

[`ForgeLspServerSupportProvider.kt`](../../src/editors/rider/src/main/kotlin/com/forgelsp/rider/lsp/ForgeLspServerSupportProvider.kt) is registered via `com.intellij.platform.lsp.serverSupportProvider`. On `fileOpened()` it checks the file extension (`.cs`, `.csx`, `.fs`, `.fsx`, `.fsi`) and returns a shared `ForgeLspServerDescriptor` keyed by project. One server per Rider project, not per file.

### `ForgeLspServerDescriptor` `[RIDER-LSP-DESCRIPTOR]`

- `isSupportedFile(VirtualFile)` — whitelist of C# / F# extensions.
- `createCommandLine()` — builds a UTF-8 `GeneralCommandLine` for the resolved `sharplsp`, sets `RUST_LOG` from project settings, and uses the project base path as working directory.
- `lsp4jServerClass = ForgeLsp4jServer::class.java` — this is the hook JetBrains documents for custom requests. The returned class extends `org.eclipse.lsp4j.services.LanguageServer` with `@JsonRequest` and `@JsonNotification` methods matching `sharplsp/*`.

### `ForgeLsp4jServer` custom interface `[RIDER-LSP-INTERFACE]`

```kotlin
interface ForgeLsp4jServer : LanguageServer {
    @JsonRequest("sharplsp/workspaceSymbols")
    fun workspaceSymbols(params: WorkspaceSymbolsParams): CompletableFuture<WorkspaceSymbolsResponse>

    @JsonRequest("sharplsp/nuget/installed")
    fun nugetInstalled(params: NuGetInstalledParams): CompletableFuture<NuGetInstalledResponse>

    @JsonRequest("sharplsp/nuget/targets")
    fun nugetTargets(params: NuGetTargetsParams): CompletableFuture<NuGetTargetsResponse>

    @JsonRequest("sharplsp/loadSolution")
    fun loadSolution(params: LoadSolutionParams): CompletableFuture<LoadSolutionResponse>
}
```

DTO camel-case fields MUST match the Rust JSON wire format. Implementation: [`ForgeLsp4jServer.kt`](../../src/editors/rider/src/main/kotlin/com/forgelsp/rider/lsp/ForgeLsp4jServer.kt).

## Solution Explorer Tool Window `[RIDER-SOLUTION]`

### Registration `[RIDER-SOLUTION-REGISTRATION]`

```xml
<extensions defaultExtensionNs="com.intellij">
  <toolWindow id="Forge Solution"
              anchor="left"
              icon="/icons/forge.svg"
              factoryClass="com.forgelsp.rider.toolwindow.ForgeSolutionToolWindowFactory"/>
</extensions>
```

The `Forge Solution` tool window is anchored left beside Rider's explorer.

### Structure `[RIDER-SOLUTION-STRUCTURE]`

Top-level nodes, in order:

1. **Solution root** — the `.sln` or `.slnx` file discovered in the project root (or picked via a right-click action if multiple).
2. **Projects** — one node per `.csproj` / `.fsproj` in the solution. Each project node has three children:
   - **Dependencies**
     - **Packages** — from `sharplsp/nuget/installed`, one leaf per installed NuGet package with version
     - **Project References** — parsed from the csproj XML on the Rider side (lightweight, no LSP round-trip)
   - **Source** — namespaces → types → members, sourced from `sharplsp/workspaceSymbols`. Lazy: we only ask the LSP for a project's symbols the first time its node is expanded.

### Async and background behavior `[RIDER-SOLUTION-ASYNC]`

- LSP calls use `executeOnPooledThread` and return `CompletableFuture`; callbacks update a Swing `DefaultTreeModel` on the EDT. Server startup polls for at most 15 seconds and requests time out after 30 seconds.
- Loading state is a spinning `AnimatedIcon.Default` leaf on the expanding node until the real children arrive — matches Rider's built-in "Loading..." convention.
- Errors surface as a red leaf with the error message; right-click → "Retry" re-fires the request.

### Actions on tree nodes `[RIDER-SOLUTION-ACTIONS]`

- **Double-click a file leaf** — opens it in the editor at the symbol's range.
- **Double-click a symbol** — opens the file and navigates to the symbol.
- **Right-click a project** — "Reveal in Explorer", "Open csproj", "Copy path".
- **Right-click a NuGet package** — "Remove package" sends `sharplsp/nuget/uninstall`.
- **Toolbar** — "Refresh" (re-fetches top level), "Collapse All", filter text box.

### Auto-refresh `[RIDER-SOLUTION-REFRESH]`

The tool window subscribes to VFS events for `.sln`, `.slnx`, `.csproj`, `.fsproj`, `Directory.Build.props`, `Directory.Packages.props`. Any change re-fires the appropriate subtree load — no full reload. Debounced 300 ms so a multi-file save burst doesn't thrash.

## Error handling `[RIDER-ERRORS]`

- LSP binary not found → toast notification with a "Configure" button that opens the settings panel. Tool window shows a single "sharplsp not installed" node with install instructions as a tooltip.
- Server crash → lsp4j automatically restarts it (JetBrains LSP API contract). The tool window shows a stale tree with a warning banner until the first successful `workspaceSymbols` round-trip.
- Custom request returns an error → the failing subtree shows a red leaf with the error text. The rest of the tree continues to work.

## Settings `[RIDER-SETTINGS]`

Single settings panel at **Settings → Tools → SharpLsp**:

- **Server path** — override for `sharplsp` binary location (default: auto-detect).
- **Log level** — dropdown (error / warn / info / debug / trace), translates to `RUST_LOG`.
- **Auto-load solution on open** — bool, default true.

Stored in project-level `workspace.xml` via `PersistentStateComponent`.

## Testing `[RIDER-TESTS]`

### Descriptor and model coverage `[RIDER-TESTS-MODEL]`

- `SharpLspLspServerDescriptor.createCommandLine()` builds the expected command on macOS / Linux / Windows given a known binary path.
- DTO round-trip: serialize a known JSON fixture → deserialize → assert structure matches `sharplsp/workspaceSymbols` schema.
- Tree model: given a canned `WorkspaceSymbolsResponse`, the tree renders the expected node hierarchy with correct icons.

### Rider integration coverage `[RIDER-TESTS-INTEGRATION]`

Rider's test framework (`BasePlatformTestCase`) loads a test project with a real `.sln` or `.slnx` plus one `.csproj`, spawns a fake stdio server that echoes canned JSON responses, and asserts:

- The tool window populates within 5 s of project open.
- Double-clicking a symbol node opens the correct file at the correct offset.
- A VFS change to the `.csproj` triggers exactly one subtree reload.

### Real-server smoke coverage `[RIDER-TESTS-SMOKE]`

A manual dev-loop test, run from `make test-rider`:

1. `make install` — binaries in `~/.local/bin` and `~/.local/lib/sharplsp`.
2. `./gradlew runIde` — boots a sandboxed Rider instance with the plugin.
3. Open `src/examples/Test.sln`.
4. Assert the SharpLsp Solution tool window renders the project tree.
