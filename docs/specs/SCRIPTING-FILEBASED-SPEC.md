# Scripting and File-Based Apps Specification

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md)

## 1. Overview

SharpLsp must provide full semantic language support for .NET source files that are **not owned by a
project file**. There are three distinct such formats, and they are not interchangeable:

| Format | Extension | Compilation model | Reference resolution |
|---|---|---|---|
| C# file-based app | `.cs` | `SourceCodeKind.Regular`, real SDK build | `#:package` / `#:project` / `#:sdk` via MSBuild |
| C# script | `.csx` | `SourceCodeKind.Script` | `#r` / `#load` via Roslyn script resolvers |
| F# script | `.fsx`, `.fsscript` | FSI script compilation | `#r "nuget:"` / `#load` / `#I` via FCS |

These are **first-class editing scenarios**, not a degraded fallback. A `.cs` file-based app opened
without a solution must get the same completion, hover, definition, rename, and diagnostic quality as
a file inside a `.csproj`. F# scripts are held to the same bar as C# per the project's F#-first
mandate.

### 1.1 Why the naive approach is wrong `[SCRIPT-ANTIPATTERN]`

The first implementation of this feature (PR #188) resolved a project-less file by globbing **every
`.cs` file in the containing directory** into one synthetic Roslyn project. This is incorrect and
must never be reintroduced. Concretely:

- A .NET file-based app's compilation closure is **one root file** plus its explicit `#:include`
  closure. The .NET SDK documentation is unambiguous: *"By default, the single C# file is included."*
- Globbing a directory compiles unrelated programs together. Two sibling file-based apps each with
  top-level statements produce `CS0017` (multiple entry points) and duplicate-type errors that do not
  exist in a real build.
- It silently reads every `.cs` file in whatever directory the user happened to open a file from,
  including generated output, `obj/`, and unrelated source.
- It ignores every `#:` directive, so `#:package`, `#:sdk`, and `#:property` have no effect —
  the editor's view of the code diverges from what `dotnet run file.cs` actually compiles.

The rule this spec enforces: **the compilation closure is derived from the file, never from the
directory.**

---

## 2. Taxonomy and detection

### 2.1 Document kind `[SCRIPT-DETECT]`

Every opened document resolves to exactly one `DocumentKind` before any workspace is created:

| Kind | Trigger |
|---|---|
| `ProjectOwned` | An owning `.csproj`/`.fsproj` is found by cone search (§2.2) |
| `CSharpFileBasedApp` | `.cs`, no owning project |
| `CSharpScript` | `.csx` |
| `FSharpScript` | `.fsx`, `.fsscript` |
| `FSharpSignature` | `.fsi`, no owning project — syntax-only, see §5.4 |
| `Unsupported` | Any other extension |

Classification is by extension **plus** cone search. It is never by content sniffing.

`Unsupported` documents must not trigger sidecar workspace initialization. This is a hard requirement:
the host latches "workspace initialized" on the first document that successfully initializes a
workspace, and latching on a `.md` or `.json` file permanently prevents the real workspace from ever
opening.

### 2.2 Project cone precedence `[SCRIPT-CONE]`

Before a document is treated as file-based or script, SharpLsp walks from the document's directory
toward the filesystem root looking for an owning project. The first directory containing any of
`*.sln`, `*.slnx`, `*.csproj`, `*.fsproj` wins, and the document is classified `ProjectOwned`.

The walk stops at the first of:
- a directory containing a project or solution file,
- the LSP workspace root (if one was supplied by the client),
- a directory containing `.git`,
- the filesystem root.

Rationale: the .NET SDK documentation explicitly warns against placing file-based apps inside a
project cone because implicit build files interfere. When a user does it anyway, the project wins —
that matches what `dotnet run` does when a project file is present in the working directory.

A `.csx`/`.fsx` file is **never** `ProjectOwned`. Scripts are self-describing even inside a project
cone, because MSBuild does not compile `.csx`/`.fsx` by default.

### 2.3 Compilation closure `[SCRIPT-CLOSURE]`

| Kind | Closure |
|---|---|
| `CSharpFileBasedApp` | root `.cs` + transitive `#:include` expansion |
| `CSharpScript` | root `.csx` + transitive `#load` expansion |
| `FSharpScript` | root `.fsx` + transitive `#load` expansion (computed by FCS) |

Closure expansion is cycle-safe: a file already in the closure is not re-added, and a cycle is
reported as a diagnostic rather than causing unbounded recursion. Closure expansion is bounded at
**64 files** and **8 levels** of nesting; exceeding either bound produces a warning diagnostic and
truncates, so a pathological `#:include **/*.cs` cannot hang the sidecar.

---

## 3. C# file-based apps `[FILEBASED]`

Targets the .NET 10 SDK file-based app feature
([docs](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps)).

### 3.1 Directive parsing `[FILEBASED-DIRECTIVES]`

File-level directives are parsed **off the Roslyn CST**, never with regular expressions or string
matching. Roslyn 5.6+ lexes `#:` as `IgnoredDirectiveTriviaSyntax` and `#!` as
`ShebangDirectiveTriviaSyntax`. The parser walks leading trivia of the compilation unit and collects
these nodes.

Supported directives, matching the SDK exactly:

| Directive | Grammar | Notes |
|---|---|---|
| `#:sdk` | `#:sdk <Name>` or `#:sdk <Name>@<Version>` | Defaults to `Microsoft.NET.Sdk` |
| `#:package` | `#:package <Name>`, `<Name>@<Version>`, `<Name>@*` | Bare name requires central package management |
| `#:project` | `#:project <path>` | Path to a project file **or** a directory containing one |
| `#:property` | `#:property <Name>=<Value>` | Value may contain MSBuild expressions |
| `#:include` | `#:include <path>` | Literal path, glob, or MSBuild property |

`#:include` maps to item types by extension, per the SDK: `*.cs` → `Compile`, `*.resx` →
`EmbeddedResource`, `*.json` → `None`, `*.razor` → `Content`. Only `Compile` items participate in the
semantic closure; the rest are recorded so the synthesized project stays faithful.

Directives must appear before the first non-trivia token. A `#:` directive that appears after real
code is reported as a diagnostic at its own location, matching compiler behavior.

### 3.2 Shebang `[FILEBASED-SHEBANG]`

A leading `#!` line is valid in a file-based app and must not produce a diagnostic. Because Roslyn
lexes it as `ShebangDirectiveTriviaSyntax`, no text preprocessing is required — the file is passed to
Roslyn verbatim. SharpLsp must never strip, rewrite, or offset the shebang line, because doing so
would desynchronize LSP positions from the on-disk text.

### 3.3 Reference resolution `[FILEBASED-REFERENCES]`

Reference resolution has two tiers. Tier 1 is correct; tier 2 is a bounded degradation.

#### Tier 1 — synthesized project + real restore `[FILEBASED-REFERENCES-MSBUILD]`

1. Synthesize an MSBuild project equivalent to the SDK's virtual project from the parsed directives.
   The project is constructed through `Microsoft.Build.Construction.ProjectRootElement` — an actual
   XML DOM — and never by string concatenation, per the repo's structured-file rule.
2. Write it to a per-app cache directory keyed by a hash of the root file's full path, mirroring the
   SDK's own `<temp>/dotnet/runfile/<appname>-<appfilesha>/` scheme.
3. Run `dotnet restore` on it.
4. Load it through the **existing** `MSBuildWorkspace` path.

This yields exactly the references, implicit usings, analyzers, framework references, and language
version that `dotnet build file.cs` yields, and it reuses the workspace pipeline already in
production rather than duplicating it.

Defaults applied when no directive overrides them, matching the SDK: `TargetFramework` from the
resolved SDK band, `ImplicitUsings=enable`, `Nullable=enable`, `OutputKind=ConsoleApplication`,
`PublishAot=true`, `PackAsTool=true`. `PublishAot`/`PackAsTool` do not affect semantics but are
carried so `dotnet project convert` parity holds.

Implicit build files — `Directory.Build.props`, `Directory.Build.targets`,
`Directory.Packages.props`, `nuget.config`, `global.json` — are honored because a real restore is
performed from the app's own directory. This is a correctness advantage over any hand-rolled
reference list and is the primary reason tier 1 is the default.

#### Tier 2 — in-memory reference assemblies `[FILEBASED-REFERENCES-FALLBACK]`

When the .NET SDK is unavailable, restore fails, or restore has not yet completed, the sidecar builds
an `AdhocWorkspace` using `Basic.Reference.Assemblies` for the target framework band. This gives
immediate BCL-level IntelliSense with zero I/O so the editor is never dead while restore runs.

Tier 2 is explicitly **incomplete**: `#:package` references are unresolved, so symbols from NuGet
packages will not bind. The sidecar must publish an informational diagnostic naming the reason, and
must upgrade to tier 1 automatically when restore succeeds.

Tier 2 must never be silently presented as a successful full load. `workspace/status` reports
`filebased-degraded` in this state.

### 3.4 Parse options `[FILEBASED-PARSEOPTIONS]`

`LanguageVersion` is resolved from the target framework band, not hardcoded to `Preview`. `Preview`
enables unstable features that the user's SDK may reject, producing editor-only false negatives.
`LanguageVersion.Latest` is used when the band cannot be determined.

### 3.5 Entry points `[FILEBASED-ENTRYPOINT]`

A file-based app root file carries top-level statements. `#:include`d `.cs` files may add types,
methods, and namespaces but **may not** add top-level statements — the SDK forbids it. SharpLsp
reports a violation as a diagnostic on the offending included file rather than allowing a confusing
`CS0017` from the compiler.

---

## 4. C# scripts `[CSX]`

`.csx` is Roslyn scripting, **not** a file-based app. Conflating the two is a correctness bug: `#r`
and `#load` are script-only, `#:` directives are file-based-only, and the two use different
`SourceCodeKind` values.

### 4.1 Parse and compilation options `[CSX-OPTIONS]`

- `CSharpParseOptions` with `kind: SourceCodeKind.Script`. This enables top-level statements,
  declarations, and a trailing expression.
- `OutputKind.DynamicallyLinkedLibrary`.
- Script default imports applied as global usings: `System`, `System.IO`, `System.Collections.Generic`,
  `System.Console`, `System.Diagnostics`, `System.Dynamic`, `System.Linq`,
  `System.Linq.Expressions`, `System.Text`, `System.Threading.Tasks`.

### 4.2 Directive resolution `[CSX-RESOLVERS]`

- `#load` is resolved by a `SourceReferenceResolver` rooted at the script's directory, feeding
  §2.3 closure expansion.
- `#r "assembly.dll"` is resolved by a `MetadataReferenceResolver` rooted at the script's directory.
- `#r "nuget: Pkg, Version"` requires NuGet resolution and is **out of scope for phase 1**. It must
  produce a clearly-worded unresolved-reference diagnostic, never a silent wrong answer.

---

## 5. F# scripts `[FSX]`

F# scripts are handled by FCS natively and require no directive parsing of our own — a significant
advantage over the C# path that must be preserved rather than reimplemented.

### 5.1 Project options `[FSX-OPTIONS]`

`FSharpChecker.GetProjectOptionsFromScript` is the single entry point. It resolves `#r`, `#r "nuget:"`,
`#I`, and `#load` closures, selects the framework references, and returns `FSharpProjectOptions`
directly consumable by the existing `parseAndCheckOnce` pipeline.

Invocation parameters:
- `assumeDotNetFramework = false`
- `useSdkRefs = true`
- `useFsiAuxLib = true` — makes the `fsi` object bind, so `fsi.CommandLineArgs` resolves.
- `previewEnabled` follows the resolved language version.

### 5.2 Preprocessor symbols `[FSX-SYMBOLS]`

Scripts opened in the editor define both `INTERACTIVE` and `EDITING`. `COMPILED` is **not** defined.
Getting this wrong makes `#if INTERACTIVE` blocks appear greyed-out-dead in the editor while being
live at runtime.

### 5.3 NuGet references `[FSX-NUGET]`

`#r "nuget: ..."` resolution is performed by FCS's dependency manager and requires network and cache
access. It is slow on first use (seconds). Resolution runs off the request path; the script is first
checked without the package references so the editor is responsive, then re-checked once resolution
completes and diagnostics are republished.

### 5.4 Signature files `[FSX-FSI]`

A `.fsi` signature file with no owning project has no meaningful semantic closure. It is served
syntax-only (document symbols, folding, selection range) by the Rust host, and no F# sidecar
workspace is opened for it.

---

## 6. Host routing `[SCRIPT-ROUTE]`

### 6.1 Lazy workspace initialization `[SCRIPT-ROUTE-LAZY]`

When the LSP client supplies no workspace root, the host defers `workspace/open` until the first
`textDocument/didOpen` that resolves to a supported `DocumentKind`.

Requirements:
- The "initialized" latch is set **only** when a workspace was actually opened. A `didOpen` for an
  `Unsupported` document must leave the latch clear so a later `.cs`/`.fs` open still initializes.
- Only the sidecar matching the document's language is started. Opening a `.cs` file must not spawn
  the F# sidecar and vice versa.
- The second language's sidecar is started on demand when a document of that language is first
  opened, so a mixed-language folder works without a restart.
- Lazy initialization performs the same steps as eager initialization — workspace open, analyzer
  configuration, diagnostics wiring, then health monitoring. It must share one implementation with
  the eager path rather than duplicating a subset of it.

### 6.2 Workspace target `[SCRIPT-ROUTE-TARGET]`

The host sends the **file path**, not the parent directory, for script and file-based documents. The
parent directory is meaningful only for `ProjectOwned` documents. Sending a directory is what forces
the sidecar into directory-globbing and is prohibited.

### 6.3 Health monitor ordering `[SCRIPT-ROUTE-HEALTH]`

Health monitoring starts only after `workspace/open` completes, matching the existing eager path — a
health check that races workspace load can time out on the transport lock and kill a healthy sidecar.

---

## 7. Lifecycle

### 7.1 Directive edits `[SCRIPT-RELOAD]`

Editing a `#:package`, `#:project`, `#:sdk`, or `#:include` directive changes the compilation closure
and reference set. On `didChange`, the sidecar re-parses directives from the in-memory text and, if
the directive set changed, schedules a workspace reload debounced by
`sharplsp.toml`'s `server.debounce_ms`. Text-only edits never trigger reload.

### 7.2 Closure membership changes `[SCRIPT-RELOAD-CLOSURE]`

A file entering or leaving the `#:include` / `#:load` closure adds or removes a Roslyn document.
Removal must also clear published diagnostics for that file, otherwise stale squiggles persist in
files no longer part of the app.

### 7.3 Multiple roots `[SCRIPT-MULTIROOT]`

Two file-based apps in one directory are two independent compilations. The sidecar keeps a map of
root path → workspace and never merges them. Opening `foo.cs` and `bar.cs` from the same folder
yields two closures, not one project containing both.

---

## 8. Error handling and degradation `[SCRIPT-DEGRADE]`

- A **file** path that resolves to no supported document kind returns a `Result` failure. It must not
  be silently converted into an empty synthetic workspace — that turns a real "I could not load your
  code" into a wall of phantom diagnostics.
- A **directory** holding no solution or project at all is not a failure. The host opens a workspace
  folder eagerly, before any document exists, so `OpenCoreAsync` records the root as project-less and
  returns success, deferring workspace creation to the first document update. That document is then
  loaded as a file-based app or script, and each subsequent loose file is added as its own ad-hoc
  project — two independent files in one folder stay two compilations, per [SCRIPT-ANTIPATTERN].
  `IsLoaded` stays false until a document arrives, so nothing claims a workspace exists before one
  does.
- Ambiguous solution discovery (multiple `.sln` under the root) also returns "no target" from
  `SolutionLoader`. That case is **ambiguity, not absence**, and must surface as an error naming every
  candidate and the `csharp.solution_path` setting that resolves it — never the project-less deferral
  above. Treating it as file-based mode would silently mis-analyze an entire repository: no project
  reference resolves, and every cross-project type becomes a phantom "not found" diagnostic.
  `SolutionLoader.FindAmbiguousSolutions` is what distinguishes the two, and
  [WORKSPACE-SOLUTION-PATH] specifies the setting the message points at.
- Any I/O during closure expansion is wrapped; a failure to read one included file degrades that file
  only and is reported as a diagnostic, leaving the rest of the closure loaded.

---

## 9. Performance `[SCRIPT-PERF]`

| Operation | Target |
|---|---|
| Classification + cone search | <5ms |
| Tier 2 workspace ready (first IntelliSense) | <300ms |
| Tier 1 workspace ready (restore cached) | <1.5s |
| Tier 1 workspace ready (cold restore) | <10s, non-blocking |
| Directive re-parse on keystroke | <1ms |

Cone search is bounded by the stop conditions in §2.2 and must not stat the whole tree.

---

## 10. Security `[SCRIPT-SECURITY]`

- Opening a file must never cause SharpLsp to read files outside the declared closure. Directory-wide
  reads are prohibited (§1.1).
- `#:include` and `#load` paths that escape the root file's directory are permitted (the SDK permits
  `../`) but are logged at debug level.
- Tier 1 runs `dotnet restore`, which executes NuGet resolution and may execute package build logic.
  This is the same trust boundary as opening any project and is acceptable, but restore must run only
  for documents the user actually opened, never speculatively across a directory.
- No script is ever executed to obtain type information. All analysis is compile-time.

---

## 11. Testing `[SCRIPT-TESTS]`

Coarse end-to-end tests only, per repo policy. Every test drives the real sidecar over real IPC with
real files on disk.

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
