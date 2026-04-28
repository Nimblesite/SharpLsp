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

- [ ] `Cargo.toml` root: `name = "forge-lsp"` → `name = "sharplsp-lsp"`, update `description`, homepage, repository URLs
- [ ] `editors/zed/Cargo.toml`: `name = "forge-zed"` → `name = "sharplsp-zed"`, update `description` and comment
- [ ] `src/main.rs`: all `"forge-lsp"` log strings, log dir (`forge-lsp-logs` → `sharplsp-lsp-logs`), log file (`forge-lsp.log` → `sharplsp-lsp.log`), startup/shutdown messages
- [ ] `src/config.rs`: `CONFIG_FILE_NAME` constant → `"sharplsp.toml"`, all test fixture references to `forge.toml`
- [ ] `src/main.rs` (LSP custom methods): every `"forge/*"` method name → `"sharplsp/*"` — full list:
  - `forge/loadSolution` → `sharplsp/loadSolution`
  - `forge/workspaceSymbols` → `sharplsp/workspaceSymbols`
  - `forge/sortMembers` → `sharplsp/sortMembers`
  - `forge/nuget/targets` → `sharplsp/nuget/targets`
  - `forge/nuget/search` → `sharplsp/nuget/search`
  - `forge/nuget/versions` → `sharplsp/nuget/versions`
  - `forge/nuget/installed` → `sharplsp/nuget/installed`
  - `forge/nuget/install` → `sharplsp/nuget/install`
  - `forge/nuget/uninstall` → `sharplsp/nuget/uninstall`
  - `forge/profiler/listProcesses` → `sharplsp/profiler/listProcesses`
  - `forge/profiler/attach` → `sharplsp/profiler/attach`
  - `forge/profiler/detach` → `sharplsp/profiler/detach`
  - `forge/profiler/snapshot` → `sharplsp/profiler/snapshot`
  - `forge/profiler/callTree` → `sharplsp/profiler/callTree`
  - `forge/profiler/hotspots` → `sharplsp/profiler/hotspots`
  - `forge/profiler/timeline` → `sharplsp/profiler/timeline`
  - `forge/profiler/allocations` → `sharplsp/profiler/allocations`
  - `forge/profiler/inspectObject` → `sharplsp/profiler/inspectObject`
  - (any additional `forge/*` methods discovered during search)
- [ ] `src/diagnostics.rs`: diagnostic source strings `"forge-fsharp"` → `"sharplsp-fsharp"`, `"forge-csharp"` → `"sharplsp-csharp"`
- [ ] `src/sort_members.rs` and any other handler files: log messages referencing `forge/`
- [ ] All remaining `src/**/*.rs` files: grep for `"forge"` (case-insensitive), fix every occurrence

---

## Phase 2 — .NET Sidecars

### Directory / file renames (move, don't copy)

- [ ] `sidecars/Forge.Sidecar.Common/` → `sidecars/SharpLsp.Sidecar.Common/`
- [ ] `sidecars/Forge.Sidecar.CSharp/` → `sidecars/SharpLsp.Sidecar.CSharp/`
- [ ] `sidecars/Forge.Sidecar.CSharp.Tests/` → `sidecars/SharpLsp.Sidecar.CSharp.Tests/`
- [ ] `sidecars/Forge.Sidecar.FSharp/` → `sidecars/SharpLsp.Sidecar.FSharp/`
- [ ] `sidecars/Forge.Sidecar.FSharp.Tests/` → `sidecars/SharpLsp.Sidecar.FSharp.Tests/`
- [ ] Rename each `Forge.Sidecar.*.csproj` / `*.fsproj` inside the new directories to `SharpLsp.Sidecar.*.csproj` / `*.fsproj`
- [ ] `sidecars/Forge.Sidecars.sln` → `sidecars/SharpLsp.Sidecars.sln`

### Project file content

- [ ] `SharpLsp.Sidecar.Common.csproj`: `<RootNamespace>`, `<AssemblyName>`, `<PackageId>` → `SharpLsp.Sidecar.Common`
- [ ] `SharpLsp.Sidecar.CSharp.csproj`:
  - `<PackageId>SharpLsp.Sidecar.CSharp</PackageId>`
  - `<Authors>SharpLsp contributors</Authors>`
  - `<Description>SharpLsp C# language sidecar…`
  - `<RepositoryUrl>https://github.com/Nimblesite/SharpLsp</RepositoryUrl>`
  - `<PackageProjectUrl>https://github.com/Nimblesite/SharpLsp</PackageProjectUrl>`
  - `<InternalsVisibleTo Include="SharpLsp.Sidecar.CSharp.Tests" />`
  - `<ProjectReference>` path updated to `SharpLsp.Sidecar.Common`
