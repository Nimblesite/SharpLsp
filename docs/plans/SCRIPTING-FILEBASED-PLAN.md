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

### Rust Host — routing and classification

- [ ] Add `src/document_kind.rs`: classify a path into `ProjectOwned` / `CSharpFileBasedApp` /
      `CSharpScript` / `FSharpScript` / `FSharpSignature` / `Unsupported` — implements [SCRIPT-DETECT]
- [ ] Implement cone search with the four stop conditions (project file, workspace root, `.git`,
      filesystem root) — implements [SCRIPT-CONE]
- [ ] **Fix latch bug**: `init_workspace_for_file` currently returns `true` for *any* file with a
      parent directory, so opening a `.md`/`.json` first permanently blocks workspace init. Return
      `true` only when a sidecar workspace was actually opened — implements [SCRIPT-ROUTE-LAZY]
- [ ] Send the **file path**, not the parent directory, for script and file-based documents —
      implements [SCRIPT-ROUTE-TARGET]
- [ ] Start the second language's sidecar on demand when a document of that language is first opened
      (currently a one-shot latch, so a mixed-language folder needs a restart) — [SCRIPT-ROUTE-LAZY]
- [ ] Deduplicate the lazy path against `start_sidecar`: the lazy path currently skips analyzer
      configuration and diagnostics wiring that the eager path performs — [SCRIPT-ROUTE-LAZY]
- [ ] Keep health-monitor start strictly after `workspace/open` completes — [SCRIPT-ROUTE-HEALTH]
- [ ] Remove trailing whitespace introduced in `src/main.rs` (fails `cargo fmt --check`)
- [ ] Flatten the 4-level `if let` nest in `init_workspace_for_file` (clippy cognitive complexity,
      functions <20 LOC)

### C# Sidecar — file-based apps

- [ ] Add `FileLevelDirectives.cs`: parse `IgnoredDirectiveTriviaSyntax` / `ShebangDirectiveTriviaSyntax`
      off the CST into a typed directive model — implements [FILEBASED-DIRECTIVES]
- [ ] Support `#:sdk`, `#:package` (`Name`, `Name@Version`, `Name@*`), `#:project`, `#:property`,
      `#:include` — implements [FILEBASED-DIRECTIVES]
- [ ] Map `#:include` item types by extension (`.cs`→Compile, `.resx`→EmbeddedResource, `.json`→None,
      `.razor`→Content); only `Compile` joins the semantic closure — [FILEBASED-DIRECTIVES]
- [ ] Diagnostic for a `#:` directive appearing after the first non-trivia token — [FILEBASED-DIRECTIVES]
- [ ] **Replace `ResolveCsFiles` directory glob** with root-file + transitive `#:include` closure,
      cycle-safe, bounded to 64 files / 8 levels — implements [SCRIPT-CLOSURE], kills [SCRIPT-ANTIPATTERN]
- [ ] Pass the file verbatim to Roslyn; never strip or rewrite the shebang — [FILEBASED-SHEBANG]
- [ ] Resolve `LanguageVersion` from the target framework band instead of hardcoding `Preview` —
      implements [FILEBASED-PARSEOPTIONS]
- [ ] Diagnostic when an `#:include`d file declares top-level statements — [FILEBASED-ENTRYPOINT]
- [ ] Keep a root-path → workspace map so two apps in one directory stay independent — [SCRIPT-MULTIROOT]
- [ ] Dispose the previous `AdhocWorkspace` when reopening (currently leaked on repeat `OpenAsync`)
- [ ] Report `filebased-degraded` from `workspace/status` while on tier 2 — [FILEBASED-REFERENCES-FALLBACK]
- [ ] Publish an informational diagnostic naming why `#:package` symbols are unresolved on tier 2 —
      [FILEBASED-REFERENCES-FALLBACK]

### C# Sidecar — scripts

- [ ] `.csx` parsed with `SourceCodeKind.Script`, `OutputKind.DynamicallyLinkedLibrary` —
      implements [CSX-OPTIONS]
- [ ] Apply the ten script default imports as global usings — [CSX-OPTIONS]
- [ ] `SourceReferenceResolver` for `#load`, rooted at the script directory — [CSX-RESOLVERS]
- [ ] `MetadataReferenceResolver` for `#r "assembly.dll"`, rooted at the script directory — [CSX-RESOLVERS]
- [ ] Clear unresolved-reference diagnostic for `#r "nuget:"` (phase 3) — [CSX-RESOLVERS]

### C# Sidecar — regression guards on the existing MSBuild path

- [ ] Ambiguous multi-solution discovery must return an **error**, not fall through to file-based mode.
      `SolutionLoader.FindRecursiveMatch` returns `null` for both "absent" and "ambiguous"; these must
      become distinguishable — implements [SCRIPT-DEGRADE]
- [ ] Confirm `AddCrossLanguageMetadataReferences` still runs on the MSBuild path after the
      `OpenCoreAsync` reordering
- [ ] Wrap per-file I/O in closure expansion so one unreadable file degrades that file only —
      [SCRIPT-DEGRADE]
