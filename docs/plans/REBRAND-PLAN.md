# REBRAND-PLAN: Forge → SharpLsp

Complete rebrand from "Forge" to "SharpLsp" across every layer of the codebase.
No occurrence of "forge" (case-insensitive) survives in any file name, directory name,
namespace, package name, string literal, log message, comment, or URL.

**New identifiers:**
- Product name: `SharpLsp`
- Rust binary / crate: `sharplsp` / `sharplsp-lsp`
- npm packages: `sharp-lsp` (VS Code ext), `sharp-lsp-website` (website)
- NuGet packages: `SharpLsp.Sidecar.Common`, `SharpLsp.Sidecar.CSharp`, `SharpLsp.Sidecar.FSharp`
- .NET namespaces: `SharpLsp.*`
- Config file: `sharplsp.toml`
- GitHub repo: `https://github.com/Nimblesite/SharpLsp`
- Website: `https://sharplsp.dev`
- LSP custom methods: `sharplsp/*` (e.g. `sharplsp/loadSolution`)
- VS Code publisher: `sharplsp`
- VS Code setting prefix: `sharplsp.*`
- VS Code command prefix: `sharplsp.*`

---

## Phase 1 — Rust Host

- [x] `Cargo.toml` root: `name = "forge-lsp"` → `name = "sharplsp-lsp"`, update `description`, homepage, repository URLs
- [x] `editors/zed/Cargo.toml`: `name = "forge-zed"` → `name = "sharplsp-zed"`, update `description` and comment
- [x] `src/main.rs`: all `"forge-lsp"` log strings, log dir (`forge-lsp-logs` → `sharplsp-lsp-logs`), log file (`forge-lsp.log` → `sharplsp-lsp.log`), startup/shutdown messages
- [x] `src/config.rs`: `CONFIG_FILE_NAME` constant → `"sharplsp.toml"`, all test fixture references to `forge.toml`
- [x] `src/main.rs` (LSP custom methods): every `"forge/*"` method name → `"sharplsp/*"`
- [x] `src/diagnostics.rs`: diagnostic source strings `"forge-fsharp"` → `"sharplsp-fsharp"`, `"forge-csharp"` → `"sharplsp-csharp"`
- [x] `src/sort_members.rs` and any other handler files: log messages referencing `forge/`
- [x] All remaining `src/**/*.rs` files: grep for `"forge"` (case-insensitive), fix every occurrence

---

## Phase 2 — .NET Sidecars

### Directory / file renames (move, don't copy)

- [x] `sidecars/Forge.Sidecar.Common/` → `sidecars/SharpLsp.Sidecar.Common/`
- [x] `sidecars/Forge.Sidecar.CSharp/` → `sidecars/SharpLsp.Sidecar.CSharp/`
- [x] `sidecars/Forge.Sidecar.CSharp.Tests/` → `sidecars/SharpLsp.Sidecar.CSharp.Tests/`
- [x] `sidecars/Forge.Sidecar.FSharp/` → `sidecars/SharpLsp.Sidecar.FSharp/`
- [x] `sidecars/Forge.Sidecar.FSharp.Tests/` → `sidecars/SharpLsp.Sidecar.FSharp.Tests/`
- [x] Rename each `Forge.Sidecar.*.csproj` / `*.fsproj` inside the new directories to `SharpLsp.Sidecar.*.csproj` / `*.fsproj`
- [x] `sidecars/Forge.Sidecars.sln` → `sidecars/SharpLsp.Sidecars.sln`

### Project file content

- [x] `SharpLsp.Sidecar.Common.csproj`: `<RootNamespace>`, `<AssemblyName>`, `<PackageId>` → `SharpLsp.Sidecar.Common`
- [x] `SharpLsp.Sidecar.CSharp.csproj`: all metadata fields updated
- [x] `SharpLsp.Sidecar.FSharp.fsproj`: same metadata fields, updated `<ProjectReference>`
- [x] `SharpLsp.Sidecar.CSharp.Tests.csproj` / `SharpLsp.Sidecar.FSharp.Tests.fsproj`: `<ProjectReference>` paths updated
- [x] Solution file: all project GUIDs/paths updated to `SharpLsp.*` names

### Source code namespaces

- [x] All `*.cs` files: `namespace Forge.` → `namespace SharpLsp.`
- [x] All `*.cs` / `*.fs` files: `using Forge.` → `using SharpLsp.`
- [x] All `*.fs` files: `module Forge.` → `module SharpLsp.`, `open Forge.` → `open SharpLsp.`
- [x] Any remaining string literals referencing `"Forge"` in sidecar source (log messages, protocol method names)
- [x] Protocol method strings in sidecar: `"forge/*"` → `"sharplsp/*"` (must match Rust host)

---

## Phase 3 — VS Code Extension

### package.json

