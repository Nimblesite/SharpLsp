# Dependency consolidation

Merge `dependabot-upgrades` into `fix/563-progressive-load`, preserving [DIST-CI-LAYOUT] and [DIST-CI-ARTIFACT-TESTS].

- [x] Preserve current editor requirements, security overrides, prepared FSharpLint source and newer package pins.
- [x] Rebuild npm locks from the resolved manifests; retain both sysinfo versions required by SharpLsp and lsp-profiler.
- [x] Verify extension lint/type checks, website build, F# sidecar build, SDK pins and 22 workflow tests.
- [x] Verify Gradle 9.9 and IntelliJ platform plugin 2.20 through the repo JDK launcher: 8 tests pass; Kover 4.0948% passes the unchanged 4.09% gate.
- [x] Run all F# sidecar tests: 550 pass, none skipped.
- [x] Run affected MTP output/merge editor checks: 10 pass.
- [x] Restore missing refactoring videos in three locales: all 9 desktop/phone checks pass.
- [x] Verify Rust and Zed formatting/clippy with CI targets (November 12).
- [ ] Finish full website suite (1,035 cases) and full CI gates. First run: 1,020 passed, 11 skipped, four failed. Refactoring fixes passed all nine targeted checks; the caption 404 did not reproduce in 27 repeated checks. A fresh full pass is running; do not count the first run as green.
- [ ] Resolve local CSharpier configuration discovery failure: `dotnet csharpier check src/sidecars/` exits before formatting because macOS denies enumeration of `/Users/christianfindlay/Documents`; explicit `--config-path .editorconfig` has the same failure. No suppression or source change applied.
- [x] Review pi's dependency audit; align Java setup and Gradle task pins, reject incompatible npm majors.
- [x] Complete merge (`fd26b19c`); staging ancestry is included. Retain the staging ref required by the Dependabot workflow and its target-branch configuration.
- [ ] Push after validation.

TypeScript 7 is excluded: current typescript-eslint requires `<6.1.0`. Language client 11 is excluded: lsp-profiler-ui 0.4 requires client 9 or 10. Both failed dependency compatibility checks; no forced peer overrides are accepted. Upgrade their consumers first before reconsidering these versions.

Gradle 9.9 distribution SHA-256 comes from the official distribution checksum endpoint: `0b00b0ffe07c4d4789c12d4935a44a7057d55774b7540bd4a3f76f336deb177a`.
