# Scripting and File-Based Apps Specification `[SCRIPT-SPEC]`

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md)

## Overview `[SCRIPT-OVERVIEW]`

SharpLsp provides semantic support for three distinct project-less .NET formats:

| Format | Extension | Compilation model | Reference resolution |
|---|---|---|---|
| C# file-based app | `.cs` | `SourceCodeKind.Regular`, real SDK build | `#:package` / `#:project` / `#:sdk` via MSBuild |
| C# script | `.csx` | `SourceCodeKind.Script` | `#r` / `#load` via Roslyn script resolvers |
| F# script | `.fsx`, `.fsscript` | FSI script compilation | `#r "nuget:"` / `#load` / `#I` via FCS |

A project-less `.cs` app and F# script MUST provide the same completion, hover, definition, rename, and diagnostic quality as project-owned code.

### Why directory globbing is wrong `[SCRIPT-ANTIPATTERN]`

Never construct a project-less workspace by globbing every `.cs` file in its directory:

- A file-based app contains one root plus its explicit `#:include` closure.
- Globbing combines sibling apps, causing false `CS0017` and duplicate-type diagnostics.
- Globbing reads generated output, `obj/`, and unrelated source outside the declared closure.
- Ignoring `#:` directives makes editor semantics diverge from `dotnet run file.cs`.

The compilation closure is derived from the file, never the directory.

## Taxonomy and detection `[SCRIPT-TAXONOMY]`

### Document kind `[SCRIPT-DETECT]`

Every opened document resolves to exactly one `DocumentKind` before any workspace is created:

| Kind | Trigger |
|---|---|
| `ProjectOwned` | An owning `.csproj`/`.fsproj` is found by [SCRIPT-CONE] |
| `CSharpFileBasedApp` | `.cs`, no owning project |
| `CSharpScript` | `.csx` |
| `FSharpScript` | `.fsx`, `.fsscript` |
| `FSharpSignature` | `.fsi`, no owning project — syntax-only per [SCRIPT-FSX-FSI] |
| `Unsupported` | Any other extension |

Classification uses extension plus cone search, never content sniffing. `Unsupported` documents MUST NOT initialize or latch a sidecar workspace; a later supported document must still initialize it.

Implementations: [main.rs](../../src/sharplsp/src/main.rs), [SolutionLoader.cs](../../src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/SolutionLoader.cs), and [WorkspaceManager.SingleFile.cs](../../src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/WorkspaceManager.SingleFile.cs).

### Project cone precedence `[SCRIPT-CONE]`

Before treating a document as project-less, SharpLsp walks from its directory toward the filesystem root. The first directory containing `*.sln`, `*.slnx`, `*.csproj`, or `*.fsproj` wins and classifies the document as `ProjectOwned`.

The walk stops at the first of:
- a directory containing a project or solution file,
- the LSP workspace root (if one was supplied by the client),
- a directory containing `.git`,
- the filesystem root.

The project wins inside a project cone, matching `dotnet run` when a project exists in the working directory.

A `.csx` or `.fsx` file is never `ProjectOwned`; MSBuild does not compile scripts by default.

### Compilation closure `[SCRIPT-CLOSURE]`

| Kind | Closure |
|---|---|
| `CSharpFileBasedApp` | root `.cs` + transitive `#:include` expansion |
| `CSharpScript` | root `.csx` + transitive `#load` expansion |
| `FSharpScript` | root `.fsx` + transitive `#load` expansion (computed by FCS) |

Closure expansion does not re-add files and reports cycles as diagnostics. It is bounded at **64 files** and **8 levels**; exceeding either bound truncates expansion and emits a warning.

## C# file-based apps `[SCRIPT-FILEBASED]`

Targets the [.NET 10 file-based app model](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps).

Implementations: [FileLevelDirectives.cs](../../src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/FileLevelDirectives.cs), [DocumentClosure.cs](../../src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/DocumentClosure.cs), and [WorkspaceManager.SingleFile.cs](../../src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/WorkspaceManager.SingleFile.cs).

### Directive parsing `[SCRIPT-FILEBASED-DIRECTIVES]`

File-level directives are parsed **off the Roslyn CST**, never with regular expressions or string matching. Roslyn 5.6+ lexes `#:` as `IgnoredDirectiveTriviaSyntax` and `#!` as `ShebangDirectiveTriviaSyntax`. The parser walks leading trivia of the compilation unit and collects these nodes.

