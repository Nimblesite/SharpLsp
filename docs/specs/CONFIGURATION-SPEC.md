# Shared configuration

## Resolution `[CONFIG-RESOLUTION]`

The Rust LSP owns the schema, validation and resolution of language and debugger
settings. Clients MUST NOT parse TOML or implement a separate precedence algorithm.
Existing server, C#, F#, diagnostics, analyzer and profiler settings remain supported.

Precedence, lowest first:

1. Typed server defaults.
2. Personal `sharplsp/config.toml` under `%APPDATA%` on Windows, or
   `$XDG_CONFIG_HOME` (otherwise `~/.config`) on Unix.
3. The nearest `sharplsp.toml`, searching upward from the requested scope.
4. Explicit client overrides supplied as `settings.sharplsp` through
   `workspace/didChangeConfiguration`.
5. Explicit per-request overrides.

Objects merge recursively. Arrays replace, so `ignore = []` clears inherited
exclusions. Unknown keys, invalid enums and malformed exception type names produce
errors. Invalid client updates retain the previous client layer. Editor defaults
MUST NOT be sent as explicit overrides.

Retired keys are the exception: keys an earlier release documented that no longer
have any effect are dropped with a logged warning and are not echoed, so files
written from those docs keep loading. They are the 0.25 profiler defaults
`default_trace_duration`, `default_trace_format`, `default_counter_providers` and
`default_counter_interval`. A setting is never removed without being retired here.

`sharplsp/configuration` accepts `{ scopeUri?, overrides? }` and returns the full
validated configuration as JSON using the TOML field names. `scopeUri` is a local
workspace-directory or project-file URI; it enables independent resolution in
multi-root workspaces. The server reads files on each request, including after edits
or deletion. Resolution errors are JSON-RPC `InvalidParams` errors.

Server startup uses the same personal/workspace resolution. A running server applies
later changes as `[CONFIG-RESOLUTION-LIVE]` lists. Settings read only at startup take
a server restart, and the server says so when one of them changes. Debugger policy is
resolved for each new launch or attach; restarting the same debug session reuses its
resolved policy. These lifecycle limits MUST be stated rather than implying all
settings hot-reload.

## Live reconfiguration `[CONFIG-RESOLUTION-LIVE]`

A running server re-resolves its configuration in two cases:

- the client sends `workspace/didChangeConfiguration`;
- a watched configuration file changes on disk. The server watches any
  `sharplsp.toml` in the workspace root, the nearest one above the root, and the
  personal file. A lost native observation counts as a change.

A configuration that no longer validates is not applied: the previous one stays in
force, and the failure is logged. A valid one is applied as follows:

| Settings | Applied |
|---|---|
| `[analyzers]` | When changed, pushed to both compilers (`analyzers/configure`) before diagnostics refresh, so the next pull is analyzed under them |
| `[diagnostics]` | Pushed to both compilers (`diagnostics/configure`); cached reports are invalidated and the client is asked to refresh |
| `[csharp] solution_path` | The C# workspace reopens on the new solution |
| `[debug]`, `[testing]` | Read for each launch, attach or test build |
| `[server]`, `[csharp] enabled`, `[fsharp] enabled`, `[profiler]` | Read only at startup. A change produces one `window/showMessage` warning that names it and asks for a restart |

Two kinds of file are not watched:

- a `sharplsp.toml` farther above the root than the nearest one;
- a configuration file created in a directory that was not watched at startup.

An edit to either applies at the next re-resolution or restart.

## Exceptions `[CONFIG-DEBUG-EXCEPTIONS]`

```toml
[debug.exceptions]
break_on = "all"
just_my_code = true
ignore = ["System.OperationCanceledException", "System.Threading.Tasks.TaskCanceledException"]
external_code = "user-boundary"
```

`break_on` accepts:

| Value | Behavior |
| --- | --- |
| `editor` (default) | Preserve the DAP client's exception checkboxes. |
| `all` | Break on thrown exceptions, even if later caught, subject to Just My Code. |
| `user-unhandled` | Break when not handled by user code; enables Just My Code. |
| `unhandled` | Break only on terminal unhandled exceptions. |

`ignore` contains exact fully qualified CLR type names, not wildcards or base-class
matches. It narrows the selected exception filters. Terminal unhandled exceptions
still stop, retaining the crash for inspection. Debugger filtering does not catch an
exception in the application or make a fatal exception recoverable.

`just_my_code = true` (default) skips first-chance throws in external code, including
libraries without symbols and sources outside the workspace/launch root. A library
can execute its own handler and return without a visible exception stop. Throws in
user code still obey the selected filters. Set `just_my_code = false` with
`break_on = "all"` to inspect every throw, including inside libraries. This option
controls exception stops independently of the launch setting for normal stepping.
When a launch supplies `cwd`, that root defines the user-source boundary; a broader
editor workspace must not expand it to include sibling dependency sources. Without
a launch root, workspace folders define user sources. Having symbols for external
code does not make that source user code. Both Just My Code values crossed with
both `external_code` values must be verified through actual VS Code debug sessions,
including original external sources with portable PDBs, caller source/line mapping,
preserved exception details, handled continuation and unhandled-only controls.
User-unhandled and terminal unhandled stops remain visible. Failed classification
or resume requests retain the original stop.

Ignoring an exception preserves a pending F10/F11/step-out gesture. The bundled
adapter permits stepping from symbol-less managed frames so a first-chance throw
does not strand stepping with `0x80004005`. Continue and step both let the runtime
run any existing handler; neither inserts a catch into the application.

`external_code = "throw-site"` (default) retains the throwing frame.
`external_code = "user-boundary"` presents the nearest workspace/launch-root caller
as the first frame for exception stops. It does not move the instruction pointer or
alter the exception's original stack/details. If no user frame exists, show the raw
stack. Pagination applies after this projection. Other stop reasons retain normal
stack behavior. Use `just_my_code = true` to skip library-internal first-chance
throws, or `user-unhandled` to stop only when an exception escapes user handling.
Boundary presentation alone does not change exception selection.

## Editor integration `[CONFIG-EDITOR-BRIDGE]`

VS Code resolves shared policy over LSP before launch/attach. Its optional
`launch.json` `exceptionPolicy` object uses the same field names and supplies explicit
per-launch overrides. The DAP bridge translates the resolved policy to exception
filters, including replay after restart and terminal launch. The shared schema and
endpoint have no dependency on VS Code.

VS Code settings continue to own extension installation paths, UI layout, status
bars, tree presentation and terminal preferences. `.editorconfig` remains the source
for language formatting conventions. Shared behavior should be added to the typed
server schema and documented here rather than first introduced as an editor setting.

## Test builds `[CONFIG-TESTING]`

```toml
[testing]
configuration = "Debug"
```

`configuration` defaults to `Debug` and accepts custom MSBuild configuration names.
Empty names, control characters, commas and semicolons are invalid. Discovery,
execution, coverage and debugging resolve this setting for the project scope on
each operation. The selected configuration must be passed explicitly to MSBuild;
a project's own Release default must not override the testing default. Build and
output evaluation use the same configuration. See [TEST-BUILD-CONFIGURATION].

Test-platform dependencies may themselves be optimized Release binaries. Their
debugger warnings do not imply that the user's test assembly was built in Release;
verification must inspect the user assembly and prove that its breakpoints bind.