- [ ] `SharpLsp.Sidecar.FSharp.fsproj`: same metadata fields, updated `<ProjectReference>`
- [ ] `SharpLsp.Sidecar.CSharp.Tests.csproj` / `SharpLsp.Sidecar.FSharp.Tests.fsproj`: `<ProjectReference>` paths updated
- [ ] Solution file: all project GUIDs/paths updated to `SharpLsp.*` names

### Source code namespaces

- [ ] All `*.cs` files: `namespace Forge.` → `namespace SharpLsp.`
- [ ] All `*.cs` / `*.fs` files: `using Forge.` → `using SharpLsp.`
- [ ] All `*.fs` files: `module Forge.` → `module SharpLsp.`, `open Forge.` → `open SharpLsp.`
- [ ] Any remaining string literals referencing `"Forge"` in sidecar source (log messages, protocol method names)
- [ ] Protocol method strings in sidecar: `"forge/*"` → `"sharplsp/*"` (must match Rust host)

---

## Phase 3 — VS Code Extension

### package.json

- [ ] `"name": "forge"` → `"name": "sharp-lsp"`
- [ ] `"displayName": "Forge"` → `"displayName": "SharpLsp"`
- [ ] `"description"`: remove all "Forge" mentions
- [ ] `"publisher": "forge-lsp"` → `"publisher": "sharplsp"`
- [ ] `"icon": "icons/forge.png"` → `"icon": "icons/sharplsp.png"`
- [ ] All `"forge.*"` configuration property keys → `"sharplsp.*"` (100+ keys — do a bulk find/replace)
- [ ] Configuration `"title": "Forge"` → `"title": "SharpLsp"`
- [ ] All `"forge.*"` command IDs → `"sharplsp.*"` (100+ commands)
- [ ] Debug type `"forge-coreclr"` → `"sharplsp-coreclr"`, `"label": "Forge .NET Debugger"` → `"label": "SharpLsp .NET Debugger"`
- [ ] View container `"id": "forge-explorer"` → `"id": "sharplsp-explorer"`, `"title": "Forge"` → `"title": "SharpLsp"`
- [ ] `"icon": "icons/forge-activity.svg"` → `"icon": "icons/sharplsp-activity.svg"`
- [ ] All remaining view/panel/walkthrough IDs with `forge` prefix

### TypeScript / JavaScript source

- [ ] All `editors/vscode/src/**/*.ts`: grep `forge` (case-insensitive), rename:
  - Command ID strings: `"forge.*"` → `"sharplsp.*"`
  - Setting key reads: `forge.` → `sharplsp.`
  - Extension ID references
  - Log/display strings

### Icons

- [ ] `editors/vscode/icons/forge.png` → `editors/vscode/icons/sharplsp.png`
- [ ] `editors/vscode/icons/forge.svg` → `editors/vscode/icons/sharplsp.svg`
- [ ] `editors/vscode/icons/forge-activity.svg` → `editors/vscode/icons/sharplsp-activity.svg`
- [ ] Any other `forge*` icon files

---

## Phase 4 — Zed Extension

- [ ] `editors/zed/extension.toml` (or `Cargo.toml`): name, description, binary name
- [ ] `editors/zed/src/**/*.rs`: all `"forge"` string literals (command names, config keys, log messages)

---

## Phase 5 — CI / CD

### `.github/workflows/release.yml`