Supported directives, matching the SDK exactly:

| Directive | Grammar | Notes |
|---|---|---|
| `#:sdk` | `#:sdk <Name>` or `#:sdk <Name>@<Version>` | Defaults to `Microsoft.NET.Sdk` |
| `#:package` | `#:package <Name>`, `<Name>@<Version>`, `<Name>@*` | Bare name requires central package management |
| `#:project` | `#:project <path>` | Path to a project file **or** a directory containing one |
| `#:property` | `#:property <Name>=<Value>` | Value may contain MSBuild expressions |
| `#:include` | `#:include <path>` | Literal path, glob, or MSBuild property |

`#:include` maps to item types by extension, per the SDK: `*.cs` → `Compile`, `*.resx` → `EmbeddedResource`, `*.json` → `None`, `*.razor` → `Content`. Only `Compile` items participate in the semantic closure; the rest are recorded so the synthesized project stays faithful.

Directives must appear before the first non-trivia token. A `#:` directive that appears after real code is reported as a diagnostic at its own location, matching compiler behavior.

### Shebang `[SCRIPT-FILEBASED-SHEBANG]`

A leading `#!` line is valid in a file-based app and must not produce a diagnostic. Because Roslyn lexes it as `ShebangDirectiveTriviaSyntax`, no text preprocessing is required — the file is passed to Roslyn verbatim. SharpLsp must never strip, rewrite, or offset the shebang line, because doing so would desynchronize LSP positions from the on-disk text.

### Reference resolution `[SCRIPT-FILEBASED-REFERENCES]`

Reference resolution has two tiers. Tier 1 is correct; tier 2 is a bounded degradation.

#### Tier 1 — synthesized project + real restore `[SCRIPT-FILEBASED-REFERENCES-MSBUILD]`

1. Synthesize an MSBuild project equivalent to the SDK's virtual project from the parsed directives. The project is constructed through `Microsoft.Build.Construction.ProjectRootElement` — an actual XML DOM — and never by string concatenation, per the repo's structured-file rule.
2. Write it to a deterministic per-app work directory keyed by a hash of the root file's full path, mirroring the SDK's `<temp>/dotnet/runfile/<appname>-<appfilesha>/` scheme. This is build state, not a semantic-result cache.
3. Run `dotnet restore` on it.
4. Load it through the **existing** `MSBuildWorkspace` path.

The resulting references, implicit usings, analyzers, framework references, and language version MUST match `dotnet build file.cs`.

Defaults applied when no directive overrides them, matching the SDK: `TargetFramework` from the resolved SDK band, `ImplicitUsings=enable`, `Nullable=enable`, `OutputKind=ConsoleApplication`, `PublishAot=true`, `PackAsTool=true`. `PublishAot`/`PackAsTool` do not affect semantics but are carried so `dotnet project convert` parity holds.

Restore runs from the app directory and MUST honor `Directory.Build.props`, `Directory.Build.targets`, `Directory.Packages.props`, `nuget.config`, and `global.json`.

#### Tier 2 — in-memory reference assemblies `[SCRIPT-FILEBASED-REFERENCES-FALLBACK]`

When the .NET SDK is unavailable, restore fails, or restore has not yet completed, the sidecar builds an `AdhocWorkspace` using `Basic.Reference.Assemblies` for the target framework band. This gives immediate BCL-level IntelliSense with zero I/O so the editor is never dead while restore runs.

Tier 2 is explicitly **incomplete**: `#:package` references are unresolved, so symbols from NuGet packages will not bind. The sidecar must publish an informational diagnostic naming the reason, and must upgrade to tier 1 automatically when restore succeeds.

Tier 2 must never be silently presented as a successful full load. `workspace/status` reports `filebased-degraded` in this state.

### Parse options `[SCRIPT-FILEBASED-PARSEOPTIONS]`

`LanguageVersion` is resolved from the target framework band, not hardcoded to `Preview`. `Preview` enables unstable features that the user's SDK may reject, producing editor-only false negatives. `LanguageVersion.Latest` is used when the band cannot be determined.

### Entry points `[SCRIPT-FILEBASED-ENTRYPOINT]`

A file-based app root file carries top-level statements. `#:include`d `.cs` files may add types, methods, and namespaces but **may not** add top-level statements — the SDK forbids it. SharpLsp reports a violation as a diagnostic on the offending included file rather than allowing a confusing `CS0017` from the compiler.

