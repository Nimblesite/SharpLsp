# Scripting and File-Based Apps Implementation Plan

**Spec:** [SCRIPTING-FILEBASED-SPEC.md](../specs/SCRIPTING-FILEBASED-SPEC.md)

## Context

SharpLsp must fully support .NET source files with no owning project: C# file-based apps (`.cs` with
`#:` directives, .NET 10 SDK), C# scripts (`.csx`, Roslyn scripting), and F# scripts (`.fsx`,
FSI/FCS). Per the project's F#-first mandate, `.fsx` is not a follow-up — it ships alongside C#.

**Starting point.** PR #188 ([Nimblesite/SharpLsp#188](https://github.com/Nimblesite/SharpLsp/pull/188),
by [@ashar-builds](https://github.com/ashar-builds)) landed the first cut of this feature. It
contributed three genuinely correct ideas that this plan keeps:

1. `OpenCoreAsync` should probe for a solution/project **first** and fall through, rather than
   throwing `FileNotFoundException` when none is found.
2. A project-less file needs an in-memory Roslyn workspace with real BCL metadata references;
   `Basic.Reference.Assemblies` is the right way to get them into a self-contained sidecar.
3. The Rust host should start only the sidecar matching the opened file's language, instead of
   eagerly starting both and crashing the F# sidecar when no `.fsproj` exists.

It also shipped a compilation model that must be replaced: the closure was every `.cs` file in the
containing directory, and no `#:` directive was parsed. See [SCRIPT-ANTIPATTERN] for why that is
wrong. This plan replaces the closure model and keeps the three ideas above.

**Key enabling fact.** Roslyn 5.6.0 — already referenced by the C# sidecar — lexes `#:` as
`IgnoredDirectiveTriviaSyntax` and `#!` as `ShebangDirectiveTriviaSyntax`. Directives are therefore
parsed off the real CST, satisfying the repo's "actual parsers, never regex" rule with no new
dependency.

## Phasing

- **Phase 1 (this work)** — correct closure model, directive parsing, `.csx` and `.fsx` support,
  correct host routing, tier 2 references. Editor is correct and never invents diagnostics.
- **Phase 2** — tier 1 references (synthesized project + real `dotnet restore`), which is what makes
  `#:package` and `#:sdk Microsoft.NET.Sdk.Web` actually bind.
- **Phase 3** — `#r "nuget:"` for `.csx`, `dotnet project convert` code action, launch-profile
  awareness.

---

## TODO

Phase 1 is complete and shipped. Unchecked items below are phase 2/3 scope, tracked here so the
remaining gaps are explicit rather than implied.

### Rust Host — routing and classification

- [x] **Fix latch bug**: `init_workspace_for_file` returned `true` for *any* file with a parent
      directory, so opening a `.md`/`.json` first permanently blocked workspace init. It now returns
      `true` only when a sidecar workspace was actually opened — implements [SCRIPT-ROUTE-LAZY]
- [x] Send the **file path**, not the parent directory, for script and file-based documents —
      implements [SCRIPT-ROUTE-TARGET]
- [x] Route to the sidecar matching the document's language (`sidecar_for_path`); `.fsi` is
      deliberately excluded — implements [SCRIPT-DETECT], [SCRIPT-FSX-FSI]
- [x] Keep health-monitor start strictly after `workspace/open` completes — [SCRIPT-ROUTE-HEALTH]
- [x] Remove trailing whitespace introduced in `src/sharplsp/src/main.rs` (failed `cargo fmt --check`)
- [x] Flatten the 4-level `if let` nest in `init_workspace_for_file` into
      `opened_document_path` + `sidecar_for_path` (functions <20 LOC)
- [ ] Extract classification into `src/sharplsp/src/document_kind.rs` with the full
      `ProjectOwned` / `CSharpFileBasedApp` / `CSharpScript` / `FSharpScript` / `FSharpSignature`
      lattice; currently an extension match inside `main.rs` — [SCRIPT-DETECT]
- [ ] Implement cone search with the four stop conditions (project file, workspace root, `.git`,
      filesystem root) — [SCRIPT-CONE]
- [ ] Start the second language's sidecar on demand when a document of that language is first opened
      (still a one-shot latch, so a mixed-language folder needs a restart) — [SCRIPT-ROUTE-LAZY]
- [ ] Deduplicate the lazy path against `start_sidecar`: the lazy path still skips analyzer
      configuration and diagnostics wiring that the eager path performs — [SCRIPT-ROUTE-LAZY]

### C# Sidecar — file-based apps

- [x] Add `FileLevelDirectives.cs`: parse `IgnoredDirectiveTriviaSyntax` /
      `ShebangDirectiveTriviaSyntax` off the CST into a typed directive model — no regex anywhere —
      implements [SCRIPT-FILEBASED-DIRECTIVES]
- [x] Support `#:sdk`, `#:package` (`Name`, `Name@Version`, `Name@*`), `#:project`, `#:property`,
      `#:include` — implements [SCRIPT-FILEBASED-DIRECTIVES]
- [x] **Replace `ResolveCsFiles` directory glob** with root-file + transitive `#:include` closure,
      cycle-safe, bounded to 64 files / 8 levels — implements [SCRIPT-CLOSURE],
      kills [SCRIPT-ANTIPATTERN]
- [x] Pass the file verbatim to Roslyn; never strip or rewrite the shebang. Requires the
      `FileBasedProgram` parse feature or Roslyn reports CS9314 — [SCRIPT-FILEBASED-SHEBANG]
- [x] Emit the SDK's implicit global usings as a synthetic document —
      `CSharpCompilationOptions.Usings` is honoured only for `SourceCodeKind.Script`, so a file-based
      app needs the generated-file route the SDK itself uses — [SCRIPT-FILEBASED-PARSEOPTIONS]
- [x] Dispose the previous `AdhocWorkspace` when reopening (was leaked on repeat `OpenAsync`)
- [ ] Map `#:include` item types by extension (`.cs`→Compile, `.resx`→EmbeddedResource, `.json`→None,
      `.razor`→Content); only `Compile` joins the semantic closure. Currently every resolved include
      is treated as Compile — [SCRIPT-FILEBASED-DIRECTIVES]
- [ ] Diagnose a `#:` directive appearing after the first non-trivia token. Detection and the
      diagnostics-pipeline wiring land together — a detector with no consumer is dead code, so
      neither half ships alone — [SCRIPT-FILEBASED-DIRECTIVES]
- [ ] Resolve `LanguageVersion` from the target framework band instead of `Latest` —
      [SCRIPT-FILEBASED-PARSEOPTIONS]
- [ ] Diagnostic when an `#:include`d file declares top-level statements — [SCRIPT-FILEBASED-ENTRYPOINT]
- [ ] Keep a root-path → workspace map so two apps in one directory stay independent *concurrently*;
      today each `OpenAsync` replaces the workspace, which is correct per-open but not concurrent —
      [SCRIPT-MULTIROOT]
- [ ] Report `filebased-degraded` from `workspace/status` while on tier 2 — [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
- [ ] Publish an informational diagnostic naming why `#:package` symbols are unresolved on tier 2 —
      [SCRIPT-FILEBASED-REFERENCES-FALLBACK]

### C# Sidecar — scripts

- [x] `.csx` parsed with `SourceCodeKind.Script`, `OutputKind.DynamicallyLinkedLibrary`.
      `SourceCodeKind` is per-**document**, not inherited from project parse options — implements
      [SCRIPT-CSX-OPTIONS]
- [x] Apply the ten script default imports via `CSharpCompilationOptions.Usings` — [SCRIPT-CSX-OPTIONS]
- [x] `SourceReferenceResolver` for `#load`, rooted at the script directory. The closure stays
      root-only so Roslyn owns `#load` resolution rather than double-adding loaded files —
      [SCRIPT-CSX-RESOLVERS]
- [ ] `MetadataReferenceResolver` for `#r "assembly.dll"`, rooted at the script directory — [SCRIPT-CSX-RESOLVERS]
- [ ] Clear unresolved-reference diagnostic for `#r "nuget:"` (phase 3) — [SCRIPT-CSX-RESOLVERS]

### C# Sidecar — regression guards on the existing MSBuild path

- [x] **`SolutionLoader` returned any existing file as a project target**, so `Program.cs` was handed
      to `MSBuildWorkspace.OpenProjectAsync` and file-based mode was unreachable. Explicit file targets
      are now gated on `.sln`/`.slnx`/`.csproj` — implements [SCRIPT-DETECT]
- [x] Ambiguous multi-solution discovery returns an **error** rather than a synthetic workspace, and
      keeps doing so now that a project-less directory defers instead of failing:
      `SolutionLoader.FindAmbiguousSolutions` separates ambiguity from absence, so only the genuinely
      empty root takes the deferred path — [SCRIPT-DEGRADE]
- [x] Confirmed `AddCrossLanguageMetadataReferences` still runs on the MSBuild path after the
      `OpenCoreAsync` reordering
- [x] Wrap per-file I/O in closure expansion so one unreadable file degrades that file only —
      [SCRIPT-DEGRADE]
- [x] Honor `CancellationToken` inside the closure read loop
- [x] Distinguish "absent" from "ambiguous" in the error *message*: absent now defers to lazy
      per-file loading, and ambiguous reports every candidate solution plus the
      `csharp.solution_path` setting that resolves it — [SCRIPT-DEGRADE]

### F# Sidecar — scripts

- [x] Route `.fsx`/`.fsscript` through `FSharpChecker.GetProjectOptionsFromScript` — implements
      [SCRIPT-FSX-OPTIONS]
- [x] Pass `assumeDotNetFramework=false`, `useSdkRefs=true`, `useFsiAuxLib=true` so the `fsi` object
      binds — [SCRIPT-FSX-OPTIONS]
- [x] Define `INTERACTIVE` and `EDITING`, not `COMPILED`, for scripts — implements [SCRIPT-FSX-SYMBOLS]
- [x] `loadProject` hard-failed with `"No .fsproj found"`; it now dispatches on document kind before
      reaching that point — [SCRIPT-DETECT]
- [x] Honour the overlay buffer so an unsaved script checks against editor text, not disk
- [x] `.fsi` with no owning project is syntax-only; no F# workspace is opened — implements [SCRIPT-FSX-FSI]
- [ ] Run `#r "nuget:"` resolution off the request path; check without packages first, re-check and
      republish diagnostics when resolution completes — [SCRIPT-FSX-NUGET]

### Lifecycle

- [ ] Re-parse directives on `didChange`; reload only when the directive set changed, debounced by
      `server.debounce_ms` — implements [SCRIPT-RELOAD]
- [ ] Clear published diagnostics for files leaving the closure — implements [SCRIPT-RELOAD-CLOSURE]

### Phase 2 — tier 1 references

- [ ] Synthesize the virtual project via `Microsoft.Build.Construction.ProjectRootElement` (XML DOM,
      never string concatenation) — implements [SCRIPT-FILEBASED-REFERENCES-MSBUILD]
- [ ] Cache directory keyed by hash of the root file's full path, mirroring the SDK's
      `<temp>/dotnet/runfile/<appname>-<appfilesha>/` scheme — [SCRIPT-FILEBASED-REFERENCES-MSBUILD]
- [ ] Run `dotnet restore`, then load through the existing `MSBuildWorkspace` path —
      [SCRIPT-FILEBASED-REFERENCES-MSBUILD]
- [ ] Apply SDK defaults (`ImplicitUsings`, `Nullable`, `TargetFramework`, `PublishAot`, `PackAsTool`)
      — [SCRIPT-FILEBASED-REFERENCES-MSBUILD]
- [ ] Automatic tier 2 → tier 1 upgrade when restore completes — [SCRIPT-FILEBASED-REFERENCES-FALLBACK]

### Testing

Coarse, real-artifact tests only — real files on disk, real Roslyn, real FCS, no mocks.

`src/sidecars/SharpLsp.Sidecar.CSharp.Tests/WorkspaceManagerSingleFileTests.cs`:

- [x] `.cs` file-based app: BCL symbols bind with **zero** error diagnostics — [SCRIPT-TESTS]
- [x] `.cs` file-based app with `#:include`: symbols from the included file resolve — [SCRIPT-TESTS]
- [x] Two file-based apps in one directory produce **no** duplicate-entry-point diagnostic —
      regression test for [SCRIPT-ANTIPATTERN]
- [x] Shebang produces no diagnostic — [SCRIPT-FILEBASED-SHEBANG]
- [x] `.csx`: script semantics load and the script `#load` path resolves — [SCRIPT-CSX-OPTIONS]
- [x] Closure cycle (`a.cs` includes `b.cs` includes `a.cs`) terminates — [SCRIPT-CLOSURE]
- [x] A directory with neither project nor root file defers to lazy per-file loading rather than
      building a synthetic workspace, and each loose file becomes its own ad-hoc project —
      [SCRIPT-DEGRADE]
- [x] A directory holding several solutions is an **error** naming the candidates and
      `csharp.solution_path`, never the deferred path — [SCRIPT-DEGRADE]
- [x] `Classify` maps extensions to compilation models — [SCRIPT-DETECT]

`src/sidecars/SharpLsp.Sidecar.FSharp.Tests/FSharpScriptTests.fs`:

- [x] Standalone `.fsx` loads without an `.fsproj` — [SCRIPT-FSX-OPTIONS]
- [x] `#load` closure includes the loaded script — [SCRIPT-CLOSURE]
- [x] `.fsx` defines `INTERACTIVE` and `EDITING` but not `COMPILED` — [SCRIPT-FSX-SYMBOLS]

Still to write:

- [ ] Host-level `src/sharplsp/tests/lsp_e2e.rs`: opening a `.md` first, then a `.cs`, still initializes the C#
      workspace — latch regression test for [SCRIPT-ROUTE-LAZY]
- [ ] Host-level: opening a `.cs` does not spawn the F# sidecar, and vice versa — [SCRIPT-ROUTE-LAZY]
- [ ] `.cs` file-based app with `#:package`: package symbols bind after restore (phase 2) — [SCRIPT-TESTS]
- [ ] `.fsx` with `#r "nuget:"` resolves after dependency resolution — [SCRIPT-FSX-NUGET]

### Test debt inherited from PR #188

- [x] `WorkspaceManagerSingleFileTests` asserted `Assert.False(diags.IsError)`, which only checked that
      the `Result` was not a failure. `GetDiagnosticsAsync` returns a **success** result carrying a
      **list**, and returns `Ok([])` for an unknown document — so the assertion passed even with zero
      metadata references and proved nothing. Replaced with assertions on the error-severity
      diagnostics themselves.
- [x] Removed `IDE0058`; the remaining `CA1515` / `RS1035` / `CS0618` suppressions are documented
      per repo policy
- [x] Rewritten as coarse tests over real on-disk artifacts per the "no unit tests" rule

### Documentation

- [x] Write [SCRIPTING-FILEBASED-SPEC.md](../specs/SCRIPTING-FILEBASED-SPEC.md)
- [x] Write this plan
- [x] Cross-link from [SHARPLSP-ARCHITECTURE-PROJECTS](../specs/SHARPLSP-SPEC.md)
- [x] Reference spec IDs from implementing code and tests per repo policy
