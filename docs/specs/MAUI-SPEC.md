# [MAUI-SPEC] .NET MAUI and Mobile: Environment, Devices, Run, Debug and Publish

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md) · **Plan:** [MAUI-PLAN.md](../plans/MAUI-PLAN.md) · **XAML:** [XAML-SPEC.md](XAML-SPEC.md)

## [MAUI-OVERVIEW] Overview

XAML intelligence is half of MAUI support ([XAML-SPEC]). The other half is the device loop: setting up the environment, picking a device, deploying, debugging, reading logs, and publishing a signed build. SharpLsp owns that whole loop in VS Code, for C# and F# alike.

- **Only the SDK's own tools.** Every action runs the .NET SDK's MSBuild targets and the platform vendors' command-line tools (`adb`, `emulator`, `xcrun`, `security`). SharpLsp never ships a private build or deploy pipeline.
- **Machine-readable output only.** A tool's output is read from its JSON or machine-readable form, never by matching text. A tool without one is wrapped by the SDK target that already reads it.
- **Never silent.** Every failed step names the tool, the step and the fix, and links the log ([REFACTOR-NEVER-SILENT]).

## [MAUI-SCOPE] Scope

### [MAUI-SCOPE-PROJECTS] Projects

- **.NET MAUI apps:** `<UseMaui>true</UseMaui>`, including Blazor Hybrid apps.
- **Plain mobile apps:** `net11.0-android`, `net11.0-ios` and `net11.0-maccatalyst` apps with no MAUI ([vscode-dotnettools #470](https://github.com/microsoft/vscode-dotnettools/issues/470)).
- **F# projects:** an F# MAUI or mobile project (for example, on Fabulous) gets every feature here. The SDK targets are language-neutral, so nothing is C#-only.

### [MAUI-SCOPE-VERSIONS] Versions

- **.NET 11:** supported in full. MAUI on Android, iOS and Mac Catalyst runs on CoreCLR by default from .NET 11, and Mono is no longer supported there (NETSDK1242).
- **.NET 10:** supported for environment setup, run and publish. Debugging on Mono targets needs a Mono soft-debugger adapter, which is a later phase ([MAUI-DEBUG-MONO]).

### [MAUI-SCOPE-HOSTS] Host OS

| Target | Windows | macOS | Linux |
|---|---|---|---|
| Android (device, emulator) | ✓ | ✓ | ✓ |
| iOS (simulator, device) | — | ✓ | — |
| Mac Catalyst | — | ✓ | — |
| Windows (WinUI) | ✓ | — | — |

Visual Studio's *Pair to Mac* is proprietary. SharpLsp builds for iOS on a Mac only. A Windows user reaches a Mac through the editor's remote features (VS Code Remote-SSH), where SharpLsp runs on the Mac.

### [MAUI-SCOPE-OUT] Out of Scope

- **Store uploads:** Google Play and App Store Connect.
- **Proprietary tooling:** Xamarin.Forms, Visual Studio's remote iOS simulator, and Visual Studio's XAML Live Preview.

## [MAUI-ENV] Environment Doctor

Failing to find the Android SDK, the JDK or Xcode is the most common first-run failure ([evidence](../plans/MAUI-PLAN.md)). A *MAUI: Check Environment* command, which also runs on first open of a MAUI project, checks each requirement and offers the fix.

| Check | How it is read | Fix offered |
|---|---|---|
| .NET SDK and workloads the project needs | `dotnet workload restore` dry run against the project | Run `dotnet workload restore` for the project |
| Android SDK and JDK | The SDK's `InstallAndroidDependencies` target's resolution of `AndroidSdkDirectory` and `JavaSdkDirectory` | Run `InstallAndroidDependencies` into a chosen folder |
| Android SDK licences | That target's licence state | Show the licences, then accept them only on the user's explicit confirmation |
| Xcode and its command-line tools | `xcode-select -p` and `xcodebuild -version`, checked against the iOS workload's required Xcode | Open the App Store or Apple's download page; SharpLsp never installs Xcode |
| Windows App SDK runtime | The WinUI workload's own check | Run the workload's install |

- **Results:** each check reports pass, fail or skipped, with the version found, in a *MAUI Environment* view.
- **Elevation:** a fix that needs elevation (a machine-wide workload install) says so and runs in a visible terminal.

## [MAUI-TARGETS] Target Picker

A status-bar item shows the active platform and device, for example *Android · Pixel 8 (emulator)*. Choosing it lists every platform the project targets and every device for each.

- **Platform switch:** switching the platform switches the project's active framework ([NETFX-CONTEXT]). `#if ANDROID` blocks and `Platforms/Android/` files become live, and diagnostics follow.
- **Persistence:** the choice is per workspace, kept in workspace state, never in the project file.

### [MAUI-TARGETS-DEVICES] Device Discovery

| Kind | Source |
|---|---|
| Android devices | `adb devices -l` through the Android workload's device listing |
| Android emulators | `emulator -list-avds`; an emulator not yet running can be started from the picker |
| iOS simulators | `xcrun simctl list devices --json`, filtered to the runtimes the project supports |
| iOS devices | `xcrun devicectl list devices --json-output` |
| Mac Catalyst, Windows | The local machine |

- **Live updates:** the list refreshes when a device is plugged in or an emulator boots ([VSCODE-REACTIVITY]). A device that is locked, untrusted or in developer mode *off* is listed with the step that fixes it.
- **Emulator images:** *Create Emulator* runs the Android SDK's `avdmanager` with a system image the user picks.

## [MAUI-RUN] Build, Deploy and Run

- **Run:** *Run* and *Debug* build the active platform's framework and deploy to the chosen device through the SDK's `Run` target (`dotnet build -t:Run -f <tfm>`), passing the device as the SDK's device-selection property. The exact properties are confirmed in research ([MAUI-PLAN-RESEARCH]).
- **Progress:** build, install and launch each show progress. A failure points at its MSBuild error, mapped to the file ([DIAG-SPEC]).
- **Solution Explorer:** the project's context menu gains *Run on…* and *Debug on…* with the device list ([SE-ACTIONS-RUN-DEBUG]).
- **Launch configurations:** a `launch.json` configuration can name a platform and device, so F5 runs on that device.

## [MAUI-DEBUG] Debugging

### [MAUI-DEBUG-CORECLR] CoreCLR Targets

The Windows target already runs on CoreCLR, and from .NET 11 so do Android, iOS and Mac Catalyst. They are debugged through the existing debug adapter ([DEBUG-ADAPTER-NETCOREDBG]) and later the Debug Sidecar.

- **Local targets:** Windows and Mac Catalyst launch locally, like any .NET app.
- **Device targets:** a device or emulator target is attached remotely. How ICorDebug reaches a CoreCLR runtime on a device (the diagnostics port, `dotnet-dsrouter`, or the SDK's debug-launch targets) is research item R2 ([MAUI-PLAN-RESEARCH]).
- **Features:** breakpoints, stepping, exception breakpoints, the debug console, and hot reload ([DEBUG-FEATURES-HOT-RELOAD], [XAML-HOT-RELOAD]) work on every target. Exception breakpoints are listed explicitly because their absence in MAUI projects is a reported gap ([vscode-dotnettools #936](https://github.com/microsoft/vscode-dotnettools/issues/936)).

### [MAUI-DEBUG-MONO] Mono Targets (.NET 10)

.NET 10 Android, iOS and Mac Catalyst apps run on Mono. They need a Mono soft-debugger adapter built on the MIT `Mono.Debugging.Soft` library. That adapter is a later phase. Until then, Run works on those targets and Debug says why it is unavailable, and that retargeting to .NET 11 enables it.

## [MAUI-LOGS] Device Logs

A *Device Log* output channel streams the running app's log, filtered to its process:

- **Android:** `adb logcat` for the app's process ID;
- **iOS simulator:** `xcrun simctl spawn <udid> log stream`, with a predicate on the app's process;
- **iOS device:** the device console, through `devicectl`;
- **Mac Catalyst and Windows:** the process's standard output and error.

These are the user's own app logs, shown to the user. They never enter SharpLsp's own logs ([SHARPLSP-SPEC] Logging).

## [MAUI-ASSETS] App Assets

MAUI's single-project assets are build items. SharpLsp makes them first-class in XAML and C#.

- **Images:** `MauiImage` and `MauiIcon` items are completed by name wherever an `ImageSource` is expected, under the name Resizetizer gives them (`dotnet_bot.svg` is referenced as `dotnet_bot.png`). A name with no item is a diagnostic.
- **Fonts:** font aliases registered with `ConfigureFonts` complete in `FontFamily` values. An unknown alias is a diagnostic.
- **Raw assets:** `MauiAsset` names complete in `FileSystem.OpenAppPackageFileAsync`.
- **Platform manifests:** `AndroidManifest.xml`, `Info.plist` and `Entitlements.plist` get completion for permission names and keys, from the platform SDK's published lists.

## [MAUI-PUBLISH] Signing and Publishing

A *Publish* command builds a signed release package for the active platform.

| Platform | Package | Signing |
|---|---|---|
| Android | `.aab` or `.apk` | A keystore the user creates or picks. *Create Keystore* runs the JDK's `keytool` |
| iOS | `.ipa` | A signing identity from `security find-identity -v -p codesigning` and a provisioning profile from the user's installed profiles |
| Mac Catalyst | `.app` or `.pkg` | As iOS |
| Windows | `.msix` | A certificate the user picks |

- **Secrets:** keystore and certificate passwords live in the editor's secret storage. They never go into the project file, the command line, the terminal or logs. They reach MSBuild only through environment variables of the publish process.
- **Project edits:** signing properties (`CodesignKey`, `CodesignProvision`, `AndroidSigningKeyStore`) are written into a `Release` property group through the project DOM ([STRUCTURED-FILE-DOM-PLAN.md](../plans/STRUCTURED-FILE-DOM-PLAN.md)), never by text edits.
- **Later:** downloading provisioning profiles from Apple with an App Store Connect API key is a later phase ([vscode-dotnettools #1539](https://github.com/microsoft/vscode-dotnettools/issues/1539)).

## [MAUI-TESTS] Device Tests

Unit tests that must run on a device run through XHarness (MIT), the runner the .NET MAUI repository itself uses. Their results appear in the Test Explorer beside desktop tests ([TEST-EXPLORER]).

## [MAUI-BLAZOR-HYBRID] Blazor Hybrid

".net maui blazor" is the second-biggest MAUI query on the web and on YouTube. A MAUI Blazor Hybrid project (`Sdk="Microsoft.NET.Sdk.Razor"` with `UseMaui`) gets full Razor support ([RAZOR-SPEC]) and every device feature here. The test fixture includes one.

## [MAUI-ERRORS] Degradation

- **Missing tool:** a missing tool disables only the features that need it, and the environment view names it.
- **No devices:** the picker offers to start an emulator or simulator, or explains how to connect a device.
- **Tool failure:** a tool that exits with an error shows its exit code and the step. Its full output goes to the *MAUI* output channel, never to SharpLsp's structured logs.

## [MAUI-TESTING] Tests

- **Fixture:** `src/sharplsp/tests/fixtures/maui/MauiFixtures.slnx`, with a MAUI app, a MAUI Blazor Hybrid app, a plain `net11.0-android` app and an F# MAUI app.
- **Tool output:** tool output parsing is tested end to end against recorded real JSON from `simctl`, `devicectl` and `adb`, checked in as fixtures.
- **CI legs:**
  - Android emulator on Linux;
  - iOS simulator and Mac Catalyst on macOS;
  - Windows on Windows.

  Each leg runs build, deploy, launch, a breakpoint hit and a log line. Device-only features (physical iOS, signing) have manual release checks listed in the plan.
- **Cost:** the emulator and simulator legs run only when MAUI paths change, so they don't raise GitHub Actions spend on unrelated PRs.
