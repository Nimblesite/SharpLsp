# SharpLsp regression review since v0.21.0

Reviewed 2026-09-24 by SharpLspAstra1.

Baseline: `v0.21.0` (`7c3b1ce68cd7a4df8b95973b828c80c4335daa2c`).
Target: merged `main` (`f3167c5a8398415d6e602238bb33fbfa30557442`).

## Confirmed regressions requiring a fix

### [P2] A required green CI check can represent zero tests on a security update

`.github/workflows/ci.yml:58` skips `detect-changes` when the PR actor is Dependabot, which skips every downstream analysis, build, security, and test job. The terminal `CI` job at lines 272–300 nevertheless passes whenever its dependencies are merely *skipped*. Dependabot security PRs can target `main` (`.github/workflows/dependabot-automerge.yml:9–22`), and `main` protection requires only the `CI` check. Such a PR can therefore be merged directly with a green required check despite running no tests. The staging sweep normally closes these PRs and tests a consolidation PR, but a delayed or failed sweep leaves the direct-merge path open.

This is new since v0.21.0: the release workflow had no Dependabot actor guard on `detect-changes`. Fix the required gate so it cannot succeed on a main-targeted code/dependency PR when the test jobs were skipped, while retaining the intended single test run for staged upgrades.

## Other results and verification

- No other unresolved regression was confirmed in changed LSP, sidecar, VS Code, Test Explorer, debugger, or packaging paths. No existing VS Code test suite or test declaration was removed; the chunk guard assigns all 129 suites, and no coverage floor fell. Changed assertions inspected were not weakened.
- Local verification: Rust unit tests **319/319**; .NET C# **541/541**, F# **409/409**, Common **92/92**. Merged PR #300's final run had 47 successful checks and zero failures. The full VS Code extension-host matrix was not rerun locally on macOS.
