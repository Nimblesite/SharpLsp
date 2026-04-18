# Structured File DOM Rewrite Plan

**Related issue:** [#4 — NuGet XML editing is line-oriented — must use a real XML DOM](https://github.com/Nimblesite/forge/issues/4)

**CLAUDE.md rule:** _"NEVER hand-manipulate structured files. XML/JSON/TOML/YAML/solution files MUST be loaded into a proper document model, mutated via the DOM/AST, and serialized back. Line splicing, regex replacement, or string concatenation on structured files is ILLEGAL."_

## Goal

Eliminate every code path that writes to a structured file (`.csproj`, `.fsproj`, `.props`, `.targets`, `.sln`, `.vsixmanifest`, `package.json`, `launch.json`, `tasks.json`, `settings.json`, etc.) by doing anything other than:

1. Load the file into a real document model (DOM/AST).
2. Mutate the model in memory.
3. Serialize back to disk.

No `std::fs::write` of concatenated strings. No `.replace()` / `.splice()` / `.lines()` / regex / `String.Join("\n", lines)`. No line-indexing to find `</ItemGroup>`.

## Inventory — Current Violations

### CRITICAL (writes corrupt output for real-world inputs)

#### V1 — `src/nuget/xml_edit.rs` (entire file)
- **What:** Line-oriented "fast-path" editor for `PackageReference`/`PackageVersion` in csproj/fsproj/props.
- **Why broken:** The module's own docstring defends this as a deliberate choice to preserve whitespace. It can't handle multi-line `<PackageReference>` with children (`<PrivateAssets>`, `<IncludeAssets>`, conditions), CDATA, comments mid-attribute list, namespaces, or `<Choose>/<When>` blocks. **This is the file that caused issue #4.**
- **Callers:**
  - `src/nuget/handlers.rs:195` — `handle_install`
  - `src/nuget/handlers.rs:204` — CPM `Directory.Packages.props` write
  - `src/nuget/handlers.rs:238` — `handle_remove`
  - `src/nuget/handlers.rs:253` — `pick_install_element`
- **Tests that pin the existing contract:** `tests/nuget_e2e.rs` + `src/nuget/xml_edit.rs` `mod tests`.

#### V2 — `editors/vscode/src/scaffolding.ts` lines 123-144 (`autoAddFileToProject`)
- **What:** When scaffolding a new `.cs` file, splices `<Compile Include="..." />` into the `.csproj` by finding `</ItemGroup>` with `.lastIndexOf()` and concatenating strings.
- **Why broken:** Fails if `</ItemGroup>` appears in a comment, in a string literal inside a property value, or if the project has multiple `<ItemGroup>` blocks (it always picks the last one regardless of what's in it). Doesn't understand SDK-style projects where `<Compile>` is globbed by default and should **not** be added explicitly.

#### V3 — `sidecars/Forge.Sidecar.FSharp/FSharpFileOrder.fs` lines 158-184 (`generateReorderEdit`)
- **What:** Reorders `<Compile Include="...">` elements in `.fsproj` by reading the file as lines, matching `.Contains("Include=\"{name}\"")` on trimmed lines, building a new array, and `String.Join("\n", ...)`-ing it back together.
- **Why broken:** File order matters in F# (compilation order is semantic). A corrupted reorder can break the whole project. Fails on multi-line `<Compile>` elements (with `<Link>` children, conditions, copy metadata), comments between elements, and attribute-wrapped elements. Also silently drops `\r` on CRLF files by splitting on `\n`.

### MEDIUM (currently OK, but flag for audit)

- `editors/vscode/src/dependencies.ts` — **READ-ONLY** inspection using `fast-xml-parser`. OK, leave as-is.
- `editors/vscode/src/testing.ts` Cobertura parser — **READ-ONLY** using `fast-xml-parser`. OK.
- `editors/vscode/src/debug.ts` `readLaunchProfiles` — **READ-ONLY** using `JSON.parse`. OK.
- `sidecars/Forge.Sidecar.CSharp/Workspace/MetadataNavigator.cs` — writes to temp `.cs` files for decompiled source, line-based search for symbol position. **Transient cache**, not a structured project file. OK.
- `sidecars/Forge.Sidecar.FSharp/FSharpWorkspace.fs` line 37 `parseFsprojSourceFiles` — already uses `XDocument.Load`. OK.
- `scripts/check-coverage.sh` — uses `jq`. OK.

## Design

### Principle

Every write to a structured file goes through a **document model owned by the language that has the best library for that format**. For MSBuild files (csproj/fsproj/props/targets) that language is C#/F# via the sidecar, because `Microsoft.Build.Construction.ProjectRootElement` is the same API MSBuild itself uses — it understands conditions, SDK defaults, imports, globbing, CPM, and trivia preservation.

### Architecture — New IPC Methods

Add to the C# sidecar (also available to F# sidecar for `.fsproj` — same MSBuild API):

| Method | Purpose | Replaces |
|---|---|---|
| `forge/project/addPackage` | Add `<PackageReference>` (and `<PackageVersion>` in CPM `Directory.Packages.props` if needed) | `xml_edit::add_package` |
| `forge/project/removePackage` | Remove a `<PackageReference>` element **and all its children** | `xml_edit::remove_package` — fixes issue #4 |
| `forge/project/updatePackageVersion` | Update the `Version=` attribute on a `<PackageReference>` or `<PackageVersion>` | `xml_edit::upsert` version-replace path |
| `forge/project/addCompileItem` | Add `<Compile Include="..." />` (only if the project is not SDK-style or has explicit compile lists) | `scaffolding.ts autoAddFileToProject` |
| `forge/project/reorderCompileItems` | Reorder `<Compile>` entries in an .fsproj | `FSharpFileOrder.fs generateReorderEdit` |

All five operations share the same pattern inside the sidecar:

```csharp
var project = ProjectRootElement.Open(path);          // DOM
MutateInMemory(project);                              // model edits
project.Save(path);                                   // trivia-preserving write
```

`ProjectRootElement.Save()` preserves whitespace, comments, and attribute order, and only rewrites the parts of the file that actually changed. No more string splicing.

### Why not `Microsoft.Build.Evaluation.Project`?

`Project` evaluates the MSBuild graph (imports, conditions, targets) — expensive and requires MSBuild to be located. `ProjectRootElement` is the unevaluated construction model: read the file, mutate elements, write it back. That's what we want for every edit operation here.

### Rust host changes

- Delete `src/nuget/xml_edit.rs` entirely.
- `src/nuget/handlers.rs` becomes a thin IPC forwarder: serialize the request, send to the C# sidecar (or F# sidecar for `.fsproj`), return the response.
- No XML parsing in Rust. No line manipulation in Rust. The Rust host only routes.

### TypeScript client changes

- `editors/vscode/src/scaffolding.ts autoAddFileToProject` — delete the fs-based splicing. Call `forge/project/addCompileItem` via the LSP client instead. If the project is SDK-style and the file is already globbed, the sidecar returns a no-op result and the extension does nothing.
- `editors/vscode/src/dependencies.ts` — no change (read-only).

### F# sidecar changes

- Add IPC handlers that delegate to the same `ProjectRootElement` API (MSBuild is cross-language; F# can use `Microsoft.Build.Construction` just fine).
- `FSharpFileOrder.fs generateReorderEdit` — replace the line-splicing implementation with `ProjectRootElement.Open` → reorder `<Compile>` children → `Save`.

## Phases

### Phase 1 — Introduce the sidecar API (no caller switches yet)

- [ ] Add `Forge.Sidecar.Common` IPC message types: `AddPackageRequest`, `RemovePackageRequest`, `UpdatePackageVersionRequest`, `AddCompileItemRequest`, `ReorderCompileItemsRequest`, and a unified `ProjectEditResult { modified: bool, message: string }`.
- [ ] Implement handlers in `sidecars/Forge.Sidecar.CSharp/Workspace/ProjectEditor.cs` using `ProjectRootElement`:
  - [ ] `AddPackage` — find/create `<ItemGroup>`, add `<PackageReference Include="X" Version="Y" />`; handle CPM (`Directory.Packages.props`) variant that adds `<PackageVersion>`.
  - [ ] `RemovePackage` — find matching `<PackageReference>`/`<PackageVersion>` element and call `.Parent.RemoveChild(el)` (removes the whole subtree, fixing issue #4).
  - [ ] `UpdatePackageVersion` — set `.SetAttributeValue("Version", newVersion)`.
  - [ ] `AddCompileItem` — detect SDK-style + default `Compile` globs; no-op if already globbed; else add `<Compile Include="..." />`.
- [ ] Register IPC methods in `sidecars/Forge.Sidecar.CSharp/Program.cs` router.
- [ ] Mirror the handlers in `sidecars/Forge.Sidecar.FSharp` so `.fsproj` edits go to the F# sidecar (which still uses `Microsoft.Build.Construction` — it's language-agnostic).
- [ ] Add `ReorderCompileItems` handler: list `<Compile>` children of their parent `<ItemGroup>`, reorder using `.InsertBeforeChild`/`.InsertAfterChild`.
- [ ] Unit tests for each handler covering the exact scenarios the line-based code broke on:
  - [ ] `<PackageReference>` with `<PrivateAssets>`/`<IncludeAssets>` children (issue #4)
  - [ ] Conditional `<ItemGroup Condition="'$(Target)' == 'net10.0'">`
  - [ ] CPM with `Directory.Packages.props` — add/remove writes `<PackageVersion>` in props and `<PackageReference>` with no `Version=` in csproj
  - [ ] Multi-ItemGroup files (pick the one that already has PackageReferences)
  - [ ] Comments preserved between elements
  - [ ] CRLF files preserved as CRLF after save

### Phase 2 — Route Rust host through the sidecar, delete `xml_edit.rs`

- [ ] Add `src/sidecar/project_editor.rs` — thin wrappers that serialize/send each request.
- [ ] Rewrite `src/nuget/handlers.rs::handle_install`, `handle_remove`, and the CPM props-file case to call the sidecar instead of `xml_edit::*`.
- [ ] Delete `src/nuget/xml_edit.rs`.
- [ ] Delete the `xml_edit` module export from `src/nuget/mod.rs`.
- [ ] Update `src/nuget/cli.rs` header comment that still references `xml_edit`.
- [ ] `tests/nuget_e2e.rs` — keep every existing scenario green, plus add the multi-line-child scenario from issue #4.
- [ ] Remove the now-dead `xml_edit` clippy suppressions or tests.

### Phase 3 — Switch scaffolding.ts to the sidecar

- [ ] `editors/vscode/src/scaffolding.ts autoAddFileToProject` — replace the file-system splicing with a call to the new `forge/project/addCompileItem` LSP custom request.
- [ ] Delete the `fs.readFileSync`/`fs.writeFileSync` path and the `lastIndexOf('</ItemGroup>')` code.
- [ ] Add a VSCode test that scaffolds a new `.cs` file into a project with a comment containing `</ItemGroup>` to prove the old bug is gone.
- [ ] Add a test for SDK-style projects that have default `Compile` globs — the no-op path.

### Phase 4 — Switch FSharpFileOrder.fs to ProjectRootElement

- [ ] Rewrite `FSharpFileOrder.fs generateReorderEdit` using `ProjectRootElement.Open` → locate the two `<Compile>` elements by `Include` attribute → reorder via `InsertBeforeChild` → `Save`.
- [ ] Add tests covering:
  - [ ] Multi-line `<Compile>` with a `<Link>` child
  - [ ] Conditional `<Compile Include="Platform.fs" Condition="'$(OS)' == 'Windows_NT'" />`
  - [ ] CRLF preservation
  - [ ] Comment preservation between `<Compile>` elements

### Phase 5 — Enforce the CLAUDE.md rule

- [ ] Add a lint/CI check that greps the codebase for banned patterns in source (not tests/fixtures):
  - `fs.writeFileSync(.*\.(csproj|fsproj|props|targets|sln|vsixmanifest|json)`
  - `File.WriteAllText(.*\.(csproj|fsproj|props|targets))`
  - `std::fs::write(.*\.(csproj|fsproj|props|targets))`
  - `String.Join.*lines` on `*proj` content
- [ ] Fail CI if any of these appear outside a well-known allowlist (e.g. tests that write fixture files into `tmp`).
- [ ] Document in `docs/specs/FORGE-SPEC.md` that structured file edits go through the sidecar.

## Acceptance Criteria

- [ ] `src/nuget/xml_edit.rs` **does not exist**.
- [ ] No source file under `src/`, `editors/vscode/src/`, or `sidecars/**/*.{cs,fs}` writes to a `.csproj`/`.fsproj`/`.props`/`.targets`/`.sln`/`.vsixmanifest`/`.json` via string concatenation, `.replace()`, regex, or line-array joins. Verified by grep.
- [ ] Issue #4's exact reproduction case (multi-line `<PackageReference>` with `<PrivateAssets>`/`<IncludeAssets>` children) is covered by a test and passes.
- [ ] Scaffolding a new `.cs` into a project whose comments contain `</ItemGroup>` works correctly.
- [ ] F# file-order reordering preserves comments, CRLF, conditions, and child elements.
- [ ] Existing `tests/nuget_e2e.rs` scenarios still pass.
- [ ] CI has a grep-based guard that blocks re-introduction.

## Non-Goals

- Rewriting the read-only parsers (`dependencies.ts`, `testing.ts` Cobertura, `debug.ts` launch settings). They already use real parsers.
- Changing the MSBuild graph evaluation model (we use `ProjectRootElement`, not `Project`).
- Touching the `.sln` file format — not currently edited by Forge, but if that changes, must use the same rule (`Microsoft.VisualStudio.SolutionPersistence` or `SolutionFile`).