- [ ] Honor `CancellationToken` inside the closure read loop

### F# Sidecar — scripts

- [ ] Add `FSharpScripts.fs`: route `.fsx`/`.fsscript` through
      `FSharpChecker.GetProjectOptionsFromScript` — implements [FSX-OPTIONS]
- [ ] Pass `assumeDotNetFramework=false`, `useSdkRefs=true`, `useFsiAuxLib=true` so the `fsi` object
      binds — [FSX-OPTIONS]
- [ ] Define `INTERACTIVE` and `EDITING`, not `COMPILED`, for scripts — implements [FSX-SYMBOLS]
- [ ] Run `#r "nuget:"` resolution off the request path; check without packages first, re-check and
      republish diagnostics when resolution completes — implements [FSX-NUGET]
- [ ] `loadProject` currently hard-fails with `"No .fsproj found"`; dispatch on document kind before
      that point — [SCRIPT-DETECT]
- [ ] `.fsi` with no owning project is syntax-only; open no F# workspace — implements [FSX-FSI]

### Lifecycle

- [ ] Re-parse directives on `didChange`; reload only when the directive set changed, debounced by
      `server.debounce_ms` — implements [SCRIPT-RELOAD]
- [ ] Clear published diagnostics for files leaving the closure — implements [SCRIPT-RELOAD-CLOSURE]

### Phase 2 — tier 1 references

- [ ] Synthesize the virtual project via `Microsoft.Build.Construction.ProjectRootElement` (XML DOM,
      never string concatenation) — implements [FILEBASED-REFERENCES-MSBUILD]
- [ ] Cache directory keyed by hash of the root file's full path, mirroring the SDK's
      `<temp>/dotnet/runfile/<appname>-<appfilesha>/` scheme — [FILEBASED-REFERENCES-MSBUILD]
- [ ] Run `dotnet restore`, then load through the existing `MSBuildWorkspace` path —
      [FILEBASED-REFERENCES-MSBUILD]
- [ ] Apply SDK defaults (`ImplicitUsings`, `Nullable`, `TargetFramework`, `PublishAot`, `PackAsTool`)
      — [FILEBASED-REFERENCES-MSBUILD]
- [ ] Automatic tier 2 → tier 1 upgrade when restore completes — [FILEBASED-REFERENCES-FALLBACK]

### Testing — E2E (`tests/lsp_e2e.rs` + sidecar E2E)

- [ ] `.cs` file-based app: BCL completion resolves — [SCRIPT-TESTS]
- [ ] `.cs` file-based app: hover on `Console.WriteLine` binds — [SCRIPT-TESTS]
- [ ] `.cs` file-based app with `#:include`: symbols from the included file resolve — [SCRIPT-TESTS]
- [ ] `.cs` file-based app with `#:package`: package symbols bind after restore (phase 2) — [SCRIPT-TESTS]
- [ ] Two file-based apps in one directory produce **no** duplicate-entry-point diagnostic —
      regression test for [SCRIPT-ANTIPATTERN]
- [ ] Shebang produces no diagnostic and does not shift reported positions — [FILEBASED-SHEBANG]
- [ ] `.csx`: top-level statement binds and `#load` closure resolves — [CSX-OPTIONS]
- [ ] `.fsx`: hover on a `let` binding binds and `#load` closure resolves — [FSX-OPTIONS]
- [ ] `.fsx` with `#r "nuget:"` resolves after dependency resolution — [FSX-NUGET]
- [ ] Opening a `.md` first, then a `.cs`, still initializes the C# workspace — latch regression
      test for [SCRIPT-ROUTE-LAZY]
- [ ] Opening a `.cs` does not spawn the F# sidecar, and vice versa — [SCRIPT-ROUTE-LAZY]
- [ ] Ambiguous multi-solution directory returns an error, not a synthetic workspace — [SCRIPT-DEGRADE]
- [ ] Closure cycle (`a.cs` includes `b.cs` includes `a.cs`) terminates with a diagnostic —
      [SCRIPT-CLOSURE]

### Test debt inherited from PR #188

- [ ] `WorkspaceManagerSingleFileTests` asserts `Assert.False(diags.IsError)`, which only checks that
      the `Result` is not a failure — it does **not** assert the diagnostic list is empty, so the test
      passes even if every BCL reference is missing. It therefore does not prove the headline fix.
      Replace with an assertion that binds a real BCL symbol.
- [ ] Remove the four unjustified `#pragma warning disable` directives (`CA1515`, `RS1035`, `IDE0058`,
      `CS0618`) or document each per repo policy
- [ ] Convert to a coarse E2E test per the "no unit tests" rule

### Documentation

- [x] Write [SCRIPTING-FILEBASED-SPEC.md](../specs/SCRIPTING-FILEBASED-SPEC.md)
- [x] Write this plan
- [ ] Cross-link from `docs/specs/SHARPLSP-SPEC.md`
- [ ] Reference spec IDs from implementing code and tests per repo policy
