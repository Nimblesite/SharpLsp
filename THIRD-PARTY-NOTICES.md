# Third-Party Notices

SharpLsp is licensed under the MIT License (see [LICENSE](LICENSE), © 2026
Christian Findlay). It **bundles and/or links** third-party components. This
file acknowledges those components and their licenses, as required by their
terms. All bundled licenses are permissive (MIT, Apache-2.0, BSD) and compatible
with SharpLsp's MIT license; the only obligation each imposes is attribution,
which this file satisfies.

> **Scope.** "Bundled" = shipped inside the VS Code VSIX under `bin/` (native
> executables + their runtime assemblies), or statically linked into the
> `sharplsp` Rust binary. Tools acquired at runtime (the .NET SDK, the
> `dotnet-trace`/`dotnet-dump`/`dotnet-counters` diagnostics CLIs) are **not**
> redistributed by SharpLsp and are listed separately for completeness.
>
> **Verification.** netcoredbg's license was verified against its upstream
> `LICENSE` file (see below). .NET/NuGet component licenses are taken from each
> package's `PackageLicenseExpression` / project repository; Rust crate licenses
> from their `Cargo.toml` `license` fields. This is a point-in-time manual audit
> — see [Continuous verification](#continuous-verification) for the automated
> gate that keeps it honest.

---

## 1. Bundled native executables

### netcoredbg — the .NET debug adapter

- **Component:** `netcoredbg` (managed-code debugger / DAP adapter), bundled per
  platform at `bin/<platform>/netcoredbg/` and launched by the
  `sharplsp-coreclr` debug adapter factory (`src/editors/vscode/src/debug.ts`).
- **Upstream:** https://github.com/Samsung/netcoredbg
- **Pinned version:** `3.2.0-1092`
- **License:** MIT — **© 2017 Samsung Electronics Co., LTD** (verified against
  https://raw.githubusercontent.com/Samsung/netcoredbg/master/LICENSE).
- **Platform coverage:** upstream ships prebuilt binaries for `win32-x64`,
  `linux-x64`, `linux-arm64`, and `darwin-arm64` only. On `win32-arm64` and
  `darwin-x64` (no upstream prebuilt) SharpLsp does not bundle netcoredbg and
  falls back to a user-installed copy on `PATH` / the `sharplsp.debug.netcoredbgPath`
  setting.

netcoredbg's archive includes managed helper assemblies (its `ManagedPart.dll`
and Microsoft.CodeAnalysis / .NET runtime support assemblies). Those are
redistributed under their own MIT / .NET Foundation licenses (§2, §4).

---

## 2. C# sidecar (`sharplsp-sidecar-csharp`) — bundled runtime libraries

Copied into the VSIX at `bin/all/` alongside the sidecar executable.

| Component | Version | License | Copyright / Owner |
|---|---|---|---|
| Microsoft.CodeAnalysis (Roslyn: CSharp.Features, CSharp.Workspaces, Workspaces.MSBuild) | 5.6.0 | MIT | .NET Foundation and Contributors |
| ICSharpCode.Decompiler (ILSpy) | 10.1.0.8386 | MIT | AlphaSierraPapa / ILSpy contributors |
| Microsoft.Build.Locator | 1.11.2 | MIT | .NET Foundation and Contributors |
| Basic.Reference.Assemblies.Net100 | 1.8.10 | MIT | Jason Malinowski |
| Microsoft.VisualStudio.SolutionPersistence | 1.0.52 | MIT | .NET Foundation and Contributors |
| MessagePack (MessagePack-CSharp) | 3.1.8 | MIT | Yoshifumi Kawai / Cysharp |
| Serilog | 4.4.0 | Apache-2.0 | Serilog Contributors |
| Serilog.Sinks.File | 7.0.0 | Apache-2.0 | Serilog Contributors |
| Outcome | 1.0.0 | MIT | Christian Findlay |

> `Microsoft.Build`, `Microsoft.Build.Framework`, and `Microsoft.NET.StringTools`
> are referenced **compile-time only** (`ExcludeAssets="runtime"`); MSBuildLocator
> loads the real assemblies from the .NET SDK at runtime, so they are **not
> bundled**.

---

## 3. F# sidecar (`sharplsp-sidecar-fsharp`) — bundled runtime libraries

Copied into the VSIX at `bin/all/` alongside the sidecar executable. F# is a
first-class citizen of SharpLsp.

| Component | Version | License | Copyright / Owner |
|---|---|---|---|
| FSharp.Core | 10.1.204 | MIT | .NET Foundation and Contributors |
| FSharp.Compiler.Service | 43.12.204 | MIT | .NET Foundation and Contributors |
| Fantomas.Core | 7.0.5 | MIT | Florian Verdonck / Fantomas contributors |
| FSharpLint.Core | 0.27.0 | MIT | FSharpLint contributors |
| MessagePack (MessagePack-CSharp) | 3.1.8 | MIT | Yoshifumi Kawai / Cysharp |
| System.Security.Cryptography.Xml | 10.0.10 | MIT | .NET Foundation and Contributors |

---

## 4. Rust host (`sharplsp`) — statically linked crates

Compiled into the `sharplsp` binary. All are permissive (MIT or Apache-2.0/MIT
dual). Primary direct dependencies (see `Cargo.toml` for exact versions):

| Crate | License | Crate | License |
|---|---|---|---|
| lsp-server | MIT / Apache-2.0 | lsp-types | MIT / Apache-2.0 |
| tree-sitter, tree-sitter-c-sharp | MIT | tokio | MIT |
| serde, serde_json | MIT / Apache-2.0 | rmp-serde | MIT |
| toml | MIT / Apache-2.0 | anyhow | MIT / Apache-2.0 |
| tracing (+ subscriber, appender) | MIT | reqwest | MIT / Apache-2.0 |
| dashmap | MIT | crossbeam-channel | MIT / Apache-2.0 |
| url, percent-encoding | MIT / Apache-2.0 | sysinfo | MIT |
| shipwright, shipwright-manifest | (per crate metadata) | | |

The complete transitive crate list and their license texts can be generated
reproducibly with `cargo about generate` (see below).

---

## 5. Runtime-acquired tools (not redistributed)

These are required for some features but downloaded/invoked from the user's
environment, not shipped in the VSIX:

| Tool | Used by | License | Owner |
|---|---|---|---|
| .NET 10 SDK / runtime | sidecars, debugging, profiling | MIT | .NET Foundation |
| `dotnet-trace`, `dotnet-dump`, `dotnet-counters` | Profiler (trace → speedscope, dumps, counters) | MIT | .NET Foundation |

---

## Continuous verification

A point-in-time table drifts. The licensing check MUST be automated so a new
dependency with an incompatible or unstated license fails CI:

- **Rust:** `cargo about generate` (deny non-allowlisted licenses via
  `about.toml`).
- **.NET:** enumerate `PackageLicenseExpression` for the restored graph (e.g.
  `dotnet-project-licenses`) and fail on anything outside the MIT/Apache-2.0/BSD
  allowlist.
- **npm (extension):** `license-checker --onlyAllow 'MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC'`.

Tracked as follow-up work in [DISTRIBUTION-PLAN](docs/plans/DISTRIBUTION-PLAN.md).

---

## Full license texts

### MIT License

Applies to SharpLsp and every MIT-licensed component above. Each copyright
holder is named in the tables; the permission text is identical:

```
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Apache License 2.0

Applies to Serilog and Serilog.Sinks.File. Full text:
https://www.apache.org/licenses/LICENSE-2.0. Its attribution/NOTICE obligations
are satisfied by this file; no NOTICE file is distributed by those packages.