- [x] `"name": "forge"` → `"name": "sharp-lsp"`
- [x] `"displayName": "Forge"` → `"displayName": "SharpLsp"`
- [x] `"description"`: remove all "Forge" mentions
- [x] `"publisher": "forge-lsp"` → `"publisher": "sharplsp"`
- [x] `"icon": "icons/forge.png"` → `"icon": "icons/sharplsp.png"`
- [x] All `"forge.*"` configuration property keys → `"sharplsp.*"`
- [x] Configuration `"title": "Forge"` → `"title": "SharpLsp"`
- [x] All `"forge.*"` command IDs → `"sharplsp.*"`
- [x] Debug type `"forge-coreclr"` → `"sharplsp-coreclr"`, label → `"SharpLsp .NET Debugger"`
- [x] View container `"id": "forge-explorer"` → `"id": "sharplsp-explorer"`, `"title": "Forge"` → `"title": "SharpLsp"`
- [x] `"icon": "icons/forge-activity.svg"` → `"icon": "icons/sharplsp-activity.svg"`
- [x] All remaining view/panel/walkthrough IDs with `forge` prefix

### TypeScript / JavaScript source

- [x] All `editors/vscode/src/**/*.ts`: all forge refs rebranded, build + typecheck pass

### Icons

- [x] `editors/vscode/icons/forge.png` → `editors/vscode/icons/sharplsp.png`
- [x] `editors/vscode/icons/forge.svg` → `editors/vscode/icons/sharplsp.svg`
- [x] `editors/vscode/icons/forge-activity.svg` → `editors/vscode/icons/sharplsp-activity.svg`

---

## Phase 4 — Zed Extension

- [x] `editors/zed/extension.toml`: name, description, binary name
- [x] `editors/zed/src/**/*.rs`: all `"forge"` string literals rebranded

---

## Phase 5 — CI / CD

### `.github/workflows/release.yml`

- [x] All job names, artifact names, staging variables, needs[], paths, patterns updated
- [x] Release title: `"SharpLsp ${{ github.ref_name }}"`
- [x] `dotnet pack` paths → `SharpLsp.Sidecar.*`
- [x] Homebrew formula: archive name, URL, output file, class, homepage, bin.install, assert_match, git commit
- [x] Scoop bucket: same pattern
- [x] All `Nimblesite/forge` → `Nimblesite/SharpLsp`

### `.github/workflows/ci.yml`

- [x] `dotnet pack` paths: `Forge.Sidecar.*` → `SharpLsp.Sidecar.*`

### `.devcontainer/devcontainer.json`

- [x] `"name": "Forge LSP Development"` → `"name": "SharpLsp LSP Development"`

---

## Phase 6 — Configuration & Root Files

- [x] `forge.example.toml` → `sharplsp.example.toml` (moved, header updated)
- [x] `.forge/` directory → `.sharplsp/`
- [x] `README.md`: full rewrite with SharpLsp branding throughout

---

## Phase 7 — Specification & Plan Docs

- [x] `docs/specs/forge-spec.md` → `docs/specs/SHARPLSP-SPEC.md`; all internal "Forge" references updated
- [x] All other `docs/specs/*.md` files: grepped and fixed
- [x] All `docs/plans/*.md` files: grepped and fixed
- [x] `CLAUDE.md` project description updated to SharpLsp

---

## Phase 8 — Website

- [x] `eleventy.config.js`: name, url, description, copyright updated
- [x] `website/package.json`: `"name"` → `"sharp-lsp-website"`
- [x] `_data/navigation.json`: all GitHub URLs, forge-lsp.dev links updated
- [x] All layout / partial files: Forge → SharpLsp, forge-lsp.dev → sharplsp.dev
- [x] `website/src/author/forge-contributors.md` → `sharplsp-contributors.md`
- [x] `website/src/author/christian-findlay.md`: Forge references updated
- [x] All blog posts rebranded and renamed
- [x] `website/src/zh/blog/introducing-forge.md` → `introducing-sharplsp.md`; content updated
- [x] All `website/src/docs/*.md` files: Forge → SharpLsp, URLs and command names updated
- [x] `website/src/index.njk`: title, hero text, all Forge occurrences → SharpLsp

---

## Phase 9 — Final Sweep & Verification

- [x] Zero meaningful forge refs remain across entire codebase
- [x] `grep -ri "forge-lsp.dev" .` — zero results
- [x] `grep -ri "Nimblesite/forge[^/]" .` — zero results
- [x] All Rust build targets compile cleanly: `cargo check` ✓
- [x] All .NET sidecars build: `dotnet build sidecars/SharpLsp.Sidecars.sln` — 0 errors ✓
- [x] VS Code extension: `npm run build` + typecheck pass ✓
- [x] Website builds cleanly: `npm run build` ✓
- [x] `forge.example.toml` no longer exists; `sharplsp.example.toml` exists ✓
- [x] Binary produced is named `sharplsp-lsp` ✓
- [x] NuGet packages produced are named `SharpLsp.Sidecar.*` ✓

---

## Notes

- **Do not copy files — move (rename) them.** Copying is illegal per CLAUDE.md.
- LSP custom method name changes (`forge/*` → `sharplsp/*`) are **a breaking protocol change**. Rust host and both sidecars updated atomically.
- VS Code setting key renames (`forge.*` → `sharplsp.*`) are breaking for existing users; a migration note should be added to release notes.
- The GitHub repository URL changes from `Nimblesite/forge` to `Nimblesite/SharpLsp` — updated everywhere.
