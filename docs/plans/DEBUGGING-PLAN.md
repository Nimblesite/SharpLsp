# DEBUGGING-PLAN

**SharpLsp Debugging Implementation Plan**

*March 2026 | DRAFT*

Spec: [DEBUGGING-SPEC.md](../specs/DEBUGGING-SPEC.md)

---

## Phase 4 — netcoredbg Integration (Months 15–17)

Goal: Ship a production-quality debugging experience for all editors using netcoredbg as the underlying adapter. Close the most impactful gaps via DapRouter-layer workarounds. F# debugging is a P1 deliverable, not a stretch goal.

**Where the router actually lives.** The plan below was written expecting a Rust
`crates/dap/` module. What shipped is a TypeScript `DapRouter` inside the VS Code
extension, handed to VS Code as a `DebugAdapterInlineImplementation`
(`src/editors/vscode/src/debug.ts:428`): `dap-router.ts` plus its family of
sibling `dap-*.ts` modules. Every Phase-4 emulation named in this plan is
implemented there. §4.1 records the divergence rather than pretending the Rust module exists;
moving the proxy into the host is deferred, and would strand the emulations in
one editor if done carelessly.

**How the boxes below were checked.** A box is ticked only where BOTH the
production code and a test asserting it were found, and the CI chunk that runs
that test is green on this branch. Suite-to-chunk membership is
`src/editors/vscode/test-chunks.json`; chunk results are from run
[33126311223](https://github.com/Nimblesite/SharpLsp/actions/runs/33126311223) at
`1a2b7b6c`, corroborated by run 33122154926 at `79150f80`.

| Chunk | State | Suites |
|---|---|---|
| `debug` | green | `debug-e2e`, `debug-adapter-e2e`, `debug-adapter-startup`, `run-debug-profiles`, `run-debug-contributions` |
| `rundebug` | green | `run-debug-target`, `run-debug-build` |
| `rundebug-commands` | green | `run-debug-commands`, `run-debug-scripts` |
| `debug-session` | green | `debug-protocol-capabilities-e2e`, `debug-session-lifecycle-e2e`, `debug-output-routing-e2e`, `debug-multisession-e2e` |
| `debug-exceptions` | green | `debug-exceptions-e2e`, `debug-exception-filters-e2e` |
| `debug-breakpoints` | **red** — 1 failing of 10 | `debug-breakpoints-e2e`, `debug-breakpoint-conditions-e2e` |
| `debug-stepping` | **red** — 5 failing of 15 | `debug-stepping-e2e`, `debug-stepping-boundaries-e2e`, `debug-callstack-e2e` |
| `debug-inspection` | **red** — 4 failing of 10 | `debug-variables-e2e`, `debug-evaluate-e2e` |
| `debug-fsharp` | **red** — 4 failing of 11 | `debug-fsharp-stepping-e2e`, `debug-fsharp-inspection-e2e` |
| `debug-advanced` | **red** — 7 failing of 11 | `debug-hot-reload-e2e`, `debug-attach-e2e`, `debug-test-debugging-e2e` |

Nothing covered only by a red test is ticked, even where the production code
exists. §4.14 lists every such case in one place.

---

### 4.0 VS Code Run and Debug Surface

The editor-side launch surface, ahead of any DapRouter work. Before this work F5
threw `TypeError: Cannot read properties of undefined (reading 'length')` before
a session could start, there was no run command at all, and single-file C#/F#
sources could not be run. All three are fixed and gated.

Spec: [DEBUG-FEATURES-LAUNCH-NOCONFIG], [DEBUG-FEATURES-LAUNCH-TARGET],
[DEBUG-FEATURES-LAUNCH-BUILD], [DEBUG-FEATURES-LAUNCH-NODEBUG],
[DEBUG-FEATURES-LAUNCH-SCRIPT], [DEBUG-FEATURES-LAUNCH-PROFILES],
[DEBUG-FEATURES-LAUNCH-OUTPUT], [DEBUG-FEATURES-LAUNCH-DYNAMIC],
[DEBUG-FEATURES-LAUNCH-CONTRIBUTIONS], [DEBUG-FEATURES-BREAKPOINTS-CONTRIBUTION].

**Tests first.** The suites below are written and gated on Windows CI; they were
the acceptance criteria for every production item that follows, and all of them
are green.

- [x] Write the spec sections above from the VS Code launch.json standards
- [x] `debug-e2e.test.ts` — the F5 / no-launch.json resolve contract, idempotency, `noDebug`
- [x] `debug-adapter-e2e.test.ts` — netcoredbg path resolution (moved out of the 613-line suite)
- [x] `debug-adapter-startup.test.ts` — adapter startup is total: synchronous spawn failure,
      factory refusal, exactly-once session termination, writes to a dead adapter
- [x] `run-debug-profiles.test.ts` — `launchSettings.json` and `<app>.run.json` parsing
- [x] `run-debug-target.test.ts` — the [SCRIPT-CONE] walk and active-document sensitivity
- [x] `run-debug-build.test.ts` — MSBuild output resolution
- [x] `run-debug-commands.test.ts` — F5, Ctrl/Cmd+F5, `runProgram`, `debugProgram`
- [x] `run-debug-scripts.test.ts` — file-based apps, `.fsx`, and the `.csx`/`.fs` refusals
- [x] `run-debug-contributions.test.ts` — manifest conformance
- [x] Gate all of the above on Windows CI (`debug`, `rundebug`, `rundebug-commands` chunks,
      declared in `src/editors/vscode/test-chunks.json`)

**Production work.**

- [x] Detect "no configuration supplied" by absence, never by `.length` — fixes the F5 crash.
      `debug.ts:291` `isEmptyConfiguration`, called at `debug.ts:80`; test `debug-e2e.test.ts`
      *every no-config shape resolves to the same launchable, idempotent config*
- [x] Make `resolveDebugConfiguration` total: never throw, for any input including malformed
      `launchSettings.json`; abort by returning `undefined` after a named message.
      `debug.ts:73–110` and `debug.ts:120–141`; tests `debug-e2e.test.ts` *an unsound
      launchSettings.json never blocks F5; a sound one supplies env and args* and
      `run-debug-profiles.test.ts` *unsound profile documents yield nothing, throw nothing, and
      never abort the scan*
- [x] Make `resolveDebugConfiguration` idempotent — VS Code re-enters the chain once the
      provider sets `config.type`. `debug.ts:80–88`; test `debug-e2e.test.ts` *every no-config
      shape resolves to the same launchable, idempotent config*
- [x] Add `sharplsp.runProgram`, registered and contributed, honouring `noDebug: true`.
      `debug.ts:483` registration, `debug.ts:513–529` `dispatch`, `package.json:815`;
      tests `run-debug-contributions.test.ts` *every contributed command is registered,
      constant-named and reachable from a menu* and `run-debug-commands.test.ts` *Run and Debug
      start one session each on the identical target*
- [x] Observe the `startDebugging` `Promise<boolean>` and report a refusal instead of
      discarding it. `debug.ts:524–528`; test `run-debug-commands.test.ts` *a refused launch is
      reported to the user instead of being swallowed*
- [x] Extract ONE launch-target resolver shared by F5, both commands and the Solution Explorer.
      `launch-resolver.ts:255` `resolveLaunchTarget`, reached from `debug.ts:248` (`applyTarget`,
      the F5 path), `debug.ts:149` (`provideDebugConfigurations`) and `debug.ts:491` (`launch`,
      both commands and the Solution Explorer node); tests `run-debug-target.test.ts` (all five
      cases) and `run-debug-commands.test.ts` *Debug Program follows the focused document and
      agrees with the provider*
- [x] Anchor target resolution on the active document; mirror [SCRIPT-CONE] exactly
      (`.sln`/`.slnx`, `.git`, workspace-root containment on normalized real paths).
      `launch-target.ts:102` `walkCone`, `launch-target.ts:34` `normalizePath`,
      `launch-target.ts:52` `isWithin`, `debug.ts:207` `anchorWithin`; tests
      `run-debug-target.test.ts` *the target descends into a nested project and follows the
      focused document* and *the cone walk stops at the workspace root, a solution and a .git*
- [x] Prompt on ambiguity; reject libraries as launch targets; never fall back to
      `workspaceFolders[0]` for a document outside every folder. `launch-resolver.ts:146`
      `chooseProject`, `launch-resolver.ts:135` `runnableOnly`, `launch-resolver.ts:105`
      `folderFor`, `msbuild.ts:153` `isRunnableOutputType`; tests `run-debug-target.test.ts`
      *two projects in one directory prompt, and the choice decides the target*, *a class
      library is refused while a console project resolves, in C# and F#*, and *the debug
      command refuses an out-of-workspace document and a blind invocation*
- [x] Resolve the assembly path from MSBuild (`-getProperty:TargetPath`), not a hardcoded
      TFM list and `bin/Debug/<tfm>/` layout. `msbuild.ts:89` `evaluateProject`,
      `msbuild.ts:120` `resolveTargetPath`, `msbuild.ts:136` `pickFramework`; tests
      `run-debug-build.test.ts` *MSBuild decides the output: net7.0, custom AssemblyName
      (F# then C#), custom OutputPath* and *a multi-targeted project resolves the TFM that
      exists, and fabricates none when nothing does*
- [x] Build before launching, exactly once, and emit no `preLaunchTask` of a foreign type —
      the hardcoded `preLaunchTask: 'dotnet: build'` is gone. SharpLsp builds in-process
      (`launch-run.ts:105` `buildProject`, one `dotnet build` pinned to the resolved TFM) and
      contributes `sharplsp-build` for `tasks.json` use (`build.ts:16`
      `SharpLspBuildTaskProvider`); [DEBUG-FEATURES-LAUNCH-BUILD] rule 1 makes in-process the
      *preferred* form because the build then cannot be waved past by `debug.onTaskErrors`.
      Test `run-debug-build.test.ts` *a build request runs exactly one build, as a
      sharplsp-build task and not in a terminal*, whose `assertPreLaunchTask` helper is what
      pins "never `dotnet: `"
- [x] Verify the resolved `program` exists after the build; refuse with a named message if not.
      `debug.ts:375` `builtProgram` and `debug.ts:137–141`; test `run-debug-build.test.ts`
      *an unbuilt project resolves to nothing or to a real file, and to MSBuild once built*
- [x] Run C# file-based apps with `dotnet run --file <abs path>` (never the positional form)
      and debug them via `dotnet build <file> --artifacts-path <dir>`. `launch-run.ts:47`
      `runArgs`, `launch-run.ts:131` `buildFileBasedApp`, `launch-run.ts:152`
      `fileBasedAssembly`; tests `run-debug-scripts.test.ts` *a file-based .cs runs via dotnet
      run --file, never the positional form* and *debugging a file-based .cs launches the
      artifacts-path assembly*
- [x] Run `.fsx` with `dotnet fsi --exec`; refuse `.fsx` debugging with a named message.
      `launch-run.ts:47` `runArgs`, `launch-run.ts:24` `FSX_DEBUG_MESSAGE`, `launch-run.ts:38`
      `scriptDebugMessage`, refusal raised at `debug.ts:358`; test `run-debug-scripts.test.ts`
      *an .fsx runs under dotnet fsi, refuses to debug, and a bare .fs refuses both*
- [x] Refuse `.csx` with a message naming the missing `dotnet-script` tool.
      `launch-run.ts:43` `CSX_TOOL_MESSAGE`, `launch-run.ts:117` `hasDotnetScript`, gate at
      `debug.ts:536–539`; test `run-debug-scripts.test.ts` *a .csx without dotnet-script and a
      non-.NET document are refused by name*
- [x] Dispatch script runs as a `vscode.Task`, not `Terminal.sendText`, so command, args and
      exit code are observable. `launch-run.ts:73` `runTask` (a `ProcessExecution`, per
      [DEBUG-FEATURES-LAUNCH-BUILD] rule 5), executed at `debug.ts:541`; test
      `run-debug-scripts.test.ts` *a script run task names the dotnet CLI whatever SDK path was
      resolved*
- [x] Read profiles from the RESOLVED project's `Properties/launchSettings.json` and a
      file-based app's `<name>.run.json`; tokenize `commandLineArgs` with a real shell-argument
      parser; map `applicationUrl` to `ASPNETCORE_URLS`; prompt when several `Project` profiles
      exist. `launch-profiles.ts:103` `profileCandidates`, `:152` `tokenizeArgs`, `:204`
      `profileEnv`, `:137` `projectProfiles`, `launch-resolver.ts:185` `chooseProfile`,
      `debug.ts:282` `profileRootFor` (walks UP from a stated `program` to its owning project).
      Environment merges PER KEY — `launch-profiles.ts:302` `mergeProfileEnv`, applied at
      `debug.ts:269` — so pinning one variable no longer discards the profile's others.
      Tests `run-debug-profiles.test.ts` *profiles follow the resolved project across every F5
      shape, an edit, and attach*, *profile mapping tokenizes quotes, maps applicationUrl,
      merges env, and asks which profile*, *a file-based app reads `<name>.run.json` exactly
      as a project reads launchSettings*, and `debug-e2e.test.ts` *a launch profile still applies
      when the configuration states its own program*
- [x] Make `isLaunchSettings` sound — reject `{"profiles": null}`, string and array forms.
      `launch-profiles.ts:42`; test `run-debug-profiles.test.ts` *unsound profile documents
      yield nothing, throw nothing, and never abort the scan*
- [x] Contribute `breakpoints` for `csharp` and `fsharp` — without it breakpoints cannot be set
      in either language on a standalone install. `package.json:1124–1131`; test
      `run-debug-contributions.test.ts` *breakpoint languages, debugger languages and the debug
      type agree but stay distinct*
- [x] Contribute `taskDefinitions` for `sharplsp-build`. `package.json:1132–1148`; test
      `run-debug-contributions.test.ts` *the build task type the code registers is declared and
      expresses every task provided*
- [x] Declare every attribute the resolver writes in `configurationAttributes` (`console`,
      `justMyCode`, `hotReload`, `requireExactSource`, `symbolOptions`).
      `package.json:287–376`; test `run-debug-contributions.test.ts` *the launch schema declares
      what the resolver writes and nothing VS Code core injects*
- [x] Register the provider for `Dynamic` as well as `Initial`, and declare the
      `onDebugResolve:` / `onDebugDynamicConfigurations:` activation events.
      `debug.ts:463–478`, `package.json:43–44`; tests `run-debug-contributions.test.ts`
      *activation events, initial configurations and snippets expose the resolver TFM* and
      `debug-e2e.test.ts` *provideDebugConfigurations emits one config per profile and resolves
      the target once*
- [x] Add `initialConfigurations`; align `configurationSnippets` with the resolver's TFM.
      `package.json:380` snippets and `package.json:404` initial configurations; test
      `debug-e2e.test.ts` *the manifest offers initial configurations and snippets the live
      provider agrees with*
- [x] Contribute both commands to `editor/title/run`, `editor/context` and `view/item/context`.
      `package.json:828`, `:1101`, `:1111`; test `run-debug-contributions.test.ts` *run and
      debug are contributed and placed in the title, context and explorer menus*

### 4.1 Infrastructure

The proxy shipped in TypeScript inside the VS Code extension rather than as a
Rust crate. Items that describe the *behaviour* of the proxy are ticked against
the TypeScript implementation; items that describe the *Rust host wiring* stay
open and are called out as such, because nothing implements them.

- [ ] Add `DapRouter` module to the Rust host (`crates/dap/`) — **not built.** The router is
      `src/editors/vscode/src/dap-router.ts` (+ `dap-attach`, `dap-breakpoints`, `dap-caps`,
      `dap-correlator`, `dap-emulate`, `dap-exceptions`, `dap-frames`, `dap-goto`,
      `dap-namespace`, `dap-replay`, `dap-stack`, `dap-statement`, `dap-stepping`, `dap-stops`,
      `dap-variables`, `dap-wire`), delivered as a `DebugAdapterInlineImplementation`.
      Every emulation below therefore works in VS Code only; Zed and the Rider plugin get raw
      netcoredbg. Moving it into the host is the open work.
- [x] Implement DAP JSON-RPC framing (Content-Length header, UTF-8 body) — in TypeScript, not
      Rust. `dap-wire.ts:78` `write`, `dap-wire.ts:190` `takeFrame` (a header with no parseable
      `Content-Length` ends the session rather than stranding the buffer); test
      `debug-protocol-capabilities-e2e.test.ts` *the initialize request pins the dialect the
      whole suite depends on*
- [x] Implement DAP proxy: bidirectional message forwarding between editor and adapter
      subprocess. `dap-router.ts` `handleMessage` (client → adapter, via
      `interceptCommand`) and `dap-wire.ts:173` `consume`
      (adapter → client); tests: the whole green `debug-session` chunk, which drives a real
      netcoredbg through the router
- [x] Implement adapter subprocess spawn, stdout/stderr capture and crash detection.
      `dap-wire.ts:129` `spawn`, `dap-wire.ts:143` `watchDeath` (one idempotent settle path for
      `exit`, `error` and stdin `EPIPE`), `dap-router.ts` `DapRouter.start` returning a
      `Result` so a synchronous `cp.spawn` throw never reaches the extension host; tests
      `debug-adapter-startup.test.ts` *a synchronous spawn failure becomes a Result, never a
      thrown error*, *the factory refuses the session and says why, instead of crashing the
      host*, *an asynchronous spawn failure still terminates the session honestly*
- [ ] Restart the adapter with exponential backoff — **not built.** `dap-wire.ts:92` `respawn`
      exists but is driven only by the client's `restart` request and by the terminal-launch
      emulation; a crashed adapter ends the session (`dap-router.ts` `onChildGone`) rather
      than being retried.
- [x] Multiplex concurrent sessions without handle collisions. Each session gets its own
      inline router, and `dap-namespace.ts:18` `HandleNamespace` offsets every frame and
      variable handle into a private million-wide range so two netcoredbg processes that both
      number from 1 stay distinguishable; test `debug-multisession-e2e.test.ts` *two sessions
      run side by side with their own stacks and their own state*.
      (The plan's "session registry keyed by session ID" presumes a single shared host process;
      with an inline adapter per session there is nothing to key.)
- [ ] Wire DAP listen socket into the LSP host's tokio runtime (separate port or stdio
      multiplexed) — **not built**, and not applicable while the adapter is inline.
- [ ] Add `sharplsp/debugAdapterInfo` LSP extension to report active adapter version and
      capabilities — **not built.** No such request exists in the host or the extension.
- [x] Intercept `initialize` response: augment capability flags for SharpLsp-emulated features
      (logpoints, hit counts, restart, run-to-cursor, exception options).
      `dap-caps.ts:24` `ROUTER_CAPABILITIES`, `:37` `withRouterCapabilities`, `:53`
      `withEventCapabilities` (the `capabilities` event is augmented too, so a late upgrade
      cannot un-advertise an emulation); tests
      `debug-protocol-capabilities-e2e.test.ts` *every Phase Four capability the table marks Yes
      is advertised* and *no Phase Five capability is over-claimed in Phase Four*

### 4.2 netcoredbg Bundling and Distribution

- [x] Stage netcoredbg into the VSIX for every platform with an upstream prebuilt, and prove it
      reached the package. `tools/vsix/fetch-netcoredbg.sh` (invoked from
      `tools/make/main.mk:193` and `:607`), payload assertion in
      `tools/vsix/verify-vsix-payload.mjs:42` for both `netcoredbg` and its `ManagedPart.dll`;
      test `00-vsix-dev-binary-staging.test.ts` *bundles the netcoredbg debug adapter the launch
      path resolves first* — which runs as the shared head of **every** Windows chunk
- [x] Platform targets **as upstream actually ships them**: `win32-x64`, `linux-x64`,
      `linux-arm64`, `darwin-arm64`. `win32-arm64` and `darwin-x64` have no upstream prebuilt;
      `tools/vsix/fetch-netcoredbg.sh:29` skips them cleanly and the extension falls back to a PATH copy or
      `sharplsp.debug.netcoredbgPath` (`netcoredbg.ts:20` `findNetcoredbg`, `:62`
      `getNetcoredbgCandidates`); tests `00-vsix-dev-binary-staging.test.ts` (the
      `NO_DEBUGGER_PREBUILT` branch asserts the fallback candidates) and
      `debug-adapter-e2e.test.ts` *a configured netcoredbgPath outranks bundled, user-installed
      and PATH copies* / *the candidate list is ordered, pure, and only its head depends on
      extensionPath*
- [x] ~~Build netcoredbg from source for `osx-arm64`~~ — **unnecessary.** Upstream 3.2.0-1092
      ships `netcoredbg-osx-arm64.zip`; it is fetched like every other prebuilt
      (`tools/vsix/fetch-netcoredbg.sh:28`). The plan's premise that Samsung ships no ARM64 macOS binary is
      out of date.
- [ ] `win-arm64` and `osx-x64` coverage — needs a source build; both currently degrade to the
      PATH fallback
- [ ] Add SharpLsp CI job: build netcoredbg for Alpine/musl (`linux-musl-x64`,
      `linux-musl-arm64`) with patched stack size pre-reservation to work around
      dotnet/runtime#103741
- [x] Version-pin netcoredbg `3.2.0-1092` in `tools/vsix/fetch-netcoredbg.sh`; [DEBUG-ADAPTER-NETCOREDBG] documents that an upgrade requires the debug end-to-end suite
- [ ] Implement first-run auto-download if bundled binary absent (SHA-256 hash verification mandatory)
- [ ] Add `sharplsp/debugAdapterStatus` notification for download progress display

### 4.3 Launch and Attach

- [x] `launch` request handling: the resolver writes a conforming configuration and the router
      forwards it verbatim to netcoredbg. `debug.ts:73` `resolveDebugConfiguration`,
      `debug.ts:301` `baseConfiguration`, `dap-router.ts` `rememberLaunchOptions`; tests
      `debug-session-lifecycle-e2e.test.ts` *args, env and cwd from the configuration reach the
      debuggee* and `debug-e2e.test.ts` *an explicit program is preserved verbatim while a
      missing one is resolved*
- [x] Support `stopAtEntry: true`. Declared at `package.json:313` and forwarded unmodified;
      test `debug-session-lifecycle-e2e.test.ts` *stopAtEntry pauses before the program has
      done anything*
- [x] Support `console: integratedTerminal` — VS Code hosts the debuggee and the router
      respawns netcoredbg attached to it, because netcoredbg never issues the `runInTerminal`
      reverse request itself ([DEBUG-ADAPTER-GAPS]). `dap-replay.ts:67` `wantsTerminal`,
      `:102` the synthesized `runInTerminal`, `:105` `onTerminalResponse`, `:122` the
      `--attach <pid>` respawn, `:134` `replayHandshake`; test
      `debug-output-routing-e2e.test.ts` *integratedTerminal gives the debuggee a real terminal,
      so stdin works*
- [x] Route debuggee output for `internalConsole`. Test
      `debug-output-routing-e2e.test.ts` *internalConsole delivers the debuggee's stdout as DAP
      output events*
- [x] Run without debugging. `debug.ts:513` `dispatch` passes `{ noDebug }` to
      `startDebugging`, and script targets go to a task instead (`debug.ts:532`
      `runWithoutDebugger`); tests `debug-e2e.test.ts` *Ctrl/Cmd+F5 keeps noDebug through
      resolution and resolves the same target as F5* and
      `debug-session-lifecycle-e2e.test.ts` *Run without debugging ignores every armed
      breakpoint*
- [x] Restart. Emulated by respawning the adapter and replaying the handshake, because
      netcoredbg answers `restart` with `E_NOTIMPL`. `dap-router.ts` `restart`, `dap-replay.ts:127`
      `restart`; test `debug-session-lifecycle-e2e.test.ts` *Restart relaunches the same
      configuration and re-arms the breakpoints*
- [x] Pause and terminate. Test `debug-session-lifecycle-e2e.test.ts` *Pause interrupts a
      running debuggee and Stop terminates the session*
- [ ] Implement `attach` request handler: PID-based attach with retry on `0x80070057`
      (issue #205 workaround — 3 retries, 500ms backoff).
      **Implemented at `dap-attach.ts:10` `RETRY_DELAYS_MS = [500, 1000, 2000]` and
      `dap-attach.ts:32` `AttachRetrier`, but `debug-attach-e2e.test.ts` *attaching by pid
      pauses the live process and exposes its state* fails on Windows CI — the debuggee never
      stops ("it stopped 0. Stops seen: []").**
- [ ] Implement attach-by-process-name: resolve name → PID.
      **Implemented at `attach-target.ts:212` `resolveByName` / `:229` `resolveAttachTarget`
      (POSIX `ps` at `:94`, Windows CIM at `:131`), refusals wired through `debug.ts:174`
      `settleAttach`; but `debug-attach-e2e.test.ts` *attaching by process name resolves the
      name to a pid* fails for the same reason. The refusal half alone is green —
      `debug-attach-e2e.test.ts` *attaching to a pid that does not exist is refused with one
      message* passes.**
- [ ] Implement `sourceFileMap` path remapping in `stackTrace` responses — **not built.** No
      `sourceFileMap` handling exists anywhere in the extension or the host.
- [ ] Implement `justMyCode` launch flag forwarding to netcoredbg.
      **Implemented — the flag is defaulted at `debug.ts:88`, tracked on the router
      and enforced for step stops at `dap-statement.ts:17` `carriesUserCode` — but
      `debug-stepping-e2e.test.ts` *Just My Code refuses to step into framework code* fails.**
- [ ] Add `requireExactSource` support — declared in `configurationAttributes`
      (`package.json:338`) and forwarded, but nothing asserts the behaviour; no test.
- [ ] E2E test: launch console app on macOS ARM64 (no macOS leg in CI; Windows and Ubuntu only)
- [ ] E2E test: launch ASP.NET app, hit breakpoint on request handler

### 4.4 Breakpoints

- [x] Implement `setBreakpoints` proxy with response normalization. `dap-router.ts`
      `pendingBreakpointArgs`, forwarded through `SessionReplayer.observe`, `dap-breakpoints.ts:52`
      `BreakpointEmulator.observe`; tests `debug-breakpoints-e2e.test.ts` *F9 in a C# editor
      sets a breakpoint the adapter binds and stops on*, *breakpoints added and removed
      mid-session reach the running adapter*, *a disabled breakpoint is never armed, and
      re-enabling it re-arms it*, and `debug-fsharp-stepping-e2e.test.ts` *F9 in an F# editor
      sets a breakpoint the adapter binds and stops on*
- [x] Implement conditional breakpoints (forwarded to netcoredbg). Test
      `debug-breakpoint-conditions-e2e.test.ts` *a condition decides the stop: true stops once,
      false never stops*
- [x] Implement hit-count breakpoint forwarding (`hitCondition` with `>`, `>=`, `==`, `%`
      operators) — emulated, because netcoredbg ignores `hitCondition` outright
      ([DEBUG-ADAPTER-GAPS]). `dap-emulate.ts` `parseHitCondition`, `dap-breakpoints.ts:52`
      `BreakpointEmulator` (auto-continues until the condition passes), advertised at
      `dap-caps.ts:24` `supportsHitConditionalBreakpoints`; test
      `debug-breakpoint-conditions-e2e.test.ts` *a hit count selects which visit stops, plainly
      and relationally*
- [x] Implement logpoint emulation in the router: detect `logMessage`, evaluate its
      `{expression}` placeholders, emit a DAP `output` event and continue without ever pausing.
      `dap-emulate.ts` `tokenizeLogMessage`, `dap-breakpoints.ts:20` `StopVerdict` (`action:
      'log'`), delivery at `dap-stops.ts:60`; test `debug-breakpoint-conditions-e2e.test.ts`
      *a logpoint logs the interpolated message and never pauses the debuggee*
- [x] Implement `setExceptionBreakpoints` proxy with `filterOptions` and `exceptionOptions`.
      `dap-exceptions.ts:99` `filterOptionsFrom`, `:139` `withTranslatedExceptionOptions`
      (DAP `exceptionOptions` rewritten into the fully-qualified-type `filterOptions[].condition`
      grammar netcoredbg actually implements); tests `debug-exceptions-e2e.test.ts` *the adapter
      advertises every exception facility the specification requires* and
      `debug-exception-filters-e2e.test.ts` *a type filter breaks on the named type it selects*
- [ ] Implement `setFunctionBreakpoints` proxy.
      **Forwarded, but `debug-breakpoints-e2e.test.ts` *a function breakpoint stops on entry to
      the named method* is the one red test in the `debug-breakpoints` chunk.**

### 4.5 Stepping

- [x] Proxy `next`, `stepIn`, `stepOut`, `continue`, `pause`. `dap-router.ts`
      `interceptCommand`, `dap-stepping.ts:28` `STEP_COMMANDS`; tests
      `debug-stepping-e2e.test.ts` *F10 walks statement by statement and never enters the
      callee* and *Continue walks breakpoint to breakpoint and the last one runs the program
      out*
- [x] Coalesce same-line steps so one gesture advances one statement. A single source line
      carries several sequence points — F# `for index in 1 .. 3 do` emits one for the loop and
      one for the range — so F10 came to rest on the line it started from.
      `dap-stepping.ts:120` `StepCoalescer` (`:113` `sameStatement` compares source, line and
      stack depth; `:39` `MAX_COALESCED` bounds it; `:49` `LINE_GRANULARITIES` leaves
      `instruction` stepping alone), offered at `dap-stops.ts:60`; test
      `debug-fsharp-stepping-e2e.test.ts` *F10, F11 and Shift+F11 walk F# functions exactly as
      they walk C#*, interaction 3 — "F10 in an F# `for` loop must visit the loop header, then
      the body"
- [x] Elide structural sequence points (a bare `{` or `}`) from step stops, over the concrete
      syntax tree and never by reading characters. `src/sharplsp/src/statement_stop.rs`
      (`sharplsp/statementStop`), consumed at `dap-statement.ts:42` `carriesCode`, which
      fails open; tests `src/sharplsp/tests/e2e_modules/statement_stop.rs` and
      `debug-stepping-e2e.test.ts` *F10 walks statement by statement and never enters the
      callee*
- [x] Implement `goto` as temporary breakpoint + continue (run to cursor) — netcoredbg answers
      `gotoTargets`/`goto` with `E_NOTIMPL`. `dap-goto.ts:24` `GotoEmulator`, which merges the
      temporary breakpoint into the source's current set and removes it the moment it hits so
      the Breakpoints view is untouched; test `debug-stepping-e2e.test.ts` *Run to cursor stops
      at the caret and leaves no breakpoint behind*
- [ ] Implement Just My Code skip. **Implemented (see §4.3) but
      `debug-stepping-e2e.test.ts` *Just My Code refuses to step into framework code* fails.**
- [ ] E2E test: step into and out of a method call chain — `debug-stepping-e2e.test.ts` *F11
      descends into the callee and Shift+F11 climbs back out* is red
- [ ] E2E test: stepping off the end of a method and of the program —
      `debug-stepping-boundaries-e2e.test.ts` *stepping over the last statement of a method
      returns to the caller* and *stepping over the last statement of the program terminates
      the session* are both red
- [x] E2E test: a breakpoint encountered mid-step still stops the debuggee —
      `debug-stepping-boundaries-e2e.test.ts` *a breakpoint inside a stepped-over call still
      stops the debuggee*

### 4.6 Call Stack and Async Stack Enrichment

- [x] Proxy `stackTrace`, `scopes`, `variables` and `source` requests. `dap-router.ts`
      `pendingStackArgs`, `dap-stack.ts:44` `StackDelivery` (which re-applies the caller's
      `startFrame`/`levels` window to the enriched stack); tests
      `debug-callstack-e2e.test.ts` *every physical frame is listed, named, located and
      navigable*, *selecting a caller frame reads that frame's own locals*, *threads are
      enumerated and the stopped thread is identified*
- [x] Detect frames with compiler-generated state machine type names (`<MethodName>d__N`) and
      recover the logical method name from them. `dap-frames.ts:120` `stateMachineMethod`,
      `:130` `logicalFrameName`, `:156` `isAsyncPlumbing`, `:188` `enrichAsyncFrames`; the
      spec's own fallback rule is honoured — anything unrecognised passes through untouched.
      Covered indirectly by `debug-callstack-e2e.test.ts` *every physical frame is listed,
      named, located and navigable*
- [ ] Inject the AWAITING frames — the caller chain parked in a continuation — into
      `stackTrace`. **Not built.** `dap-frames.ts:11` states the limit plainly: frames parked in
      a continuation are not on the physical stack at all, and recovering them needs an
      ICorDebug walk of `AsyncTaskMethodBuilder._builder._continuation` through the C# sidecar,
      which does not exist. `debug-callstack-e2e.test.ts` *an awaited chain reports the LOGICAL
      async stack, not raw MoveNext frames* is red: "Frames reported: LeafAsync".
  - [ ] Build side-channel request to C# sidecar: type name, `this` object address, frame index
  - [ ] C# sidecar: implement `ReconstructAsyncStack` handler using Roslyn type model
  - [ ] C# sidecar: read `<>1__state`, `<>4__this`, and continuation chain fields from heap via `ICorDebugObjectValue`
  - [ ] C# sidecar: walk `AsyncTaskMethodBuilder._builder._continuation`/`MoveNextRunner` to next logical frame
  - [ ] E2E test: 3-level async chain — all 3 logical frames visible

### 4.7 Variable Inspection and Evaluation

- [x] Proxy `variables` requests with structured response normalization. `dap-router.ts`
      `variables`, `dap-namespace.ts:18` handle translation; tests
      `debug-variables-e2e.test.ts` *a paused frame exposes its arguments and its locals,
      correctly typed* and *an instance method exposes `this` and its members*
- [x] Proxy `evaluate` requests (hover, watch, repl contexts), with the bounded retry a freshly
      stopped Windows thread needs. `dap-attach.ts:32` `EvaluateRetrier`, advertised at
      `dap-caps.ts:24` `supportsEvaluateForHovers`; test
      `debug-protocol-capabilities-e2e.test.ts` *every Phase Four capability the table marks Yes
      is advertised*
- [ ] E2E test: the same expression answers identically in hover, watch and the REPL —
      `debug-evaluate-e2e.test.ts` is red with netcoredbg's `0x80070057`, so the retry does not
      yet cover this path
- [ ] Implement `setVariable` proxy — forwarded, but `debug-evaluate-e2e.test.ts` *setVariable
      changes the value the running program then uses* was not reached (the suite aborts on the
      earlier failure); no green assertion
- [ ] Expand `List<T>` elements. **Implemented at `dap-variables.ts:174` `VariableExpander`
      (C# `List<T>` arrives as `_items` + `_size`; the expander presents the elements from the
      adapter's own handles rather than evaluating code), but `debug-variables-e2e.test.ts`
      *collections, dictionaries, arrays and nullables all expand* is red — the panel still
      shows `_items`, `_size`, `_version`, `Capacity`.**
- [ ] Static-field scope. **Not built.** `debug-variables-e2e.test.ts` *a static field is
      reachable from the variables panel* is red: "Scopes offered [Locals] holding [running,
      seed]" — there is no `Statics` scope and `Program.Total` is unreachable.
- [ ] Implement `[DebuggerDisplay]` emulation. **Not built.** No code reads the attribute; the
      C# sidecar has no Roslyn lookup for it and the router has no format-string evaluation
      step. `debug-evaluate-e2e.test.ts` *[DebuggerDisplay] decides how an object renders in the
      panel* is red: got `{StepTarget.Box}`, expected `Box(boxed,8)`.
  - [ ] On `variables` response, identify types with `[DebuggerDisplay]` (via C# sidecar Roslyn lookup)
  - [ ] Send evaluate request to C# sidecar with format string and frame context
  - [ ] Replace default `toString()` value in response with evaluated display string
  - [ ] Fall back to raw class name if evaluation fails

### 4.8 Exception Handling

- [x] Proxy `setExceptionBreakpoints` with full `filterOptions` support — see §4.4.
      `dap-exceptions.ts:99`, `:139`, `:160` `retarget`; test `debug-exceptions-e2e.test.ts`
      *the adapter advertises every exception facility the specification requires*
- [x] Break on all exceptions, including one the program handles itself. Test
      `debug-exceptions-e2e.test.ts` *breaking on ALL exceptions catches a throw the program
      handles itself*
- [x] Ignore a handled throw when only the unhandled filter is armed. Test
      `debug-exceptions-e2e.test.ts` *with only the unhandled filter, a handled throw is ignored
      completely*
- [x] Inner exception chain traversal — the exception info panel exposes the chain. Test
      `debug-exceptions-e2e.test.ts` *an unhandled exception breaks with its type, message,
      stack and inner cause*
- [x] Per-type include/exclude filters, changed mid-session. Tests
      `debug-exception-filters-e2e.test.ts` *a type filter ignores every exception type it does
      not name* and *exception filters changed mid-session take effect on the next throw*
- [x] F# exceptions, at the same density. Tests `debug-fsharp-stepping-e2e.test.ts` *F#
      exceptions break on the throw and are ignored when unfiltered* and *an F# exception the
      program handles is ignored when only unhandled is armed*

### 4.9 Hot Reload

**Not working.** `src/editors/vscode/src/hot-reload.ts` is a `dotnet watch`
terminal, unrelated to any DAP session. A router-side `dap-hot-reload.ts` and a
C# sidecar `HotReloadSessionRegistry` are IN FLIGHT on this branch, but no delta
has yet reached a debuggee: all three `debug-hot-reload-e2e.test.ts` cases are
red. Re-check this section once `debug-advanced` goes green.

- [ ] Implement `sharplsp/hotReload` custom notification handler in the router
- [ ] Integrate with VFS: watch for document saves during active debug session
- [ ] C# sidecar: implement delta computation via Roslyn `WatchHotReloadService.GetUpdatesAsync`
- [ ] Deliver delta to the target process (`MetadataUpdater.ApplyUpdate` via expression evaluation)
- [ ] Surface `sharplsp/hotReloadResult` to the editor: success + changed methods, or rejection + reason
      — `debug-hot-reload-e2e.test.ts` *a rude edit is refused with a named reason and a restart
      prompt* is red on "Messages seen: []"
- [ ] E2E test: edit method body while paused → continue → new behavior observed without restart
      — red: "the reloaded body adds 100 per iteration"
- [ ] E2E test: add a new method to a class while debugging — red: "the new method adds 1000 per iteration"

### 4.10 F# Debugging (Phase 4)

- [x] F# breakpoints, stepping and call stacks at the same density as C#. Tests
      `debug-fsharp-stepping-e2e.test.ts` *F9 in an F# editor sets a breakpoint the adapter
      binds and stops on*, *F10, F11 and Shift+F11 walk F# functions exactly as they walk C#*
      (which also pins that an F# call stack names `add`/`accumulate`/`main` innermost-first,
      and that F# function parameters are bound)
- [ ] F# discriminated union display in F# syntax. **Not built.** Nothing queries the FCS
      sidecar for DU case metadata and no `variables` value is rewritten.
      `debug-fsharp-inspection-e2e.test.ts` *a discriminated union and an option render as F#,
      not as Tag/field pairs* is red: got `{FsStepTarget.Program.Shape.Rect}`, expected
      `Rect(3, 4)`.
- [ ] F# list expansion. **Partially implemented** — `dap-variables.ts:174` `VariableExpander`
      handles the recursive `FSharpList<T>` Head/Tail union with a `MAX_FSHARP_ITEMS` bound —
      but `debug-fsharp-inspection-e2e.test.ts` *records, tuples and F# lists are inspectable in
      F# form* is red: "an F# list must expand to ALL its elements, not to its cons-cell
      internals".
- [ ] F# record inspection: map compiled backing field names to F# record field names — untested
      in isolation; covered only by the red test above
- [ ] F# tuple inspection: display as `(value1, value2)` syntax — same
- [ ] F# `task {}` async stack enrichment. **Not built** — it needs the same continuation walk
      §4.6 lacks. `debug-fsharp-inspection-e2e.test.ts` *an F# task {} chain reports the logical
      await stack* is red, reporting `leafTask@42-3` / `resumptionInfo` / `MoveNext` plumbing.
- [ ] One-press F# step-into. **Not built** — needs FCS PDB heuristics to tell generated
      machinery from user code. `debug-fsharp-inspection-e2e.test.ts` *stepping into a task {}
      takes ONE F11, not two* is red: "landed in …/FSharp.Core/fslib-extra-pervasives.fs".
- [ ] F# `async {}` stack enrichment: best-effort CPS chain reconstruction — not built
- [ ] Test debugging (`VSTEST_HOST_DEBUG=1`, attach to the test host child) — see §4.12

### 4.11 Multi-Process Debugging

- [x] Support multiple concurrent debug sessions with independent adapter processes.
      One inline `DapRouter` per session, each with its own `HandleNamespace`
      (`dap-namespace.ts:18`, `RANGE = 1_000_000`); test `debug-multisession-e2e.test.ts` *two
      sessions run side by side with their own stacks and their own state*
- [ ] Implement compound launch: parse a list of named launch configs, start all sequentially

### 4.12 Test Debugging Integration

**Not built.** The Test Explorer's Debug profile calls
`testing.ts:411` `debugTests` → `openDebugTerminal`, which opens a
`dotnet test --filter` terminal. No debugger is attached, `VSTEST_HOST_DEBUG` is
never set, and both `debug-test-debugging-e2e.test.ts` cases are red.

- [ ] Implement `sharplsp/testDebug` custom request handler
- [ ] Build DAP launch config for test host: `dotnet test --no-build` with `VSTEST_HOST_DEBUG=1`
- [ ] Resolve test host child process PID (watch for child process creation event)
- [x] Wire test filter (class/method) into `dotnet test --filter`, escaped for the VSTest
      grammar. `test-filter.ts`, `testing.ts:428` `openDebugTerminal`; test
      `test-explorer-e2e.test.ts` (VSTest filter grammar cases, `testexplorer` chunk, green)
- [ ] E2E test: breakpoint inside an xUnit test method, `sharplsp/testDebug` → breakpoint hit
      — `debug-test-debugging-e2e.test.ts` *the Debug profile starts a session and stops inside
      the test body* and *the session attaches to the test host, not to the parent dotnet test*
      are both red
- [ ] E2E test: breakpoint inside an Expecto test function (F#)

### 4.13 Phase 4 Quality Gates

- [x] All P1 breakpoint types work reliably on Windows x64 — **except function breakpoints**
      (`debug-breakpoints` chunk, 9 of 10 green)
- [ ] All P1 breakpoint types work reliably on Linux x64 (the Ubuntu `VS Code / Full Suite +
      Coverage` job runs them; not yet green on this branch)
- [ ] All P1 breakpoint types work reliably on macOS ARM64 — no macOS leg exists in CI
- [x] Logpoint emulation verified — fires the interpolated message, never pauses
      (`debug-breakpoint-conditions-e2e.test.ts`)
- [ ] Async stack enrichment: `MoveNext` frames replaced with logical frames — the awaiting
      frames are never injected (§4.6)
- [ ] DebuggerDisplay emulation — not built (§4.7)
- [ ] F# DU inspection: shows F# syntax not IL class names — not built (§4.10)
- [x] No crash in the router when netcoredbg crashes: a spawn failure, an asynchronous spawn
      failure and an `EPIPE` on a dead adapter each end exactly one session with a user-visible
      message and never reach the extension host. `dap-router.ts` `DapRouter.start`,
      `dap-router.ts` `onChildGone` (idempotent), `dap-wire.ts:143` `watchDeath`,
      `child-signal.ts:28` `signalChild`; tests `debug-adapter-startup.test.ts` (all seven
      cases)
- [ ] Attach reliability: ≥95% success rate across 20 consecutive attach attempts — attach is
      red (§4.3)
- [ ] Full E2E test suite passes in CI on Linux x64, macOS ARM64, Windows x64

### 4.14 Fixed on this branch

Defects closed on PR #218 that the sections above predate. Each is production
code plus a regression test, and each test's chunk is green.

- [x] **`child.kill()` on a failed spawn signalled the caller's process group.** A child whose
      spawn failed carries no pid, so Node issued `kill(0, SIGTERM)` — POSIX for "every process
      in the CALLER's process group". In the extension host that group is the whole VS Code
      tree; `respawn`'s one-second escalation to `kill(0, SIGKILL)` was worse still. A bundled
      netcoredbg that loses its execute bit in a VSIX unzip lands on exactly this path.
      Fixed by `child-signal.ts:19` `livePid` / `:28` `signalChild`, used at `dap-wire.ts:102`,
      `:106` and `:125`. Tests `debug-adapter-startup.test.ts` *disposing a router whose adapter
      never started signals only that adapter* and *respawning a router whose adapter never
      started signals only that adapter* (a canary process in the host's own group plus a
      temporary SIGTERM listener, so a regression fails an assertion instead of vanishing the
      host). [DEBUG-ARCHITECTURE-ROUTER]
- [x] **An uncaught `EPIPE` on the adapter's stdin crashed the extension host.** `write()`
      guarded on `stdin.writable`, but netcoredbg can die between that check and the syscall and
      Node reports the broken pipe asynchronously on the stream; with no `error` listener it was
      an uncaught exception. Fixed at `dap-wire.ts:151` (stdin `error` listener) and
      `dap-wire.ts:86` (the synchronous throw a destroyed stream raises), both settling through
      the same idempotent `onGone`. Test `debug-adapter-startup.test.ts` *writing to an adapter
      that has died never escapes into the host*, plus *an asynchronous spawn failure still
      terminates the session honestly*. [DEBUG-ARCHITECTURE-ROUTER]
- [x] **A `DapRouter.start()` that threw synchronously took down the extension host.**
      `cp.spawn` throws outside its ENOENT/EACCES allowlist — a wrong-architecture
      `netcoredbg.exe` raises `spawn UNKNOWN` — and an inline adapter has no executable boundary
      to contain it. `dap-router.ts` now returns a `Result` and `debug.ts:420` refuses the
      descriptor with a message naming the path. Test `debug-adapter-startup.test.ts` *the
      factory refuses the session and says why, instead of crashing the host*.
      [DEBUG-ADAPTER-NETCOREDBG]
- [x] **`respawn()`'s deliberate kill latched the session closed.** `respawn` kills the old
      netcoredbg on purpose, but that child's `exit` was wired into the unexpected-death path:
      `closed = true` and `terminated` fired at VS Code, and the replacement child — alive and
      talking — was DEAF, because `consume()` bails while closed. Restart and every
      `console: integratedTerminal` launch therefore produced a live-but-unheard adapter and
      exactly one stop, forever. Fixed by guarding per-CHILD at `dap-wire.ts:66` `replaced`
      (marked before the signal, so the exit cannot race the flag), checked at `dap-wire.ts:152`,
      `:158` and `:167` — so a genuine failure of the REPLACEMENT is still fully reported. Tests
      `debug-session-lifecycle-e2e.test.ts` *Restart relaunches the same configuration and
      re-arms the breakpoints* and `debug-output-routing-e2e.test.ts` *integratedTerminal gives
      the debuggee a real terminal, so stdin works*. [DEBUG-FEATURES-LAUNCH-OUTPUT]
- [x] **Every diagnostic was published twice.** The server advertised `diagnosticProvider`
      (pull) AND pushed `publishDiagnostics`; `vscode-languageclient` builds a second
      `DiagnosticCollection` for the pull model and `vscode.languages.getDiagnostics`
      concatenates collections, so one `#error` surfaced as two. `diagnosticProvider` is now
      withheld from clients that declare `textDocument.publishDiagnostics`; pull-only clients
      keep it. `src/sharplsp/src/main.rs`; test
      `src/sharplsp/tests/e2e_modules/diagnostics.rs:101`
      `test_push_capable_client_is_not_offered_pull_diagnostics` (Rust shards green).
      [DIAG-LSP-CAPABILITIES-EXCLUSIVE] — tracked in
      [DIAGNOSTICS-PLAN.md](DIAGNOSTICS-PLAN.md)
- [x] **Tier-1 package resolution never republished after restore settled.** Applying restored
      references swaps the project in place inside the sidecar and fires no client event; the
      only refresh was a one-shot pass gated on a fixed 1s delay, which a real NuGet download
      outlives, so the editor kept the tier-2 placeholder and package types stayed CS0246
      (measured: frozen at t=2s, still frozen at t=52s). Degradation is now a typed
      pending/terminal state (`SLSPC0002` vs `SLSPC0001`) and the push loop keeps fetching while
      a set is provisional. `src/sharplsp/src/diagnostics.rs:135` `publish_provisional`,
      `:167`; test `diagnostics.rs:666`
      `provisional_filebased_set_must_be_republished_once_restore_settles`.
      [SCRIPT-FILEBASED-REFERENCES-FALLBACK], [DIAG-PUSH-GATE] — tracked in
      [SCRIPTING-FILEBASED-PLAN.md](SCRIPTING-FILEBASED-PLAN.md)
- [x] **F# same-line step coalescing.** `for index in 1 .. 3 do` emits a sequence point for the
      loop construct AND one for the range enumerator on the same line, so F10 came to rest
      where it started and the user had to press twice to move one statement.
      `dap-stepping.ts:120` `StepCoalescer`; test `debug-fsharp-stepping-e2e.test.ts` *F10, F11
      and Shift+F11 walk F# functions exactly as they walk C#*, interaction 3.
      [DEBUG-FEATURES-STEPPING]

### 4.15 Specified but not built

Phase-4 behaviour that this branch's suites SPECIFY and that has no
implementation, or an implementation that does not yet satisfy them. Listed
plainly so nobody reads a green-looking plan as a working feature. Every entry
below has a red test naming it, except the last two, which nothing tests at all.

| Feature | Section | State | Failing test |
|---|---|---|---|
| F# DU payload rendering | §4.10 | No implementation | *a discriminated union and an option render as F#, not as Tag/field pairs* |
| F# list expansion | §4.10 | `dap-variables.ts:174` exists, does not satisfy | *records, tuples and F# lists are inspectable in F# form* |
| `[DebuggerDisplay]` emulation | §4.7 | No implementation | *[DebuggerDisplay] decides how an object renders in the panel* |
| `List<T>` element expansion | §4.7 | `dap-variables.ts:174` exists, does not satisfy | *collections, dictionaries, arrays and nullables all expand* |
| Static-field scopes | §4.7 | No implementation | *a static field is reachable from the variables panel* |
| C# awaiting-frame injection | §4.6 | Needs an ICorDebug continuation walk | *an awaited chain reports the LOGICAL async stack, not raw MoveNext frames* |
| F# `task {}` awaiting-frame injection | §4.10 | Same continuation walk | *an F# task {} chain reports the logical await stack* |
| One-press F# step-into | §4.10 | Needs FCS PDB heuristics | *stepping into a task {} takes ONE F11, not two* |
| Hot reload | §4.9 | `dap-hot-reload.ts` + sidecar registry in flight; no delta reaches a debuggee | all three `debug-hot-reload-e2e` cases |
| Attach by pid | §4.3 | `dap-attach.ts` retry exists, debuggee never stops | *attaching by pid pauses the live process and exposes its state* |
| Attach by process name | §4.3 | `attach-target.ts` resolves the name; the attach itself fails | *attaching by process name resolves the name to a pid* |
| Test debugging | §4.12 | Debug profile opens a terminal; no attach | both `debug-test-debugging-e2e` cases |
| Function breakpoints | §4.4 | Forwarded, does not stop | *a function breakpoint stops on entry to the named method* |
| Just My Code step skip | §4.3, §4.5 | `dap-statement.ts:17` exists, does not satisfy | *Just My Code refuses to step into framework code* |
| Step into / out of a call chain | §4.5 | Proxied; red on Windows CI, cause not yet diagnosed | *F11 descends into the callee and Shift+F11 climbs back out* |
| Stepping off the end of a method / the program | §4.5 | Red on Windows CI, cause not yet diagnosed | both `debug-stepping-boundaries-e2e` end-of-scope cases |
| `sourceFileMap` remapping | §4.3 | No implementation | none — unspecified by any test |
| `sharplsp/debugAdapterInfo` / `debugAdapterStatus` | §4.1, §4.2 | No implementation | none — unspecified by any test |

---

## Phase 5 — SharpLsp Debug Sidecar (Months 21–26)

Goal: Replace netcoredbg with a C# Tier 4 sidecar achieving full vsdbg parity. Close all gaps documented in [DEBUG-GAPS].

---

### 5.1 Debug Sidecar Bootstrap

- [ ] Create `sidecar/debug/` — new C# project (`SharpLsp.Debug.Sidecar`), .NET 9, nullable enabled
- [ ] Add `ClrDebug` 0.3.4+ NuGet dependency (managed ICorDebug wrappers; source-generated COM interop on .NET 8+)
- [ ] Add `Microsoft.Diagnostics.DbgShim` 9.0.661903+ NuGet dependency
- [ ] Add `Microsoft.Diagnostics.NETCore.Client` 9.0.661903+ NuGet dependency
- [ ] Implement DAP stdin/stdout transport (Content-Length framing, JSON-RPC)
- [ ] Implement `initialize` request handler: report full Phase 5 capability set
- [ ] Implement IPC channel to Rust host (MessagePack socket, same protocol as other sidecars)
- [ ] Implement adapter registration: DapRouter auto-selects Debug Sidecar when present; falls back to netcoredbg

### 5.2 ICorDebug Core

- [ ] Implement `ICorDebugManagedCallback` — all callbacks:
  - [ ] `Breakpoint`, `StepComplete`, `Break`, `Exception`, `EvalComplete`, `EvalException`
  - [ ] `CreateProcess`, `ExitProcess`, `CreateThread`, `ExitThread`
  - [ ] `LoadModule`, `UnloadModule`, `LoadClass`, `UnloadClass`
  - [ ] `DebuggerError`, `LogMessage`, `LogSwitch`
  - [ ] `CreateAppDomain`, `ExitAppDomain`, `LoadAssembly`, `UnloadAssembly`
  - [ ] `UpdateModuleSymbols`, `BreakpointSetError`
- [ ] Implement `DbgShim` bootstrap: `RegisterForRuntimeStartup` for attach; `EnumerateCLRs` for already-running processes
- [ ] Implement async-safe event dispatch loop with `ICorDebugController::Continue`
- [ ] Implement thread enumeration and management

### 5.3 Launch and Attach

- [ ] Implement `launch`: `CreateProcess` with debug flag + `ICorDebug::DebugActiveProcess`
- [ ] Implement `attach`: `DbgShim.RegisterForRuntimeStartup` (race-free; no `0x80070057`)
- [ ] Implement attach-by-name: resolve PID then attach
- [ ] Implement child process auto-attach via `ICorDebugManagedCallback::CreateProcess`
- [ ] E2E test: reliable attach — 20 consecutive attaches succeed (regression for netcoredbg issue #205 scenario)

### 5.4 Full Breakpoint Implementation

- [ ] Implement line breakpoints via `ICorDebugCode::CreateBreakpoint`
- [ ] Implement function breakpoints via `ICorDebugFunction::CreateBreakpoint`
- [ ] Implement exception breakpoints via `ICorDebugProcess` exception flags + first-chance filter
- [ ] Implement conditional breakpoints: full C# expression via Roslyn eval pipeline (§5.6)
- [ ] Implement hit-count breakpoints: counter in `Breakpoint` callback handler
- [ ] **Implement native logpoints**: evaluate log expression via `ICorDebugEval`, output DAP `output` event, call `Continue` immediately — zero pause latency
- [ ] **Implement data breakpoints**: field polling on `StepComplete` events; hardware watchpoints via platform APIs where available
- [ ] **Implement instruction breakpoints** via IL offset at `ICorDebugCode` level
- [ ] Implement `setDataBreakpoints` DAP request handler
- [ ] E2E test: native logpoint fires in <50ms, execution never pauses
- [ ] E2E test: data breakpoint fires when `_count` field changes from 4 to 5

### 5.5 Full Call Stack with Async Reconstruction

- [ ] Implement `stackTrace` via `ICorDebugThread` → `ICorDebugChain` → `ICorDebugFrame` full traversal
- [ ] Implement full async logical stack: direct heap traversal for continuation chains via `ICorDebugProcess::ReadMemory` (faster than Phase 4 Roslyn model approach)
- [ ] Implement parallel stacks: enumerate all threads, build frame graphs, expose as `sharplsp/parallelStacks` custom event
- [ ] **Implement restart frame**: `ICorDebugILFrame::CanSetIP` check → `ICorDebugILFrame::SetIP` to first IL offset
- [ ] Implement `restartFrame` DAP request handler
- [ ] E2E test: 5-level async chain — logical stack shows all 5 caller frames
- [ ] E2E test: restart frame — execution resumes from beginning of current method

### 5.6 Full Expression Evaluation (Roslyn Pipeline)

- [ ] Implement expression compilation pipeline:
  - [ ] Debug Sidecar receives `evaluate` request with expression string + frame context (locals, `this`, scope)
  - [ ] Sidecar sends IPC request to C# sidecar (Roslyn) to compile expression in scope context via `CSharpScriptCompilation`
  - [ ] Roslyn returns compiled IL bytes for in-memory assembly
  - [ ] Debug Sidecar allocates memory in target process via `ICorDebugProcess::WriteMemory`
  - [ ] Debug Sidecar creates `ICorDebugEval`, calls `ICorDebugEval::CallFunction` with compiled method
  - [ ] Debug Sidecar waits for `EvalComplete`/`EvalException` callback; deserializes `ICorDebugValue` result
  - [ ] Result returned as structured DAP `evaluate` response
- [ ] E2E test: `myList.Where(x => x > 5).Count()` in watch window returns correct value
- [ ] E2E test: multi-statement expression `int s = items.Sum(); return s * 2;` evaluates correctly
- [ ] E2E test: LINQ query over `IEnumerable<T>` with 1000 items evaluates in <100ms

### 5.7 DebuggerDisplay, TypeProxy, Browsable

- [ ] **Implement native `[DebuggerDisplay]`**: evaluate format string via `ICorDebugEval` in target process; return display string
- [ ] **Implement `[DebuggerTypeProxy]`**: detect attribute; instantiate proxy type via eval; expand proxy members instead of raw object
- [ ] **Implement `[DebuggerBrowsable]`**: honour `Never`, `RootHidden`, `Collapsed` visibility flags
- [ ] E2E test: `[DebuggerDisplay("{Name} ({Id})")]` type shows `"Alice (42)"`, not class name
- [ ] E2E test: `[DebuggerTypeProxy(typeof(DictionaryProxy))]` on `Dictionary<K,V>` shows formatted key-value pairs
- [ ] E2E test: `[DebuggerBrowsable(Never)]` field is hidden from variables panel

### 5.8 Variable Inspection Enhancements

- [ ] **Implement return value display**: `ICorDebugILFrame::GetReturnValueForILOffset` after step-over; synthesize `returnValue` pseudo-variable under `Return Value` scope (DAP 1.67+ `returnValue` presentation hint)
- [ ] Implement raw memory read/write: `readMemory` / `writeMemory` DAP requests via `ICorDebugProcess`
- [ ] Implement disassembly: `disassemble` request using `ICorDebugCode::GetCode` → IL disassembly with source mapping
- [ ] Implement completions in evaluate: `completions` DAP request routed to Roslyn C# sidecar for in-scope symbol completion
- [ ] Implement C# 12 primary constructor parameter inspection: map compiler-generated backing fields to source parameter names
- [ ] Fix `Nullable<T>` expansion: resolve `HasValue`/`Value` fields correctly for all value types (regression test for netcoredbg issue #213)
- [ ] E2E test: `Nullable<Guid>` with value expands to show `HasValue: true`, `Value: {guid-string}`
- [ ] E2E test: return value of `ComputeTotal()` shown as `42` after step-over

### 5.9 Hot Reload — Full Implementation

- [ ] Move Hot Reload delivery from DapRouter eval injection to Debug Sidecar direct `MetadataUpdater.ApplyUpdate` call
- [ ] Implement delta caching: avoid re-compiling unchanged methods within a session
- [ ] Implement multi-assembly delta application
- [ ] Implement Rude Edit detection and reporting: surface edit type and reason to editor
- [ ] E2E test: edit + continue round-trip completes in <1s on a 50-method project
- [ ] E2E test: add new method to class while debugging — new method callable immediately

### 5.10 F# Debugging (Phase 5)

- [ ] F# `task {}` async stack: full logical reconstruction via direct heap traversal
- [ ] F# `async {}` stack: best-effort CPS chain reconstruction (improved from Phase 4 heuristics)
- [ ] F# expression evaluation: route `evaluate` to FCS sidecar for F# expression compilation; evaluate via `ICorDebugEval`
- [ ] F# discriminated union: native DU-aware formatting via FCS sidecar (not just display string — full structural expansion)
- [ ] F# mailbox processor: expose message queue depth as pseudo-variable in variables panel
- [ ] Smart Step Into for F# pipelines: implement `stepIn` with `targetId` (DAP `supportsStepInTargetsRequest`)
- [ ] Contribute `StateMachineMethod` PDB table emission to dotnet/fsharp (or maintain SharpLsp-local patch)
- [ ] E2E test: `task { }` async chain — full logical stack with no `MoveNext` frames
- [ ] E2E test: F# watch expression `List.length myList` evaluates correctly
- [ ] E2E test: Smart Step Into on `list |> List.map f |> List.filter g` — user selects `f` or `g`

### 5.11 Remote Debugging (Full)

- [ ] Implement SSH tunnel management in DapRouter: connect, upload binary, start adapter, forward port
- [ ] Implement `sourceFileMap` path remapping for remote paths
- [ ] Implement remote binary upload with progress reporting via `sharplsp/debugAdapterStatus`
- [ ] E2E test: debug .NET app running in Linux Docker container from macOS host

### 5.12 Phase 5 Quality Gates

- [ ] All DAP capability flags match Phase 5 capability matrix in [DEBUG-PROTOCOL-CAPABILITIES]
- [ ] Expression evaluation: LINQ + lambda tier (T3) passes all test cases
- [ ] Async logical stack: 100% of C# async test cases show logical frames (zero `MoveNext` frames)
- [ ] Data breakpoints: field change detection works for reference and value types
- [ ] Logpoints: native implementation; latency <50ms verified by timing test
- [ ] Return value display: shown for all non-void step-overs
- [ ] DebuggerDisplay/TypeProxy/Browsable: all three attributes work natively
- [ ] `Nullable<T>`, primary constructor params: inspection works for all tested types
- [ ] F# debugging: DU inspection + F# async stack + expression eval verified
- [ ] Remote debugging: full round-trip E2E test against Docker container
- [ ] No regression on any Phase 4 test case

---

## Continuous: Upstream Contributions

- [ ] Samsung/netcoredbg: contribute logpoint native implementation (Phase 4 emulation algorithm documented for upstream adoption)
- [x] ~~Samsung/netcoredbg: contribute macOS ARM64 CI and official binary release~~ — no
      longer needed: upstream 3.2.0-1092 publishes `netcoredbg-osx-arm64.zip`, which
      `tools/vsix/fetch-netcoredbg.sh:28` fetches like any other prebuilt. `win32-arm64`
      and `darwin-x64` are the two that still have none.
- [ ] Samsung/netcoredbg: contribute musl/Alpine stack size workaround + dotnet/runtime#103741 upstreaming
- [ ] Samsung/netcoredbg: contribute async stack reconstruction from [DEBUG-FEATURES-STACK-ASYNC](../specs/DEBUGGING-SPEC.md)
- [ ] Samsung/netcoredbg: track and test fix for attach reliability issue #205
- [ ] Samsung/netcoredbg: track and test fix for stability regression #217, #206
- [ ] Samsung/netcoredbg: contribute `[DebuggerDisplay]` rendering (from SharpDbg implementation learnings)
- [ ] dotnet/fsharp: contribute `StateMachineMethod` PDB table emission (issue #12000)
- [ ] dotnet/runtime: contribute musl `EnsureStackSize` fix (issue #103741)
- [ ] lordmilko/ClrDebug: contribute any missing ICorDebug interface wrappers discovered during Phase 5
- [ ] MattParkerDev/SharpDbg: evaluate as Phase 5 foundation; contribute if adopted
