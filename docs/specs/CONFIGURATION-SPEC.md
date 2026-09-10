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

`sharplsp/configuration` accepts `{ scopeUri?, overrides? }` and returns the full
validated configuration as JSON using the TOML field names. `scopeUri` is a local
workspace-directory or project-file URI; it enables independent resolution in
multi-root workspaces. The server reads files on each request, including after edits
or deletion. Resolution errors are JSON-RPC `InvalidParams` errors.

Server startup uses the same personal/workspace resolution. Existing server and
sidecar runtime settings require a server restart after changes. Debugger policy is
resolved for each new launch or attach; restarting the same debug session reuses its
resolved policy. These lifecycle limits MUST be stated rather than implying all
settings hot-reload.

## Exceptions `[CONFIG-DEBUG-EXCEPTIONS]`

```toml
[debug.exceptions]
break_on = "all"
ignore = ["System.OperationCanceledException", "System.Threading.Tasks.TaskCanceledException"]
external_code = "user-boundary"
```

`break_on` accepts:

| Value | Behavior |
| --- | --- |
| `editor` (default) | Preserve the DAP client's exception checkboxes. |
| `all` | Break on thrown exceptions, even if later caught. |
| `user-unhandled` | Break when not handled by user code; enables Just My Code. |
| `unhandled` | Break only on terminal unhandled exceptions. |

`ignore` contains exact fully qualified CLR type names, not wildcards or base-class
matches. It narrows the selected exception filters. Terminal unhandled exceptions
still stop, retaining the crash for inspection. Debugger filtering does not catch an
exception in the application or make a fatal exception recoverable.

`external_code = "throw-site"` (default) retains the throwing frame.
`external_code = "user-boundary"` presents the nearest workspace/launch-root caller
as the first frame for exception stops. It does not move the instruction pointer or
alter the exception's original stack/details. If no user frame exists, show the raw
stack. Pagination applies after this projection. Other stop reasons retain normal
stack behavior. Use `user-unhandled` to avoid stopping on exceptions libraries handle
internally; boundary presentation alone does not change when an exception is thrown.

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
