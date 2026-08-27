# SharpLsp Debugging Technical Specification `[DEBUG-SPEC]`

## Mission `[DEBUG-MISSION]`

SharpLsp debugging MUST use redistributable open-source components, work through DAP in any editor, and provide the same specified behavior for C# and F#. The proprietary `vsdbg` binary MUST NOT be distributed or invoked.

## Debugger Adapter Selection `[DEBUG-ADAPTER]`

### Phase Four Adapter `[DEBUG-ADAPTER-NETCOREDBG]`

Phase Four uses the MIT-licensed netcoredbg `3.2.0-1092` adapter over DAP `1.71.0` on stdin/stdout. Phase Five replaces it with the native SharpLsp Debug Sidecar in [DEBUG-ARCHITECTURE-SIDECAR].

### netcoredbg Gaps `[DEBUG-ADAPTER-GAPS]`

| Gap | Impact | Upstream Issue |
|---|---|---|
| `[DebuggerDisplay]` attribute not rendered | Variables panel shows raw object fields, not user-friendly display | SharpDbg comparison confirms absent |
| `[DebuggerTypeProxy]` not supported | Custom collection expansion (e.g., `Dictionary<K,V>`) broken | SharpDbg comparison confirms absent |
| `[DebuggerBrowsable]` not supported | All members displayed regardless of browse attribute | SharpDbg comparison confirms absent |
| No logical async call stack reconstruction | Physical stack only; `MoveNext` frames instead of logical `await` chain | Community pain point |
| Expression evaluator incomplete (LINQ, complex lambdas fail) | Watch window workflows break on real enterprise code | Long-standing limitation |
| No logpoints (tracepoints) | Cannot inject trace messages without pausing execution | No upstream issue tracked |
| No data breakpoints | Cannot break on field/property value changes | Not in roadmap |
| Edit and Continue: Linux/macOS not supported | .NET 8+ runtime supports EnC on Linux/macOS; no open-source client generates deltas | Issue #214 (open) |
| No return value display | Cannot inspect method return values on step-over | Not documented upstream |
| Attach to process: unreliable | `0x80070057` error; intermittent attach failures | Issue #205 |
| macOS ARM64: no official binaries | Requires building from source; no Samsung CI | No upstream commitment |
| musl/Alpine: SIGSEGV on startup | CoreCLR `EnsureStackSize` check overruns musl's fixed 1.5MB thread stack | Issue #201, dotnet/runtime#103741 |
| No parallel stacks data | Multi-threaded debugging crippled — can't visualize all thread stacks at once | Not documented |
| C# 12 primary constructor params not inspectable | Compiler-generated fields not mapped back to source syntax | Issue #203 |
| `Nullable<T>` expansion broken | `Nullable<Guid>` and similar value types cannot be expanded in debugger | Issue #213 |

SharpDbg `0.1.0-preview5` MAY replace a from-scratch Phase Five sidecar only after it gains lambda stepping and Source Link support and passes SharpLsp DAP acceptance tests. ICorDebug wrapper fixes SHOULD go upstream; SharpLsp MUST NOT maintain a product fork.

## Architecture `[DEBUG-ARCHITECTURE]`

The current Phase Four factory and resolver in [`debug.ts`](../../src/editors/vscode/src/debug.ts) launch netcoredbg and are covered by [`debug-e2e.test.ts`](../../src/editors/vscode/src/test/suite/debug-e2e.test.ts). The target Rust `DapRouter` proxies netcoredbg or the Phase Five C# Debug Sidecar; both control CoreCLR through ICorDebug/DbgShim.

### Rust DapRouter `[DEBUG-ARCHITECTURE-ROUTER]`

Target `DapRouter` responsibilities:

- **Adapter lifecycle**: spawn and monitor netcoredbg or the Debug Sidecar; restart crashes with exponential backoff
- **DAP proxy**: forward messages between the editor and active adapter
- **Capability augmentation**: amend `initialize` responses for proxy-layer features
- **Logpoint emulation**: translates DAP `setBreakpoints` logpoint requests into conditional breakpoints that evaluate + log + continue (Phase 4)
- **Async stack enrichment**: post-processes `stackTrace` responses by reconstructing logical async frames using state-machine field analysis via the C# sidecar (Roslyn)
- **DebuggerDisplay emulation**: in Phase 4, queries the C# sidecar to evaluate `[DebuggerDisplay]` format strings and rewrites `variables` responses with user-friendly display values
- **Multi-session management**: track active sessions for multi-process/multi-project debugging
- **Hot Reload coordination**: integrate `dotnet watch` / `MetadataUpdater.ApplyUpdate`

### netcoredbg Integration (Phase Four) `[DEBUG-ARCHITECTURE-NETCOREDBG]`

- **Distribution**: [`debug.ts`](../../src/editors/vscode/src/debug.ts) resolves a configured path, bundled platform artifact, standard user install, or `PATH`; downloaded artifacts require SHA-256 verification
- **Version pinning**: [`tools/vsix/fetch-netcoredbg.sh`](../../tools/vsix/fetch-netcoredbg.sh) pins `3.2.0-1092`; upgrades require the debug end-to-end suite
- **Transport**: DAP over stdin/stdout; DapRouter opens the child process and pipes JSON-RPC
- **Launch modes**:
  - `launch`: spawn a new .NET process
  - `attach`: attach to an existing PID (known reliability issues; see [DEBUG-GAPS])
- **Platform matrix**:

| Platform | Source | Notes |
|---|---|---|
| Linux x64 | Official Samsung release binary | Full feature set including interop debugging |
| Linux ARM64 | Official Samsung release binary | Full feature set |
| Linux ARM / RISCV64 | Official Samsung release binary | Managed debugging; validate architecture-specific release availability |
| macOS x64 | Official Samsung release binary | No interop/native debugging |
| macOS ARM64 | SharpLsp CI build from source | Samsung does not ship official ARM64 macOS binaries |
| Windows x64 | Official Samsung release binary | Full feature set |
| Windows x86 | Official Samsung release binary | Full feature set |
| Windows ARM64 | Official Samsung release binary | Full feature set |
| Alpine/musl x64 | SharpLsp CI musl-linked build | Workaround for SIGSEGV on musl; see [DEBUG-GAPS] |
| Alpine/musl ARM64 | SharpLsp CI musl-linked build | Same musl workaround |

### SharpLsp Debug Sidecar (Phase Five) `[DEBUG-ARCHITECTURE-SIDECAR]`

A Tier 4 C# process implements DAP and controls CoreCLR through ICorDebug:

