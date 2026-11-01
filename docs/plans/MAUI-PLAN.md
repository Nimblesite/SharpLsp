# .NET MAUI and Mobile Implementation Plan

**Spec:** [MAUI-SPEC.md](../specs/MAUI-SPEC.md) · **XAML half:** [XAML-PLAN.md](XAML-PLAN.md)

## Context

SharpLsp has no device tooling: no environment checks, device list, deploy, mobile debugging, device logs or signing. The debugger is netcoredbg over ICorDebug, which is CoreCLR only ([DEBUG-ADAPTER-NETCOREDBG]).

**The enabling fact:** from .NET 11, MAUI on Android, iOS and Mac Catalyst runs on CoreCLR by default, and Mono is unsupported there (NETSDK1242; [.NET blog, May 2026](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/)). So SharpLsp's existing CoreCLR debugger can reach devices once it can attach remotely. There is no Mono soft debugger to build first.

**Prior art:** Microsoft's MAUI extension needs C# Dev Kit and its proprietary debugger (vsdbg), so it doesn't run in Cursor, VSCodium or other forks. The community, open-source .NET Meteor extension proves VS Code can deploy, debug and hot reload MAUI on Android and iOS. Users still report trouble with physical iOS devices ([dotnet/maui #21320](https://github.com/dotnet/maui/discussions/21320)).

### Evidence: pain points

GitHub issues on Microsoft's VS Code .NET tooling, ranked by reactions and comments:

| Pain | Issues |
|---|---|
| Environment detection fails | [#717](https://github.com/microsoft/vscode-dotnettools/issues/717) can't find Android SDK; [#1541](https://github.com/microsoft/vscode-dotnettools/issues/1541) stuck analyzing Android environment (open); [#1148](https://github.com/microsoft/vscode-dotnettools/issues/1148) stuck on "Xcode: verifying environment"; [#842](https://github.com/microsoft/vscode-dotnettools/issues/842) command line tools not installed (27 comments) |
| Debugging is unreliable | [#1449](https://github.com/microsoft/vscode-dotnettools/issues/1449) randomly unable to debug MAUI (41 comments); [#1526](https://github.com/microsoft/vscode-dotnettools/issues/1526) iOS app locks up when debugging; [#936](https://github.com/microsoft/vscode-dotnettools/issues/936) no break on exception in MAUI projects; [#972](https://github.com/microsoft/vscode-dotnettools/issues/972) `ConnectionLostException` |
| Physical iOS devices | [#1081](https://github.com/microsoft/vscode-dotnettools/issues/1081) iOS USB debugging (open); [#2088](https://github.com/microsoft/vscode-dotnettools/issues/2088) unable to debug on a real iOS device; [#1386](https://github.com/microsoft/vscode-dotnettools/issues/1386) iOS extension deploy fails (open, 43 comments) |
| Simulator and device choice | [#287](https://github.com/microsoft/vscode-dotnettools/issues/287) choose the iOS simulator runtime identifier; [#648](https://github.com/microsoft/vscode-dotnettools/issues/648) refresh devices |
| Hot reload on device | [#867](https://github.com/microsoft/vscode-dotnettools/issues/867) hot reload for MAUI iOS and Android (open, 18 reactions) |
| Provisioning | [#1539](https://github.com/microsoft/vscode-dotnettools/issues/1539) download Apple provisioning profiles (open) |
| Mobile without MAUI | [#470](https://github.com/microsoft/vscode-dotnettools/issues/470) iOS and Android development without MAUI (open, 17 reactions) |
| Command-line run | [dotnet/maui #5975](https://github.com/dotnet/maui/issues/5975) unable to run the Windows app from the command line (open, 21 comments) |

Google Trends ([XAML-PLAN.md](XAML-PLAN.md)): ".net maui tutorial" leads YouTube MAUI queries, ".net maui blazor" is second on both web and YouTube, and ".net maui linux" is rising (+50%).

## Phasing

- **Phase 0: research.** Settle the open questions below before Phase 3.
- **Phase 1: environment and targets.** Environment doctor, target picker, device discovery.
- **Phase 2: run.** Build, deploy and launch on every target, device logs, Solution Explorer actions.
- **Phase 3: debug.** CoreCLR on Windows and Mac Catalyst, then Android and iOS on .NET 11. Exception breakpoints and hot reload on device.
- **Phase 4: assets.** Image, font and asset completion, plus manifest completion.
- **Phase 5: publish.** Keystores, signing identities, profiles, packages.
- **Phase 6: device tests and Mono.** XHarness in the Test Explorer, then the Mono soft-debugger adapter for .NET 10.

## TODO

### [MAUI-PLAN-RESEARCH] Phase 0: Research

- [ ] R1: Find the SDK `Run` target's device-selection properties for Android and iOS on .NET 11, and whether `dotnet run` selects devices itself
- [ ] R2: Find how ICorDebug attaches to CoreCLR on an Android emulator and device, and on an iOS simulator and device (diagnostics port, `dotnet-dsrouter`, the SDK's debug-launch targets). Confirm netcoredbg or the Debug Sidecar can drive it
- [ ] R3: Confirm Edit and Continue on CoreCLR mobile targets, for C# and for MAUI source-generated XAML ([XAML-PLAN-RESEARCH])
- [ ] R4: Confirm the machine-readable output of `dotnet workload` and of `InstallAndroidDependencies`
- [ ] R5: Price the CI legs (Android emulator on Linux, iOS simulator on macOS), and gate them on path changes
- [ ] Record findings in [MAUI-SPEC.md](../specs/MAUI-SPEC.md) and remove the "confirmed in research" notes

### Phase 1: Environment and targets

- [ ] Environment doctor command and view, with each check and fix ([MAUI-ENV])
- [ ] Explicit licence acceptance flow; never accept on the user's behalf
- [ ] Status-bar target picker, switching the active framework ([MAUI-TARGETS], [NETFX-CONTEXT])
- [ ] Device discovery for Android, iOS simulators, iOS devices and the local machine, live-updating ([MAUI-TARGETS-DEVICES])
- [ ] Start and create Android emulators; boot iOS simulators
- [ ] Fixture solution `MauiFixtures.slnx` ([MAUI-TESTING])

### Phase 2: Run

- [ ] Run on the chosen device through the SDK `Run` target ([MAUI-RUN])
- [ ] Mapped build errors and per-step progress
- [ ] *Run on…* and *Debug on…* in the Solution Explorer
- [ ] `launch.json` platform and device fields
- [ ] Device Log channel per platform ([MAUI-LOGS])
- [ ] e2e: build, deploy, launch and a log line on each CI leg

### Phase 3: Debug

- [ ] Windows and Mac Catalyst through the existing adapter ([MAUI-DEBUG-CORECLR])
- [ ] Android emulator and device on .NET 11 (after R2)
- [ ] iOS simulator and device on .NET 11 (after R2)
- [ ] Exception breakpoints on every target
- [ ] C# and XAML hot reload on device (after R3; [XAML-HOT-RELOAD])
- [ ] .NET 10 Mono targets: Debug explains it is unavailable and how to retarget ([MAUI-DEBUG-MONO])
- [ ] e2e: breakpoint hit, step, variables and hot reload on each CI leg

### Phase 4: Assets

- [ ] `MauiImage`, `MauiIcon` and `MauiAsset` completion and diagnostics ([MAUI-ASSETS])
- [ ] Font alias completion and diagnostics
- [ ] Manifest and plist key completion

### Phase 5: Publish

- [ ] Publish command per platform ([MAUI-PUBLISH])
- [ ] Create and pick a keystore; secrets in secret storage only
- [ ] Pick a signing identity and provisioning profile; write the properties through the project DOM
- [ ] MSIX certificate selection
- [ ] Manual release checklist: physical Android device, physical iPhone, signed `.aab`, signed `.ipa`

### Phase 6: Device tests and Mono

- [ ] XHarness device tests in the Test Explorer ([MAUI-TESTS])
- [ ] Mono soft-debugger adapter on `Mono.Debugging.Soft` for .NET 10 targets ([MAUI-DEBUG-MONO])
- [ ] App Store Connect profile download

### Launch

- [ ] Blazor Hybrid fixture green across Razor and device features ([MAUI-BLAZOR-HYBRID])
- [ ] Website docs page and a YouTube film: "MAUI in VS Code on Android and iPhone, free"
