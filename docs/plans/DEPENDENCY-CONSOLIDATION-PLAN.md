# Dependency consolidation

Merge `dependabot-upgrades` into `fix/563-progressive-load`, preserving [DIST-CI-LAYOUT] and [DIST-CI-ARTIFACT-TESTS].

- [x] Preserve current editor requirements, security overrides, prepared FSharpLint source and newer package pins.
- [x] Rebuild npm locks from the resolved manifests; retain both sysinfo versions required by SharpLsp and lsp-profiler.
- [x] Verify extension lint/type checks, website build, F# sidecar build, SDK pins and 22 workflow tests.
- [ ] Verify Gradle 9.9 and IntelliJ platform plugin 2.20 configuration and Rider tests.
- [ ] Run affected editor, website and F# test suites and full CI gates.
- [ ] Review pi's dependency audit against the resolved diff.
- [ ] Complete merge, push and remove the merged staging branch after checking automation ownership.

TypeScript 7 is excluded: current typescript-eslint requires `<6.1.0`. Language client 11 is excluded: lsp-profiler-ui 0.4 requires client 9 or 10. Both failed dependency compatibility checks; no forced peer overrides are accepted. Upgrade their consumers first before reconsidering these versions.

Gradle 9.9 distribution SHA-256 comes from the official distribution checksum endpoint: `0b00b0ffe07c4d4789c12d4935a44a7057d55774b7540bd4a3f76f336deb177a`.