## C# scripts `[SCRIPT-CSX]`

`.csx` is Roslyn scripting, **not** a file-based app. Conflating the two is a correctness bug: `#r` and `#load` are script-only, `#:` directives are file-based-only, and the two use different `SourceCodeKind` values.

### Parse and compilation options `[SCRIPT-CSX-OPTIONS]`

- `CSharpParseOptions` with `kind: SourceCodeKind.Script`. This enables top-level statements, declarations, and a trailing expression.
- `OutputKind.DynamicallyLinkedLibrary`.
- Script default imports applied as global usings: `System`, `System.IO`, `System.Collections.Generic`, `System.Console`, `System.Diagnostics`, `System.Dynamic`, `System.Linq`, `System.Linq.Expressions`, `System.Text`, `System.Threading.Tasks`.

### Directive resolution `[SCRIPT-CSX-RESOLVERS]`

- `#load` is resolved by a `SourceReferenceResolver` rooted at the script's directory, feeding [SCRIPT-CLOSURE] expansion.
- `#r "assembly.dll"` is resolved by a `MetadataReferenceResolver` rooted at the script's directory.
- `#r "nuget: Pkg, Version"` requires NuGet resolution and is **out of scope for phase 1**. It must produce a clearly-worded unresolved-reference diagnostic, never a silent wrong answer.

## F# scripts `[SCRIPT-FSX]`

F# scripts use FCS directive resolution; SharpLsp MUST NOT reimplement it.

Implementation: [FSharpWorkspace.fs](../../src/sidecars/SharpLsp.Sidecar.FSharp/FSharpWorkspace.fs).

### Project options `[SCRIPT-FSX-OPTIONS]`

`FSharpChecker.GetProjectOptionsFromScript` is the single entry point. It resolves `#r`, `#r "nuget:"`, `#I`, and `#load` closures, selects the framework references, and returns `FSharpProjectOptions` directly consumable by the existing `parseAndCheckOnce` pipeline.

Invocation parameters:
- `assumeDotNetFramework = false`
- `useSdkRefs = true`
- `useFsiAuxLib = true` — makes the `fsi` object bind, so `fsi.CommandLineArgs` resolves.
- `previewEnabled` follows the resolved language version.

### Preprocessor symbols `[SCRIPT-FSX-SYMBOLS]`

Scripts opened in the editor define both `INTERACTIVE` and `EDITING`. `COMPILED` is **not** defined. Getting this wrong makes `#if INTERACTIVE` blocks appear greyed-out-dead in the editor while being live at runtime.

### NuGet references `[SCRIPT-FSX-NUGET]`

`#r "nuget: ..."` resolution is performed by FCS's dependency manager and requires network or local package-store access. It is slow on first use (seconds). Resolution runs off the request path; the script is first checked without the package references so the editor is responsive, then re-checked once resolution completes and diagnostics are republished.

### Signature files `[SCRIPT-FSX-FSI]`

A `.fsi` signature file with no owning project has no meaningful semantic closure. It is served syntax-only (document symbols, folding, selection range) by the Rust host, and no F# sidecar workspace is opened for it.

## Host routing `[SCRIPT-ROUTE]`

### Lazy workspace initialization `[SCRIPT-ROUTE-LAZY]`

When the LSP client supplies no workspace root, the host defers `workspace/open` until the first `textDocument/didOpen` that resolves to a supported `DocumentKind`.

Requirements:
- The "initialized" latch is set **only** when a workspace was actually opened. A `didOpen` for an `Unsupported` document must leave the latch clear so a later `.cs`/`.fs` open still initializes.
- Only the sidecar matching the document's language is started. Opening a `.cs` file must not spawn the F# sidecar and vice versa.
- The second language's sidecar is started on demand when a document of that language is first opened, so a mixed-language folder works without a restart.
- Lazy initialization performs the same steps as eager initialization — workspace open, analyzer configuration, diagnostics wiring, then health monitoring. It must share one implementation with the eager path rather than duplicating a subset of it.

### Workspace target `[SCRIPT-ROUTE-TARGET]`

The host sends the **file path**, not the parent directory, for script and file-based documents. The parent directory is meaningful only for `ProjectOwned` documents. Sending a directory is what forces the sidecar into directory-globbing and is prohibited.

### Health monitor ordering `[SCRIPT-ROUTE-HEALTH]`