- [ ] Job name `build-forge-lsp:` → `build-sharplsp-lsp:`
- [ ] `name: Build forge-lsp (…)` → `name: Build sharplsp-lsp (…)`
- [ ] Artifact names: `forge-lsp` → `sharplsp-lsp`
- [ ] Staging variable: `forge-lsp-${{ github.ref_name }}-${{ matrix.target }}` → `sharplsp-lsp-…`
- [ ] `needs: [build-forge-lsp, …]` → `needs: [build-sharplsp-lsp, …]`
- [ ] `path: artifacts/forge-lsp` → `path: artifacts/sharplsp-lsp`
- [ ] `pattern: forge-lsp-*` → `pattern: sharplsp-lsp-*`
- [ ] Release title: `"Forge ${{ github.ref_name }}"` → `"SharpLsp ${{ github.ref_name }}"`
- [ ] `dotnet pack sidecars/Forge.Sidecar.CSharp/…` → `…SharpLsp.Sidecar.CSharp/…`
- [ ] `dotnet pack sidecars/Forge.Sidecar.FSharp/…` → `…SharpLsp.Sidecar.FSharp/…`
- [ ] Homebrew formula:
  - Variable: `ARCHIVE="forge-lsp-…"` → `ARCHIVE="sharplsp-lsp-…"`
  - URL base: `https://github.com/Nimblesite/forge/releases/…` → `https://github.com/Nimblesite/SharpLsp/releases/…`
  - Output file: `homebrew-tap/Formula/forge-lsp.rb` → `homebrew-tap/Formula/sharplsp-lsp.rb`
  - Class: `class ForgeLsp < Formula` → `class SharplspLsp < Formula`
  - `homepage`: old repo URL → `https://github.com/Nimblesite/SharpLsp`
  - `bin.install "forge-lsp"` → `bin.install "sharplsp-lsp"`
  - `assert_match "forge-lsp"` → `assert_match "sharplsp-lsp"`
  - `git commit -m "Update forge-lsp to…"` → `"Update sharplsp-lsp to…"`
- [ ] Scoop bucket: same pattern as Homebrew above
- [ ] Repository references: `Nimblesite/forge` → `Nimblesite/SharpLsp` throughout

### `.github/workflows/ci.yml`

- [ ] `dotnet pack` paths: `Forge.Sidecar.*` → `SharpLsp.Sidecar.*`
- [ ] Any job names or artifact names with `forge`

### `.devcontainer/devcontainer.json`

- [ ] `"name": "Forge LSP Development"` → `"name": "SharpLsp LSP Development"`

---

## Phase 6 — Configuration & Root Files

- [ ] `forge.example.toml` → rename to `sharplsp.example.toml`
  - File header comment: `# Forge LSP Configuration` → `# SharpLsp Configuration`
  - `# Copy this file to \`forge.toml\`` → `# Copy this file to \`sharplsp.toml\``
- [ ] `.forge/` directory (if it contains tracked files) → `.sharplsp/`; update any references to it
- [ ] `README.md`: full rewrite of product name, all URLs, install instructions, badge URLs
- [ ] `forge.vsix` (if tracked) → `sharplsp.vsix`

---

## Phase 7 — Specification & Plan Docs

- [ ] `docs/specs/forge-spec.md` → rename to `docs/specs/SHARPLSP-SPEC.md`; update every internal reference to "Forge"
- [ ] `docs/specs/DISTRIBUTION-SPEC.md`: replace all "Forge" / "forge-lsp" occurrences
- [ ] `docs/specs/VSCODE-REACTIVITY-SPEC.md`: same
- [ ] `docs/specs/SOLUTION-EXPLORER-SPEC.md`: same
- [ ] `docs/specs/BINARY-DEPLOYMENT.md`: same
- [ ] All other `docs/specs/*.md` files: grep and fix
- [ ] All `docs/plans/*.md` files: grep and fix (including this file once complete)
- [ ] Update `CLAUDE.md` project description — remove "Forge", use "SharpLsp" (the tool name, not the project instruction header)

---

## Phase 8 — Website

### eleventy.config.js

- [ ] `name: "Forge"` → `name: "SharpLsp"`
- [ ] `url: "https://forge-lsp.dev"` → `url: "https://sharplsp.dev"`
- [ ] `description`: remove "Forge" mentions
- [ ] Copyright string: `© ${year} Forge` → `© ${year} SharpLsp`

### package.json

- [ ] `"name": "forge-website"` → `"name": "sharp-lsp-website"`

### _data/navigation.json

- [ ] All GitHub URLs: `https://github.com/MelbourneDeveloper/forge` (and `Nimblesite/forge`) → `https://github.com/Nimblesite/SharpLsp`
- [ ] Issues URL: `…/forge/issues` → `…/SharpLsp/issues`
- [ ] Any `forge-lsp.dev` links → `sharplsp.dev`

