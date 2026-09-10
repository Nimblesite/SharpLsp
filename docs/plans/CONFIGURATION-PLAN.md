# Shared configuration implementation

- [x] Typed LSP-owned schema and personal/workspace/client/launch precedence.
- [x] Scope-aware resolution request and validation.
- [x] Exception selection, exclusions and boundary presentation.
- [x] VS Code bridge and launch overrides; keep editor presentation settings local.
- [x] Verify Rust resolution tests and DAP policy tests.
- [x] Verify live exception behavior in F# and C# and direct editor-independent JSON-RPC resolution.
- [x] Reproduce unwanted library exception stops in real F# and C# sessions.
- [x] Reproduce F10 `0x80004005` on first-chance throws handled inside a symbol-less library.
- [x] Add shared Just My Code exception selection, preserving user and terminal stops.
- [x] Verify the bundled adapter step fix and pending F10 across ignored throws (eight live F#/C# regressions).
- [ ] Add live reconfiguration of existing sidecar/runtime settings in a separate change.