Per [SIDECAR-HEALTH-ACTIVITY](SIDECAR-LIFECYCLE-SPEC.md), the per-language supervisor sends no ping until `workspace/open` and generation bootstrap complete. Eager and lazy callers MUST NOT start another health task; workspace open uses its 600-second response budget without a competing transport-locking ping.

## Lifecycle `[SCRIPT-LIFECYCLE]`

### Directive edits `[SCRIPT-RELOAD]`

Editing a `#:package`, `#:project`, `#:sdk`, or `#:include` directive changes the compilation closure and reference set. On `didChange`, the sidecar re-parses directives from the in-memory text and, if the directive set changed, schedules a workspace reload debounced by `sharplsp.toml`'s `server.debounce_ms`. Text-only edits never trigger reload.

### Closure membership changes `[SCRIPT-RELOAD-CLOSURE]`

A file entering or leaving the `#:include` / `#:load` closure adds or removes a Roslyn document. Removal must also clear published diagnostics for that file, otherwise stale squiggles persist in files no longer part of the app.

### Multiple roots `[SCRIPT-MULTIROOT]`

Two file-based apps in one directory are two independent compilations. The sidecar keeps a map of root path → workspace and never merges them. Opening `foo.cs` and `bar.cs` from the same folder yields two closures, not one project containing both.

## Error handling and degradation `[SCRIPT-DEGRADE]`

- A file with no supported document kind returns a `Result` failure, never an empty synthetic workspace.
- A directory with no solution or project is valid: `OpenCoreAsync` records a project-less root and returns success, deferring workspace creation to the first document update. Each loose file becomes an independent ad-hoc project per [SCRIPT-ANTIPATTERN]. `IsLoaded` remains false until a document arrives.
- Multiple candidate solutions are ambiguity, not project absence. `SolutionLoader.FindAmbiguousSolutions` MUST return an error naming every candidate and the `csharp.solution_path` resolution setting from [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH], never enter project-less mode.
- Any I/O during closure expansion is wrapped; a failure to read one included file degrades that file only and is reported as a diagnostic, leaving the rest of the closure loaded.

## Performance `[SCRIPT-PERF]`

| Operation | Target |
|---|---|
| Classification + cone search | <5ms |
| Tier 2 workspace ready (first IntelliSense) | <300ms |
| Tier 1 workspace ready (restore assets current) | <1.5s |
| Tier 1 workspace ready (cold restore) | <10s, non-blocking |
| Directive re-parse on keystroke | <1ms |

Cone search is bounded by [SCRIPT-CONE] and must not stat the whole tree.

## Security `[SCRIPT-SECURITY]`

- Opening a file must never cause SharpLsp to read files outside the declared closure. Directory-wide reads are prohibited by [SCRIPT-ANTIPATTERN].
- `#:include` and `#load` paths that escape the root file's directory are permitted (the SDK permits `../`) but are logged at debug level.
- Tier 1 `dotnet restore` may execute package build logic, so it runs only for opened documents, never speculatively across a directory.
- No script is ever executed to obtain type information. All analysis is compile-time.

## Testing `[SCRIPT-TESTS]`

Tests drive real sidecars over IPC with real files: [WorkspaceManagerSingleFileTests.cs](../../src/sidecars/SharpLsp.Sidecar.CSharp.Tests/WorkspaceManagerSingleFileTests.cs) and [FSharpScriptTests.fs](../../src/sidecars/SharpLsp.Sidecar.FSharp.Tests/FSharpScriptTests.fs).

Required coverage:
- `.cs` file-based app: BCL completion resolves; hover on `Console.WriteLine` binds.
- `.cs` file-based app with `#:package`: the package's symbols bind after restore (tier 1).
- `.cs` file-based app with `#:include`: symbols from the included file resolve from the root.
- Two file-based apps in one directory produce **no** duplicate-entry-point diagnostic.
- Shebang line produces no diagnostic and does not shift reported positions.
- `.csx`: top-level statement and `#load` closure resolve.
- `.fsx`: `let` binding hover and `#load` closure resolve.
- `.fsx` with `#r "nuget:"`: resolves after dependency resolution completes.
- Opening a `.md` first, then a `.cs`, still initializes the C# workspace (latch regression test).
- Opening a `.cs` does not spawn the F# sidecar (and vice versa).
- A directory with an ambiguous multi-solution layout returns an error, not a synthetic workspace.