### Layout / partial files

- [ ] `website/src/_includes/layouts/base.njk`: title template, meta description, OG tags — all "Forge" → "SharpLsp", all `forge-lsp.dev` → `sharplsp.dev`
- [ ] `website/src/_includes/layouts/docs.njk`: same
- [ ] `website/src/_includes/layouts/author.njk`: same
- [ ] `website/src/_includes/partials/post-card.njk`: same
- [ ] `website/src/_includes/partials/docs-sidebar.njk`: same

### Author pages

- [ ] `website/src/author/forge-contributors.md` → rename to `website/src/author/sharplsp-contributors.md`; update frontmatter and body
- [ ] `website/src/author/christian-findlay.md`: remove/update any "Forge" references

### Blog posts

- [ ] `website/src/blog/introducing-forge.md` → rename to `website/src/blog/introducing-sharplsp.md`; full content rewrite replacing all "Forge" with "SharpLsp", update URLs
- [ ] `website/src/blog/why-fsharp-is-first-class-in-forge.md` → rename, update title and body
- [ ] `website/src/blog/editor-agnostic-dotnet-lsp.md`: grep and fix
- [ ] `website/src/blog/pull-diagnostics-without-phantom-errors.md`: grep and fix
- [ ] All other `website/src/blog/*.md` files: grep for "forge", fix

### Chinese translations

- [ ] `website/src/zh/blog/introducing-forge.md` → rename and update content

### Docs pages (website/src/docs/)

- [ ] `architecture.md`, `completions.md`, `context-menus.md`, `diagnostics.md`, `editors.md`, `go-to-definition.md`, `hover.md`, `nuget.md`, `profiler.md`, `refactoring.md` — all: replace "Forge" with "SharpLsp", update any `forge-lsp.dev` or GitHub URLs, update any command names (`forge.*` → `sharplsp.*`), update config key names (`forge.*` → `sharplsp.*`)
- [ ] Any remaining `website/src/docs/*.md` files: grep and fix

### Landing page

- [ ] `website/src/index.njk`: title frontmatter, hero text, code window title, all "Forge" occurrences → "SharpLsp", URL references

---

## Phase 9 — Final Sweep & Verification

- [ ] `grep -ri "forge" .` from repo root (excluding `.git/`, `target/`, `node_modules/`, `_site/`) — zero results expected
- [ ] `grep -ri "forge-lsp.dev" .` — zero results expected
- [ ] `grep -ri "Nimblesite/forge[^/]" .` — zero results expected (only `Nimblesite/SharpLsp` allowed)
- [ ] All Rust build targets compile cleanly: `cargo build`
- [ ] All clippy checks pass: `cargo clippy --all-targets -- -D warnings`
- [ ] All .NET sidecars build: `dotnet build sidecars/SharpLsp.Sidecars.sln`
- [ ] All sidecar tests pass: `dotnet test sidecars/SharpLsp.Sidecars.sln`
- [ ] VS Code extension packages cleanly: `npm run package` in `editors/vscode/`
- [ ] Website builds cleanly: `npm run build` in `website/`
- [ ] `forge.example.toml` no longer exists; `sharplsp.example.toml` exists and is valid TOML
- [ ] Binary produced is named `sharplsp-lsp` (not `forge-lsp`)
- [ ] NuGet packages produced are named `SharpLsp.Sidecar.*`

---

## Notes

- **Do not copy files — move (rename) them.** Copying is illegal per CLAUDE.md.
- **Never hand-manipulate structured files.** `.csproj`, `.fsproj`, `.sln`, `package.json`, `Cargo.toml` must be loaded into a proper DOM/AST and mutated — no regex replacement on raw file content.
- LSP custom method name changes (`forge/*` → `sharplsp/*`) are **a breaking protocol change**. The Rust host and both sidecars must be updated atomically — a mismatch will break all custom features.
- VS Code setting key renames (`forge.*` → `sharplsp.*`) are also breaking for existing users; a migration note should be added to the release notes (not in code).
- The GitHub repository URL changes from `Nimblesite/forge` to `Nimblesite/SharpLsp` — update every hardcoded occurrence including Homebrew formula, Scoop bucket, NuGet metadata, and website nav.
