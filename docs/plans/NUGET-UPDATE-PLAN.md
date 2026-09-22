# [NUGET-UPDATE-PLAN] Safe NuGet Update Plan

Issue: [#270](https://github.com/Nimblesite/SharpLsp/issues/270).
Contract: [NUGET-REQUESTS-UPDATE](../specs/NUGET-BROWSER-SPEC.md#nuget-requests-update-bounded-explicit-package-updates).

## [NUGET-UPDATE-PLAN-DECISION] Product Decision

Recommend latest stable within the current major, or current minor for `0.x`, then confirm and apply a concrete version. Major changes and prereleases require explicit version selection. No unversioned update, automatic target substitution, or network-error fallback.

## [NUGET-UPDATE-PLAN-STATUS] Implementation Checklist

- [x] Define bounds, preview/confirmation, ambiguous declarations, CPM scope, and failure behavior in the spec.
- [ ] Add red regression coverage using disposable F# and C# projects and controlled versions; assert checked-in fixtures are unchanged.
- [ ] Remove the test picker fallback that can choose a checked-in workspace project.
- [ ] Route the palette Update command through the host/browser package workflow, eliminating its direct unbounded CLI path.
- [ ] Implement bounded candidate selection, explicit version confirmation and stale-preview rejection.
- [ ] Verify major/prerelease opt-in, cancellation, failed feeds, restore errors and CPM/shared-props behavior.
- [ ] Run the workspace/package feature chunks on supported CI platforms; only then close #270.
