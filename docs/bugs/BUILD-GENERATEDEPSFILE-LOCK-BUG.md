# BUILD-GENERATEDEPSFILE-LOCK — `GenerateDepsFile` fails: deps.json "used by another process"

- **Status:** RESOLVED (2026-06-22) — see [Resolution](#resolution)
- **Severity:** Critical — blocks `dotnet build` of a sidecar project
- **Date logged:** 2026-06-22
- **Reporter:** Christian Findlay
- **Tracking:** GitHub issue [#111](https://github.com/Nimblesite/SharpLsp/issues/111)
- **Area:** Build / .NET sidecars (`sidecars/SharpLsp.Sidecar.Common`)
- **Reproducibility:** Intermittent (file-lock race)

## Resolution

`SharpLsp.Sidecar.Common` is a **referenced-only class library** — its `deps.json`
is never read at runtime (the executable sidecar `SharpLsp.Sidecar.CSharp` and the
test project each generate their own `deps.json`, which already enumerate Common's
dependency graph). That unused artifact existed only to be re-written into `bin/`
on every build, where a transient holder (build-server node / Spotlight indexer)
could lock it and fail the `GenerateDepsFile` task with MSB4018.

**Fix:** set `<GenerateDependencyFile>false</GenerateDependencyFile>` on the Common
library ([sidecars/SharpLsp.Sidecar.Common/SharpLsp.Sidecar.Common.csproj](../../sidecars/SharpLsp.Sidecar.Common/SharpLsp.Sidecar.Common.csproj)).
No `deps.json` is generated for Common, so the lock-prone write — and the MSB4018
failure — can no longer occur for this project.

**Test:** [tests/build_deps_file_e2e.rs](../../tests/build_deps_file_e2e.rs) —
`common_library_disables_dependency_file_generation` evaluates the real `.csproj`
via `dotnet msbuild -getProperty:GenerateDependencyFile` and asserts it is `false`
(failed pre-fix with `true`, passes post-fix).

**Verification:** full `SharpLsp.Sidecars.sln` build succeeds (0 warnings, 0 errors);
Common emits its DLL but no `deps.json`; `SharpLsp.Sidecar.CSharp.deps.json` still
lists Common (runtime unaffected).

**Follow-up (not blocking):** executable projects (CSharp/FSharp sidecars) legitimately
need a `deps.json` and could still hit the same transient lock. If it recurs there,
apply the systemic mitigation (disable MSBuild server / node reuse for repo + CI
builds) tracked in the original analysis below.

## Symptom

Building the Common sidecar project on its own fails during the
`GenerateDepsFile` MSBuild task with an `IOException` saying the generated
`deps.json` is locked by another process.

```
dotnet build sidecars/SharpLsp.Sidecar.Common/SharpLsp.Sidecar.Common.csproj

/usr/local/share/dotnet/sdk/10.0.203/Sdks/Microsoft.NET.Sdk/targets/Microsoft.NET.Sdk.targets(308,5): error MSB4018:
  The "GenerateDepsFile" task failed unexpectedly.
  System.IO.IOException: The process cannot access the file
  '.../sidecars/SharpLsp.Sidecar.Common/bin/Debug/net10.0/SharpLsp.Sidecar.Common.deps.json'
  because it is being used by another process.
     at Microsoft.Win32.SafeHandles.SafeFileHandle.Init(...)
     at System.IO.File.Create(String path)
     at Microsoft.NET.Build.Tasks.GenerateDepsFile.WriteDepsFile(String depsFilePath)
     at Microsoft.NET.Build.Tasks.TaskBase.Execute()

Build failed with 1 error(s) in 2.9s
```

## Reproduction (as observed)

1. Build the whole sidecar solution — **succeeds**:
   `dotnet build sidecars/SharpLsp.Sidecars.sln`
2. Immediately build the Common project alone — **fails** with the error above:
   `dotnet build sidecars/SharpLsp.Sidecar.Common/SharpLsp.Sidecar.Common.csproj`

The failure does not reproduce every time — a subsequent build wrote the file
successfully (it is present on disk, 8906 bytes), confirming a transient lock
rather than a permanently held handle.

## Environment

- **OS:** macOS (Darwin 25.5.0), arm64
- **.NET SDK:** 10.0.203
- **Target:** `net10.0`
- **Project:** `SharpLsp.Sidecar.Common` (class library — no `OutputType`)

## Diagnostics captured at time of failure

- No process was holding the `deps.json` by the time `lsof` ran (lock had already
  been released — consistent with a transient/race lock).
- A persistent Roslyn build-server node was alive and had started right around
  the failing build:
  `…/sdk/10.0.203/Roslyn/bincore/VBCSCompiler -pipename:…` (started ~21:02).
- Several **long-running SharpLsp sidecar processes** were running, but all from
  the **installed VS Code extension** directories
  (`~/.vscode/extensions/nimblesite.sharplsp-*/bin/all/sharplsp-sidecar-*`),
  **not** from the repo's `bin/Debug` output. These therefore do not hold a
  handle on the repo's `deps.json` and are not the direct cause, though they
  confirm sidecars are designed to be long-lived.

## Suspected root cause

A race on the freshly written `bin/Debug/net10.0/SharpLsp.Sidecar.Common.deps.json`:
`GenerateDepsFile` calls `File.Create` while another process still has a handle
open on the just-emitted file. On macOS the most likely transient holders are:

1. **Persistent build-server / compiler node** (`VBCSCompiler`, MSBuild node
   reuse) carrying handles to project outputs across back-to-back builds — note a
   live `VBCSCompiler` was observed at failure time.
2. **Spotlight / file indexing** (`mdworker`/`mds`) momentarily opening the newly
   created `.deps.json`.
3. **Concurrent writers** to the same output path — e.g. the IDE's background
   build (or an in-flight build-server request) overlapping the CLI build of the
   same project right after a full-solution build.

The intermittency, the prior full-solution build, and the live build-server node
together point at handle reuse / indexing rather than a SharpLsp code defect.

## Workarounds (not yet verified as fixes)

- Disable build-server/node reuse for the failing build:
  `dotnet build … /nodeReuse:false /p:UseRazorBuildServer=false` and/or
  `dotnet build-server shutdown` before rebuilding.
- Re-run the build (the lock is transient and usually clears on retry).
- `export DOTNET_CLI_USE_MSBUILD_SERVER=0` for repo builds.
- Exclude `**/bin/` and `**/obj/` from Spotlight indexing for this workspace.

## Proposed fix / next steps

- [ ] Reproduce deterministically (tight loop alternating solution build then
      single-project build; vary `nodeReuse`/build-server on and off).
- [ ] Confirm which process holds the handle (`lsof` in a loop, or `fs_usage`
      filtered on `deps.json` during the build) — distinguish build-server vs.
      `mdworker`.
- [ ] If build-server/node reuse is the cause, standardize repo builds (Makefile
      / CI) on `nodeReuse:false` or `DOTNET_CLI_USE_MSBUILD_SERVER=0`, and keep
      `.devcontainer`/`ci.yml` in sync per CLAUDE.md.
- [ ] Consider a build-output exclusion from indexing as a developer-environment
      note in the README.
- [ ] Do **not** kill VS Code processes as part of any fix (CLAUDE.md hard rule).

## Notes

Per CLAUDE.md this repo does not use Git/GitHub issues for tracking, so this bug
is logged here under `docs/bugs/`. Move to `docs/specs`/`docs/plans` only if it
turns into a structural change to the build setup.