- **Runtime**: C# sidecar targeting `net10.0`
- **Core dependency**: [`ClrDebug`](https://github.com/lordmilko/ClrDebug) v0.3.4+ MIT wrappers for ICorDebug COM interfaces; .NET 8+ uses source-generated COM interop
- **Bootstrap**: `Microsoft.Diagnostics.DbgShim` NuGet package (v9.0.661903+, MIT) for runtime discovery and ICorDebug bootstrapping
- **Protocol**: DAP over stdin/stdout, interchangeable with netcoredbg behind `DapRouter`
- **IPC with Rust host**: MessagePack over Unix socket / named pipe for side-channel requests (async stack analysis, expression compilation via Roslyn, DebuggerDisplay/TypeProxy evaluation)
- **Expression evaluation**: compile through the Tier 2 Roslyn sidecar and evaluate returned IL via `ICorDebugEval`
- **Async stack reconstruction**: traverse state-machine heap fields through `ICorDebugValue`
- **DebuggerDisplay/TypeProxy**: evaluate attribute formats in the debuggee context

## DAP Protocol `[DEBUG-PROTOCOL]`

SharpLsp targets **DAP specification version 1.71.0**.

### Key Capabilities `[DEBUG-PROTOCOL-CAPABILITIES]`

| Capability | Phase 4 | Phase 5 | Notes |
|---|---|---|---|
| `supportsConditionalBreakpoints` | Yes | Yes | C# expression condition |
| `supportsHitConditionalBreakpoints` | Yes | Yes | `>`, `>=`, `==`, `%` operators |
| `supportsLogPoints` | Yes (emulated) | Yes (native) | Phase 4: conditional bp + continue |
| `supportsEvaluateForHovers` | Yes | Yes | Expression evaluation in hover |
| `supportsSetVariable` | Yes | Yes | Modify variable values at breakpoint |
| `supportsRestartFrame` | No | Yes | Phase 5: `ICorDebugILFrame::SetIP` |
| `supportsStepBack` | No | No | P3 — post Phase 5; requires runtime support |
| `supportsExceptionOptions` | Yes | Yes | Filter by type, user code, etc. |
| `supportsDataBreakpoints` | No | Yes | Phase 5: field value polling / hardware watchpoints |
| `supportsReadMemoryRequest` | No | Yes | Phase 5: raw memory inspection |
| `supportsWriteMemoryRequest` | No | Yes | Phase 5: raw memory write |
| `supportsDisassembleRequest` | Partial | Yes | Phase 5: `ICorDebugCode::GetCode` → IL |
| `supportsTerminateRequest` | Yes | Yes | |
| `supportsRestartRequest` | Yes | Yes | |
| `supportsSingleThreadExecutionRequests` | No | Yes | Phase 5 |
| `supportsInstructionBreakpoints` | No | Yes | Phase 5: IL offset breakpoints |
| `supportsCompletionsRequest` | No | Yes | Phase 5: via Roslyn C# sidecar |
| `supportsVariableType` | Yes | Yes | |
| `supportsANSIStyling` | Yes | Yes | DAP 1.69+ terminal color output |
| `supportsGotoTargetsRequest` | Yes | Yes | Run to cursor via `goto` |
| `supportsLocationReference` | No | Yes | DAP 1.68+ location navigation |

## Feature Specification `[DEBUG-FEATURES]`

### Launch and Attach `[DEBUG-FEATURES-LAUNCH]`

| Feature | DAP Method | Priority | Notes |
|---|---|---|---|
| Launch .NET app (console, web, etc.) | `launch` | P1 | Pass args, env, cwd, program |
| Attach to running process by PID | `attach` | P1 | Known reliability issues in netcoredbg; fixed in Debug Sidecar |
| Attach to running process by name | `attach` (processName) | P2 | SharpLsp resolves name → PID |
| Remote attach via SSH tunnel | `attach` (remote) | P2 | SharpLsp manages SSH tunnel transparently |
| Launch with environment variables | `launch` (env) | P1 | |
| Launch with custom working directory | `launch` (cwd) | P1 | |
| Launch browser for Blazor WASM | `launch` (browser) | P3 | Requires browser devtools bridge |
| Hot Reload enabled launch | `launch` (hotReload: true) | P2 | See [DEBUG-FEATURES-HOT-RELOAD] |
| Child process auto-attach | `launch` event | P2 | Phase 5: `ICorDebugManagedCallback::CreateProcess` |

**Launch configuration schema** (`launch.json` / inline config):

```json
{
  "type": "sharplsp-coreclr",
  "request": "launch",
  "program": "${workspaceFolder}/bin/Debug/net10.0/MyApp.dll",
  "args": [],
  "cwd": "${workspaceFolder}",
  "env": {},
  "stopAtEntry": false,
  "console": "integratedTerminal",
  "hotReload": false,
  "justMyCode": true,
  "requireExactSource": true,
  "symbolOptions": {
    "searchPaths": [],
    "searchMicrosoftSymbolServer": false
  }
}
```

**Attach configuration schema:**

```json
{
  "type": "sharplsp-coreclr",
  "request": "attach",
  "processId": "${command:pickProcess}",
  "justMyCode": true
}
```

### F5 with no launch.json `[DEBUG-FEATURES-LAUNCH-NOCONFIG]`

When the user presses F5 (or Ctrl/Cmd+F5) in a workspace with no `.vscode/launch.json`, VS Code calls `resolveDebugConfiguration` with a bare object built by `Object.create(null)`. `type`, `request` and `name` are **absent**, not empty strings. The `DebugConfiguration` TypeScript declaration marks them non-optional `string` and is wrong on this path, so the compiler cannot catch a `.length` dereference.

| Input the provider must accept | Meaning |
|---|---|
| `{}` | F5, no launch.json, debug |
| `{ noDebug: true }` | Ctrl/Cmd+F5, no launch.json — see [DEBUG-FEATURES-LAUNCH-NODEBUG] |
| `{ type: undefined, request: undefined, name: undefined }` | Same shape after JSON transport |
| `{ type: '', request: '', name: '' }` | Legacy shape; still accepted |

**Rules**

1. Detect "no configuration supplied" by **absence** (`!config.type && !config.request && !config.name`), never by `.length`. Dereferencing `.length` on an absent field throws `TypeError: Cannot read properties of undefined (reading 'length')`, which rejects the provider promise and surfaces as an error notification instead of a session.
2. The provider MUST NOT throw for any input, including a malformed `launchSettings.json`. A configuration it cannot service is reported by returning `undefined` (prevent the session, after showing a named message) or `null` (prevent the session and open `launch.json`).
3. Any returned configuration MUST carry a non-empty `type` and a `request` of exactly `launch` or `attach`. VS Code discards a returned config with a falsy `type` **silently** — no session, no error.
4. `resolveDebugConfiguration` MUST be **idempotent**. VS Code re-enters the resolve chain whenever the provider changes `config.type`, calling the provider a second time with the config it just produced. The second pass MUST return an equivalent configuration and MUST NOT duplicate `args` or re-apply profile values.
5. The synthesized configuration MUST target the document-derived program of [DEBUG-FEATURES-LAUNCH-TARGET] and MUST NOT reference a `preLaunchTask` type SharpLsp does not contribute — see [DEBUG-FEATURES-LAUNCH-BUILD].

**Synthesized configuration**

```json
{
  "type": "sharplsp-coreclr",
  "request": "launch",
  "name": "Launch .NET Project",
  "program": "<resolved by [DEBUG-FEATURES-LAUNCH-TARGET]>",
  "cwd": "<project directory>",
  "console": "integratedTerminal",
  "justMyCode": true
}
```

Activation MUST NOT depend on `onStartupFinished` for this path: `onDebugResolve:sharplsp-coreclr` MUST be declared so the provider is registered before VS Code enters the resolve chain.

### Launch target resolution `[DEBUG-FEATURES-LAUNCH-TARGET]`

One resolver decides what F5, Ctrl/Cmd+F5, the editor context menu and the Solution Explorer all launch. There MUST NOT be a second, divergent walk.

**Resolution order**

| # | Source | Condition |
|---|---|---|
| 1 | Explicit `program` in the configuration | Always wins; never overwritten |
| 2 | Cone search from the active document's directory | An editor is open |
| 3 | Solution startup project | A `.sln`/`.slnx` is loaded and names one |
| 4 | The workspace folder's single runnable project | Exactly one candidate |
| 5 | Fail with a named message | Otherwise |

**Cone search** reuses [SCRIPT-CONE] verbatim. It walks from the document's directory toward the filesystem root and stops at the **first** of:

- a directory containing `*.sln`, `*.slnx`, `*.csproj` or `*.fsproj`;
- the workspace folder root supplied by the client;
- a directory containing `.git`;
- the filesystem root.

The walk MUST NOT escape the workspace folder. Comparing the current directory to the stop directory by string equality alone is insufficient: a start path outside the stop path never matches and the walk runs to `/`, potentially selecting an unrelated project from an ancestor directory. The boundary MUST be a containment test on normalized, real (symlink-resolved) paths, case-insensitive on Windows.

**Ambiguity**

| Situation | Required behaviour |
|---|---|
| Two or more runnable projects in the resolved directory | Prompt with a QuickPick listing project file names; cancelling starts nothing |
| Two or more runnable projects in the workspace, no active document | Prompt; cancelling starts nothing |
| Zero runnable projects | Exactly one warning: `No runnable .NET project or script found for the active document.` |
| Active document outside every workspace folder | Exactly one warning; MUST NOT silently fall back to `workspaceFolders[0]` |
| No active editor and no unambiguous startup project | Exactly one warning; MUST NOT start a session |

A **runnable project** is one whose build output is an executable assembly — an `OutputType` of `Exe` or `WinExe`, evidenced on disk by a `<name>.runtimeconfig.json` beside `<name>.dll`. A library MUST NOT be offered as a launch target.

### Build and output resolution before launch `[DEBUG-FEATURES-LAUNCH-BUILD]`

**Output path resolution**

The assembly path MUST come from MSBuild, never from a guessed directory layout:

```
dotnet msbuild <project> -getProperty:TargetPath -getProperty:TargetFramework -getProperty:OutputType
```

| Case | Requirement |
|---|---|
| Single-TFM project | `TargetPath` is authoritative |
| Multi-targeted project | Re-query with `-p:TargetFramework=<tfm>`; a bare `-getProperty:TargetPath` returns **empty** and exit 0 |
| Custom `AssemblyName` | Honoured — the file name is not the project name |
| Custom `OutputPath` / `BaseOutputPath` / `ArtifactsPath` | Honoured |
| `RuntimeIdentifier` set | Honoured — output gains a RID segment |
| Non-Debug configuration | Honoured |

A hardcoded TFM list (`net10.0`, `net9.0`, `net8.0`) with a fixed `bin/Debug/<tfm>/<basename>.dll` layout is non-conforming: it fails for `net7.0`, `netstandard`, custom output paths, custom assembly names and Release builds, and it returns a **non-existent path** as if it had succeeded.

**Output resolution is evidence-based and total.** Resolution yields either a
path that EXISTS on disk, or **nothing**. It MUST NOT yield a constructed path
that has not been observed.

| Project state | Resolved assembly | `cwd` |
|---|---|---|
| Built | The existing file MSBuild names | Project directory |
| Not built | **Absent** | Project directory |
| Built for a TFM other than the one requested | The existing file | Project directory |

`cwd` is always the project directory, whether or not an assembly exists — it
identifies the project, not its output. "Absent" is a first-class result meaning
*not built yet*; it is reported to the user with a named message per rule 3 and
never launched. A resolver that returns a plausible-looking path it never
verified is non-conforming even when that path would be correct after a build,
because callers cannot distinguish it from a real one.

**Multi-TFM selection**: prefer the TFM whose output already exists; if several exist, prompt; if none, use the first `TargetFrameworks` entry.

**Implicit build**

1. Launch and run MUST build first, using SharpLsp's own contributed task type `sharplsp-build`. Referencing `dotnet: build` is non-conforming — that task type is contributed by the proprietary Microsoft C# extension, and on a SharpLsp-only install VS Code fails the pre-launch step with `Could not find the task 'dotnet: build'.`
2. `contributes.taskDefinitions` MUST declare `sharplsp-build` so the task is referenceable from `tasks.json` and from `preLaunchTask`.
3. After the build step the resolved `program` MUST exist on disk. If it does not, the session MUST NOT start; show `Build produced no output for <project>.`
4. The build MUST run **once**. Invoking a terminal build and a headless build for the same request is non-conforming: two MSBuild processes race on the same `obj/` lock files.

### Run without debugging `[DEBUG-FEATURES-LAUNCH-NODEBUG]`

Ctrl/Cmd+F5 is `workbench.action.debug.start` invoked with `{ noDebug: true }`. VS Code stamps `noDebug` onto the configuration **before** the provider chain runs, so the provider observes `config.noDebug === true` and the value survives into `session.configuration.noDebug`.

| Surface | Required behaviour |
|---|---|
| Ctrl/Cmd+F5, no launch.json | Provider receives `{ noDebug: true }`; resolves exactly as F5 but the session runs without breakpoints |
| `sharplsp.runProgram` | Calls `startDebugging(folder, config, { noDebug: true })` — same resolved target as `sharplsp.debugProgram` |
| `sharplsp.debugProgram` | Calls `startDebugging(folder, config)`; the session's `noDebug` MUST NOT be `true` |

**Rules**

1. Run and debug MUST resolve the identical target. A user who can debug a project can run it, and vice versa.
2. Run MUST go through `vscode.debug.startDebugging` with `noDebug: true`, not a bare terminal, so that the session is observable, cancellable from the debug toolbar, and routed through [DEBUG-FEATURES-LAUNCH-OUTPUT]. Script targets are the sole exception — see [DEBUG-FEATURES-LAUNCH-SCRIPT].
3. `noDebug` is only ever **set** by VS Code, never cleared. Passing `{ noDebug: false }` over a configuration that already carries `noDebug: true` leaves it true; the provider MUST NOT rely on `noDebug: false` to mean "debug".
4. The return value of `startDebugging` MUST be observed. A `false` result means the session was refused; the user MUST be told, not left with a silent no-op.

### Single-file and script targets `[DEBUG-FEATURES-LAUNCH-SCRIPT]`

When [DEBUG-FEATURES-LAUNCH-TARGET]'s cone search finds no owning project, the document kind decides the run strategy per [SCRIPT-DETECT].

| Document kind | Run | Debug |
|---|---|---|
| `CSharpFileBasedApp` (`.cs`, no owning project) | `dotnet run --file <abs path>` | Supported: build with `dotnet build <abs path> --artifacts-path <dir>`, launch `<dir>/bin/<config>/<name>.dll` |
| `FSharpScript` (`.fsx`, `.fsscript`) | `dotnet fsi --exec <abs path>` | **Not supported** — named message |
| `CSharpScript` (`.csx`) | `dotnet-script <abs path>` when that tool resolves | **Not supported** — named message |
| `.csx` with no `dotnet-script` | Named message naming the missing tool | Same |
| `.fs` with no owning project | Named message — F# has no file-based-app model | Same |
| Any other language | Named message; no session, no task | Same |

**Rules**

1. Script and file-based runs MUST be dispatched as a `vscode.Task` with a `ShellExecution`/`ProcessExecution`, not by typing into a terminal. The command and arguments are then observable, the exit code is reported, and the run is cancellable.
2. The file-based-app command MUST be `dotnet run --file <abs path>`. The positional form `dotnet run <path>` is non-conforming: inside a directory that contains a project, `dotnet` runs **the project** and passes the path as an application argument, silently launching the wrong program.
3. `dotnet build <file>.cs` MUST be given an explicit `--artifacts-path`. The default output lands in a per-platform, SHA-256-keyed runfile cache whose location differs on Windows, macOS and Linux; an explicit path removes the platform split and gives the DAP `launch` request a stable `program`.
4. File-based output uses `bin/<configuration-lowercased>/<name>.dll` with **no TFM segment** — unlike a project's `bin/Debug/<tfm>/`. The two layouts MUST NOT share a path builder.
5. `.fsx` debugging is refused, not attempted. `dotnet fsi` writes no assembly and no PDB to disk (the script image is loaded from a byte array, or emitted dynamically under `--multiemit-`), so there is no `program` a `launch` request could name.
6. Every unsupported combination produces exactly one user-visible message. A silent no-op is non-conforming.
7. `<app>.run.json` is a first-party launch-profile file for file-based apps and MUST be read alongside `Properties/launchSettings.json` — see [DEBUG-FEATURES-LAUNCH-PROFILES].

### launchSettings.json profiles `[DEBUG-FEATURES-LAUNCH-PROFILES]`

**Discovery**

| Target | Profile file |
|---|---|
| Project | `<project directory>/Properties/launchSettings.json` |
| File-based app | `<entry file directory>/<name>.run.json` |

The profile file belongs to the **resolved project**, not the workspace root. A resolver that only probes `<workspaceRoot>/Properties/launchSettings.json` silently drops every environment variable, argument and URL for the near-universal `src/App/App.csproj` layout.

**Mapping**

| Profile field | Configuration field | Rule |
|---|---|---|
| `commandLineArgs` | `args` | Shell-correct tokenization — see below |
| `environmentVariables` | `env` | Merged; an explicit `env` in the configuration wins per key |
| `applicationUrl` | `env.ASPNETCORE_URLS` | Verbatim, including the `;`-separated multi-URL form |
| `commandName: "Project"` | — | Eligible |
| `commandName: "Executable"`, `"IISExpress"`, other | — | Ignored for a project launch |
| `launchBrowser`, `launchUrl` | — | Out of scope; MUST NOT crash |

**Rules**

1. Arguments MUST be tokenized with a real shell-argument parser that honours quoting and escapes. `commandLineArgs.split(' ')` is non-conforming: `--name "John Smith"` becomes three broken tokens with embedded quote characters, so any profile containing a path with a space launches with the wrong `argv`.
2. Profiles apply only to `request: "launch"`. An `attach` configuration receives no `args` and no `env`.
3. When more than one `Project` profile exists, the user picks. Silently taking the first is non-conforming.
4. Parsing MUST be total. `{"profiles": null}`, `{"profiles": "text"}`, `{"profiles": [1,2]}`, a truncated document and a missing file all yield **no profiles** and no exception. A type guard that checks only for the presence of a `profiles` key is unsound — it admits `null` and throws downstream in `Object.entries`.
5. A candidate path that exists but is not a launch-settings document MUST NOT abort the scan; the resolver continues to the next candidate.

### Debuggee output routing `[DEBUG-FEATURES-LAUNCH-OUTPUT]`

| `console` value | Destination |
|---|---|
| `internalConsole` | VS Code Debug Console; no terminal input |
| `integratedTerminal` | VS Code integrated terminal; stdin works — **default** |
| `externalTerminal` | OS terminal window |

**Rules**

1. `console` MUST be declared in `contributes.debuggers[].configurationAttributes.launch.properties` with those three values and a default of `integratedTerminal`. A console application that reads from stdin is unusable under `internalConsole`.
2. Every attribute the resolver writes MUST be declared in `configurationAttributes`. Writing `justMyCode` while leaving it undeclared makes `launch.json` IntelliSense flag a valid, extension-authored attribute as an error.
3. The launch schema declared in the manifest MUST match this specification's schema: `program`, `args`, `cwd`, `env`, `stopAtEntry`, `console`, `hotReload`, `justMyCode`, `requireExactSource`, `symbolOptions`.
4. The debug type MUST be a single value across the manifest, the constants module and this specification.

### Dynamic and initial configurations `[DEBUG-FEATURES-LAUNCH-DYNAMIC]`

`DebugConfigurationProviderTriggerKind` selects **only** when `provideDebugConfigurations` is called; it never affects `resolveDebugConfiguration`.

| Trigger kind | Calls `provideDebugConfigurations` when | Required registration |
|---|---|---|
| `Initial` (1, the default) | VS Code generates a new `launch.json` | Registered |
| `Dynamic` (2) | The user opens "Show all automatic debug configurations" / "Select and Start Debugging" | Registered |

**Rules**

1. The provider MUST be registered for **both** trigger kinds. Registered for `Initial` alone, SharpLsp never appears in the dynamic launch dropdown, so the only way to run without a `launch.json` is the F5 auto-pick.
2. `onDebugDynamicConfigurations:sharplsp-coreclr` and `onDebugResolve:sharplsp-coreclr` MUST be declared as activation events, so the provider is discoverable **before** activation rather than relying on `onStartupFinished`.
3. `contributes.debuggers[].initialConfigurations` MUST be present. It supplies the generated `launch.json` body and makes the debugger a candidate in the "Select debugger" fallback list.
4. `contributes.debuggers[].languages` drives the F5 auto-pick and MUST list every language the debugger serves.
5. `configurationSnippets` MUST agree with the resolver's own defaults. A snippet naming a target framework the resolver does not prefer teaches users a path that will not resolve.
6. `provideDebugConfigurations` MUST resolve the launch target once per invocation, not once per profile.

### Run and debug commands and menus `[DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS]`

| Command id | Title | Behaviour |
|---|---|---|
| `sharplsp.runProgram` | Run Without Debugging | [DEBUG-FEATURES-LAUNCH-NODEBUG] |
| `sharplsp.debugProgram` | Debug Program | [DEBUG-FEATURES-LAUNCH-NODEBUG] |

These ids supersede the `sharplsp.run` / `sharplsp.debug` names in [SE-ACTIONS-RUN-DEBUG]; that section is amended to match, keeping the `CMD_<NAME> = 'sharplsp.<camelCase>'` convention of the shipped `sharplsp.debugProgram`.

**Menu placement**

| Menu | Items | `when` | Group |
|---|---|---|---|
| `editor/title/run` | `sharplsp.runProgram`, `sharplsp.debugProgram` | `resourceLangId in sharplsp.runnableLangIds` | `navigation@1`, `navigation@2` |
| `editor/context` | `sharplsp.runProgram`, `sharplsp.debugProgram` | same | `navigation@1`, `navigation@2` |
| `view/item/context` | `sharplsp.runProgram`, `sharplsp.debugProgram` | `view == sharplsp.solutionExplorer && viewItem == project` | `3_run@1`, `3_run@2` |

`editor/title/run` is the "Run or Debug..." split button in the editor title bar — the surface C# Dev Kit and Python users reach for. VS Code core contributes nothing to it, so it is empty unless SharpLsp fills it; the highest-sorted item becomes the button's default action.

**Rules**

1. Both commands MUST be contributed in `contributes.commands` so they appear in the Command Palette.
2. Command ids MUST be referenced from the constants module, never as inline string literals at the registration site. A constant that names a command which is neither registered nor contributed is dead and MUST be removed.
3. Every command registered in code MUST be contributed in the manifest, and every contributed command MUST be registered.

### Breakpoints `[DEBUG-FEATURES-BREAKPOINTS]`

| Feature | DAP Method | Priority | Implementation |
|---|---|---|---|
| Line breakpoints | `setBreakpoints` | P1 | Native netcoredbg / Debug Sidecar `ICorDebugCode::CreateBreakpoint` |
| Function/method breakpoints | `setFunctionBreakpoints` | P1 | Native |
| Exception breakpoints (all / unhandled) | `setExceptionBreakpoints` | P1 | Native |
| Conditional breakpoints (C# expression) | `setBreakpoints` (condition) | P1 | netcoredbg T1/T2 expressions; Phase 5: full Roslyn eval |
| Hit-count breakpoints | `setBreakpoints` (hitCondition) | P1 | Native |
| Logpoints (tracepoints) | `setBreakpoints` (logMessage) | P1 | Emulated at DapRouter layer in Phase 4; native in Phase 5 |
| Data breakpoints (field value change) | `setDataBreakpoints` | P2 | Phase 5 only (Debug Sidecar) |
| Instruction breakpoints (IL offset) | `setInstructionBreakpoints` | P3 | Phase 5 only |

**Logpoint emulation (Phase 4):**

For Phase Four logpoints, `DapRouter` rewrites `setBreakpoints` requests containing `logMessage` as conditional breakpoints that:

1. Evaluates the interpolated log string (referencing frame-local variables)
2. Calls `System.Diagnostics.Debug.WriteLine(msg)` to emit the output
3. Returns `false` so execution is never paused

The debug output becomes a DAP `output` event. Hit conditions accept `>`, `>=`, `<`, `<=`, `==`, and `%`. Phase Five uses `ICorDebugBreakpoint`, immediate `ICorDebugEval`, and `ICorDebugProcess::Continue` without a visible pause.

### Breakpoint language contribution `[DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION]`

VS Code gates every breakpoint UI entry point — gutter click, gutter context menu, F9, conditional breakpoint, logpoint — on `canSetBreakpointsIn`, which consults the `contributes.breakpoints` set. With no entry for a language, and with the default `debug.allowBreakpointsEverywhere` of `false`, **breakpoints cannot be set in that language at all**.

```json
"breakpoints": [
  { "language": "csharp" },
  { "language": "fsharp" }
]
```

**Rules**

1. `contributes.breakpoints` MUST list `csharp` and `fsharp`. `contributes.debuggers[].languages` is a different contribution point and does not grant breakpoint permission.
2. The entries MUST be unconditional. A `when` clause tied to server state makes the breakpoint gutter appear and disappear as the language server cycles.
3. Without this contribution, F# breakpoints work only by accident — the built-in `ms-vscode.js-debug` extension happens to contribute `fsharp` — while C# breakpoints are impossible. That asymmetry inverts the project's F#-first commitment and is non-conforming.
4. `vscode.debug.addBreakpoints()` **bypasses** this gate, so a test that adds a breakpoint through the API and asserts `vscode.debug.breakpoints.length` passes while the product is broken. Conformance is asserted against the manifest contribution itself.

### Stepping `[DEBUG-FEATURES-STEPPING]`

| Feature | DAP Method | Priority |
|---|---|---|
| Step over | `next` | P1 |
| Step into | `stepIn` | P1 |
| Step out | `stepOut` | P1 |
| Step back (reverse) | `stepBack` | P3 — post Phase 5; requires runtime support |
| Restart frame | `restartFrame` | P2 — Phase 5 |
| Run to cursor (temporary breakpoint) | `goto` | P2 |
| Just My Code (skip non-user code) | launch config | P1 |
| Smart Step Into (F# pipelines) | `stepIn` (targetId) | P2 — Phase 5 |

With `justMyCode: true`, Phase Five excludes methods/types marked `[DebuggerNonUserCode]`, `[DebuggerHidden]`, or `[GeneratedCode]`, matching vsdbg.

For F# lines with multiple calls, Phase Five returns FCS-derived DAP `stepIn` targets keyed by `targetId`.

### Call Stack `[DEBUG-FEATURES-STACK]`

| Feature | DAP Method | Priority | Notes |
|---|---|---|---|
| Call stack display | `stackTrace` | P1 | Physical frames |
| Logical async call stack | `stackTrace` (enriched) | P1 | DapRouter + Roslyn reconstruction ([DEBUG-FEATURES-STACK-ASYNC]) |
| Navigate to source from frame | `source` | P1 | |
| Load symbols on demand | — | P2 | PDB loading, symbol server |
| Decompiled source navigation | — | P2 | ICSharpCode.Decompiler in C# sidecar |
| Parallel Stacks data | custom `sharplsp/parallelStacks` | P2 | Phase 5: enumerate all thread stacks |

#### Async Call Stack Reconstruction `[DEBUG-FEATURES-STACK-ASYNC]`

netcoredbg reports physical `MoveNext` frames. `DapRouter` and the C# sidecar reconstruct the logical chain:

1. On `stopped`, request `stackTrace` and find types matching `<MethodName>d__N`.
2. Send each type and its frame-local `this` address to the C# sidecar.
3. Resolve the type with Roslyn; read `<>1__state`, `<>4__this`, and continuation fields through `ICorDebugObjectValue::GetFieldValue`.
4. Follow `_continuation`/`MoveNextRunner` from `AsyncTaskMethodBuilder._builder`.
5. Inject the logical frames before forwarding `stackTrace`.

If compiler-generated fields cannot be resolved, the response retains the physical stack unchanged.

Phase Five reads continuation chains directly through `ICorDebugProcess::ReadMemory`, without a Roslyn compilation model.

### Variables and Inspection `[DEBUG-FEATURES-VARIABLES]`

| Feature | DAP Method | Priority |
|---|---|---|
| Local variables | `variables` | P1 |
| Function arguments | `variables` | P1 |
| `this` / instance members | `variables` | P1 |
| Static fields | `variables` | P1 |
| Collection/array expansion | `variables` (structured) | P1 |
| `[DebuggerDisplay]` attribute rendering | `variables` | P1 |
| `[DebuggerTypeProxy]` expansion | `variables` | P2 |
| `[DebuggerBrowsable]` attribute | `variables` | P2 |
| Modify variable value at runtime | `setVariable` | P1 |
| Hover expression evaluation | `evaluate` (hover) | P1 |
| Watch window evaluation | `evaluate` (watch) | P1 |
| Immediate window / REPL | `evaluate` (repl) | P2 |
| Return value display on step-over | custom scope | P2 — Phase 5 |
| Raw memory view | `readMemory` / `writeMemory` | P3 — Phase 5 |
| F# discriminated union inspection | `variables` | P1 |
| F# record/tuple inspection | `variables` | P1 |

**DebuggerDisplay emulation (Phase 4):**

For Phase Four, `DapRouter` asks the C# sidecar to evaluate `[DebuggerDisplay]` formats against the frame and replaces the `variables` response's default `toString()` value. Failure falls back to the raw class name.

**Expression evaluation quality tiers:**

| Tier | Scenario | Phase 4 (netcoredbg) | Phase 5 (Debug Sidecar) |
|---|---|---|---|
| T1 | Simple field/property access | Works | Works |
| T1 | Arithmetic, string concat | Works | Works |
| T1 | Null checks, type casts | Works | Works |
| T2 | Method calls on locals | Works | Works |
| T2 | Extension methods | Partial | Works |
| T3 | LINQ queries on live objects | Fails | Works (Roslyn → ICorDebugEval) |
| T3 | Multi-statement lambdas | Fails | Works |
| T3 | Generic type inference in expressions | Fails | Works |
| T3 | `dynamic` type evaluation | Fails | Partial |

For T3, the Debug Sidecar loads C#-sidecar `CSharpScriptCompilation` output into the debuggee and evaluates it through `ICorDebugEval`.

### Exception Handling `[DEBUG-FEATURES-EXCEPTIONS]`

| Feature | Priority |
|---|---|
| Break on all CLR exceptions | P1 |
| Break on unhandled exceptions only | P1 |
| Break on specific exception types (include/exclude filter) | P1 |
| Break on exceptions from user code only | P1 |
| Exception info panel (type, message, stack) | P1 |
| Inner exception chain traversal | P2 |
| Exception conditions (break only if message matches) | P2 — Phase 5 |

Configuration via `setExceptionBreakpoints` with `filterOptions` and `exceptionOptions` per the DAP 1.71.0 specification.

### Hot Reload During Debug `[DEBUG-FEATURES-HOT-RELOAD]`

SharpLsp uses cross-platform `.NET Hot Reload` (`MetadataUpdater.ApplyUpdate`, .NET 6+) exclusively. It MUST NOT run alongside debugger-based Edit and Continue; no open-source client currently generates `ICorDebugModule2::ApplyChanges` deltas for Linux/macOS (netcoredbg #214).

**Architecture:**

1. During an active session, the VFS detects a save.
2. Roslyn `WatchHotReloadService` produces metadata, IL, and PDB deltas.
3. `DapRouter` applies them through DAP `evaluate` injection in Phase Four or directly in Phase Five.
4. Subsequent calls use the new IL without interrupting the session.
5. Unsupported rude edits report the reason and prompt a restart.

**Supported hot reload edits:**

| Edit Type | Supported |
|---|---|
| Method body change | Yes |
| Add new method to existing type | Yes (.NET 8+) |
| Add new static field | Yes (.NET 8+) |
| Add new class (non-generic) | Yes (.NET 8+) |
| Change method signature | No — requires restart |
| Add/remove generic type parameter | No — requires restart |
| Modify lambda captured variables | No — requires restart |
| Change inheritance hierarchy | No — requires restart |

### Multi-Process and Multi-Project Debugging `[DEBUG-FEATURES-MULTIPROCESS]`

| Feature | Priority |
|---|---|
| Multiple simultaneous debug sessions | P2 |
| Automatic child process attach | P2 |
| Microservices compound launch | P2 |
| Docker container attach | P2 |
| WSL process attach (Windows) | P3 |

`DapRouter` indexes independent adapter processes by session ID. Session-prefixed DAP messages multiplex them; compound configs start multiple named sessions.

### Remote Debugging `[DEBUG-FEATURES-REMOTE]`

SharpLsp creates the SSH tunnel; DapRouter connects to its local forwarded socket.

| Step | Action |
|---|---|
| 1 | SharpLsp SSH's to remote host, uploads netcoredbg or Debug Sidecar binary |
| 2 | SharpLsp starts the adapter on the remote host listening on a local port |
| 3 | SharpLsp creates an SSH local port-forward for that port |
| 4 | DapRouter connects to the local end of the tunnel |
| 5 | Source files are mapped from remote paths to local paths via `sourceFileMap` config |

**Remote attach configuration:**

```json
{
  "type": "sharplsp-coreclr",
  "request": "attach",
  "processId": 1234,
  "remote": {
    "host": "prod-server.example.com",
    "port": 22,
    "user": "deploy"
  },
  "sourceFileMap": {
    "/app": "${workspaceFolder}"
  }
}
```

### Test Debugging `[DEBUG-FEATURES-TESTS]`

| Feature | Protocol | Priority |
|---|---|---|
| Debug individual test | DAP + `sharplsp/testDebug` | P1 |
| Debug test with args/env override | DAP + `sharplsp/testDebug` | P2 |
| Breakpoints inside test methods | Standard line breakpoints | P1 |
| Just My Code in test context | launch config | P1 |
| Debug entire test class/suite | DAP + `sharplsp/testDebug` | P2 |
| Expecto/FsCheck test debugging | DAP + `sharplsp/testDebug` | P1 (F# parity) |

For test debugging, SharpLsp sets `VSTEST_HOST_DEBUG=1` and attaches to the waiting `testhost.exe`/`dotnet-testhost` child, not the parent `dotnet test` process.

### Diagnostic Tools Integration `[DEBUG-FEATURES-DIAGNOSTICS]`

SharpLsp exposes dotnet/diagnostics `9.0.661903+` tools through DAP custom messages:

| Feature | Tool | DAP Integration | Priority |
|---|---|---|---|
| CPU sampling profiler | `dotnet-trace` (EventPipe) | `sharplsp/profileStart` custom event | P2 |
| Memory allocation profiler | `dotnet-gcdump` + `dotnet-trace` | `sharplsp/heapSnapshot` custom event | P2 |
| GC heap snapshot | `dotnet-gcdump` | `sharplsp/gcDump` custom event | P2 |
| Live counters (CPU, GC, requests/sec) | `dotnet-counters` | `sharplsp/counters` streaming event | P2 |
| Process dump on crash | `dotnet-dump` | Auto-triggered on unhandled exception | P3 |
| Dump analysis | `dotnet-dump analyze` + SOS | `sharplsp/analyzeDump` custom request | P3 |

The editor presents these events in a diagnostics panel. See [`PROFILER-SPEC.md`](PROFILER-SPEC.md) for profiling behavior.

`Microsoft.Diagnostics.NETCore.Client` ships musl/Alpine builds, so diagnostic tools MUST remain available there even when netcoredbg cannot start.

## F# Behavior `[DEBUG-FSHARP]`

### Compiler PDB Gaps `[DEBUG-FSHARP-PDB]`

The F# compiler does not emit the following PDB tables that debuggers rely on:

| Missing Table | Impact | Upstream Issue |
|---|---|---|
| `StateMachineMethod` | Step-into `task {}` requires two Step Into presses; debugger cannot map `MoveNext` to source cleanly | dotnet/fsharp#12000 (open) |
| `StateMachineHoistedLocalScopes` | Hoisted local variables in async/task state machines lack scope info | Tracked alongside above |
| `LocalConstants` | Constant values not in PDB | Minor impact |
| `DynamicLocalVariables` | Dynamic-typed locals lose type info | Minor impact |

**SharpLsp's approach:**

- Phase 4: implement heuristic PDB mapping for F# state machines via FCS sidecar symbol analysis
- Phase 5: contribute `StateMachineMethod` table emission to dotnet/fsharp; until accepted, maintain SharpLsp-local patch or workaround

### Computation Expression Stepping `[DEBUG-FSHARP-STEPPING]`

F# `async { }` desugars into CPS (continuation-passing style) library calls. Stepping behavior reflects the desugared form, not the source. This is documented as a known limitation.

`task { }` resumable state machines use the C# reconstruction algorithm with F#-specific generated-name matching. Legacy CPS-based `async { }` reconstruction is best-effort and retains the physical stack when its continuation chain cannot be followed. Internal SharpLsp debug tests SHOULD prefer `task { }`.

**Smart Step Into (Phase 5)**: Uses DAP `stepIn` with `targetId` to let users choose which function to step into when F# pipelines or function composition calls multiple functions on one line.

### Discriminated Union Inspection `[DEBUG-FSHARP-UNIONS]`

DUs compile to class hierarchies. Without F# semantic knowledge, a variable `Some 42` displays as ``FSharpOption`1 { Tag = 1, Value = 42 }`` instead of `Some(42)`.

SharpLsp addresses this in three layers:

1. **Phase 4 DapRouter**: queries FCS sidecar for DU type metadata; rewrites `variables` response display values to F# syntax
2. **Phase 5 Debug Sidecar**: native DU-aware `variables` formatting via FCS sidecar channel
3. **Longer term**: contribute `[DebuggerDisplay]` attribute emission in F# compiler for DU cases

### Mailbox Processor Inspection `[DEBUG-FSHARP-MAILBOX]`

For `MailboxProcessor<'Msg>`, SharpLsp exposes:

- Current message queue depth as a pseudo-variable in the variables panel (Phase 5)
- Ability to inspect pending messages (Phase 5, best-effort)

### Expression Evaluation `[DEBUG-FSHARP-EVALUATION]`

- Phase 4: limited to T1/T2 tier (same as C#; F# syntax not supported — user must use compiled IL names)
- Phase 5: route `evaluate` requests to FCS sidecar for F# expression compilation, then evaluate via `ICorDebugEval`

## Gap Closure `[DEBUG-GAPS]`

| Area | Phase Four | Phase Five or later |
|---|---|---|
| Async stacks | Best-effort DapRouter and C# sidecar enrichment per [DEBUG-FEATURES-STACK-ASYNC] | Direct continuation traversal |
| Expression evaluation | netcoredbg T1/T2 | Roslyn `ScriptingWorkspace` to `ICorDebugEval` |
| Debugger attributes | DapRouter emulates `[DebuggerDisplay]` | Native `[DebuggerDisplay]`, `[DebuggerTypeProxy]`, and `[DebuggerBrowsable]` |
| Attach error `0x80070057` | Retry with exponential backoff and contribute issue #205 upstream | Race-free `DbgShim.RegisterForRuntimeStartup` |
| macOS ARM64 | CI-built `darwin-arm64` netcoredbg | Managed sidecar |
| musl/Alpine SIGSEGV | CI build patches stack-size pre-reservation; track dotnet/runtime#103741 | Keep the patch while the wrapped C++ ICorDebug shim remains affected |
| Logpoints | DapRouter evaluate/log/continue emulation | Native zero-visible-pause implementation |
| Cross-platform EnC | Use `MetadataUpdater.ApplyUpdate` Hot Reload | Classic EnC remains out of scope until an open-source delta generator exists |
| Return values | Unavailable | `ICorDebugILFrame::GetReturnValueForILOffset` exposed in a `Return Value` scope with DAP `returnValue` presentation hint |
| Data breakpoints | Unavailable | Field polling on `StepComplete`, or hardware watchpoints where available |
| F# PDB tables | FCS heuristics | Contribute missing tables to dotnet/fsharp and retain fallback heuristics |

## Security Considerations `[DEBUG-SECURITY]`

- The debug adapter runs as the same user as the target process; SharpLsp does not elevate privileges
- Remote debugging SSH keys are user-managed; SharpLsp does not store credentials
- Process attach is guarded by OS-level ptrace permissions (Linux) and entitlement checks (macOS)
- SharpLsp does not accept debug adapter connections from network interfaces (local sockets only)
- `dotnet-dump` output may contain sensitive heap data; SharpLsp stores dumps in user-specified paths only
- `ICorDebugEval` expression evaluation executes arbitrary code in the debuggee — scope is limited to the current debug session; no cross-session execution

## Performance Targets `[DEBUG-PERFORMANCE]`

| Metric | Target |
|---|---|
| Time from F5 to first breakpoint hit (cold) | <5s |
| Time from F5 to first breakpoint hit (warm) | <2s |
| Step latency (step over / step in / step out) | <200ms p95 |
| Variable panel population after stop | <300ms p95 |
| Conditional breakpoint expression evaluation | <100ms per evaluation |
| Logpoint output latency (Phase 4 emulated) | <200ms |
| Logpoint output latency (Phase 5 native) | <50ms |
| Hot Reload apply latency | <1s from save |
| Async stack reconstruction latency | <150ms |
| Attach to running process | <3s |
| DapRouter proxy overhead (added latency) | <5ms per message |

## Dependencies `[DEBUG-DEPENDENCIES]`

| Dependency | Version | License | Use |
|---|---|---|---|
| [netcoredbg](https://github.com/Samsung/netcoredbg) | 3.2.0-1092 | MIT | Phase 4 debug adapter |
| [ClrDebug](https://github.com/lordmilko/ClrDebug) | 0.3.4+ | MIT | Phase 5 managed ICorDebug wrapper |
| [Microsoft.Diagnostics.DbgShim](https://www.nuget.org/packages/Microsoft.Diagnostics.DbgShim) | 9.0.661903+ | MIT | DbgShim for runtime discovery |
| [Microsoft.Diagnostics.NETCore.Client](https://www.nuget.org/packages/Microsoft.Diagnostics.NETCore.Client) | 9.0.661903+ | MIT | EventPipe / diagnostics IPC |
| [Microsoft.CodeAnalysis.CSharp.Scripting](https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp.Scripting) | 5.6.0 | MIT | Expression compilation; keep aligned with `.config/dotnet/common.props` |
| [FSharp.Compiler.Service](https://www.nuget.org/packages/FSharp.Compiler.Service) | 43.12+ | MIT | F# expression compilation + DU analysis |
| DAP specification | 1.71.0 | CC-BY 4.0 | Protocol reference |

## Reference Documents `[DEBUG-REFERENCES]`

- [Debug Adapter Protocol Specification 1.71.0](https://microsoft.github.io/debug-adapter-protocol/specification)
- [Samsung/netcoredbg — GitHub](https://github.com/Samsung/netcoredbg)
- [ClrDebug — Managed ICorDebug Wrappers](https://github.com/lordmilko/ClrDebug)
- [SharpDbg — C# DAP Debugger](https://github.com/MattParkerDev/sharpdbg)
- [ICorDebug Interface — Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/unmanaged-api/debugging/icordebug/icordebug-interface)
- [Microsoft.Diagnostics.DbgShim NuGet](https://www.nuget.org/packages/Microsoft.Diagnostics.DbgShim/)
- [.NET Hot Reload — MetadataUpdater](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.metadata.metadataupdater)
- [dotnet/diagnostics — GitHub](https://github.com/dotnet/diagnostics)
- [F# Debug Emit Guide](https://fsharp.github.io/fsharp-compiler-docs/debug-emit.html)
- [dotnet/fsharp#12000 — StateMachineMethod PDB table](https://github.com/dotnet/fsharp/issues/12000)
- [dotnet/runtime#103741 — musl SIGSEGV in netcoredbg](https://github.com/dotnet/runtime/issues/103741)
- [dotnet/runtime#12409 — Linux EnC support (closed)](https://github.com/dotnet/runtime/issues/12409)
- [Samsung/netcoredbg#214 — Cross-platform EnC](https://github.com/Samsung/netcoredbg/issues/214)
- [SHARPLSP-SPEC.md](./SHARPLSP-SPEC.md) — parent specification
- [PROFILER-SPEC.md](./PROFILER-SPEC.md) — performance profiling specification
