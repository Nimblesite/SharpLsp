// The ONE place a VS Code end-to-end timeout is chosen.
//
// A mocha timeout is a WALL-CLOCK CEILING, not a budget: nothing runs faster
// for having a larger one, and a hung test burns the whole ceiling before the
// suite can report. A 15-minute ceiling on a test whose slowest observed run is
// 3 seconds does not make CI more reliable — it makes one hang cost 15 minutes
// of runner time and hides the hang behind a wall of green.
//
// So every ceiling here is derived from MEASURED behaviour: the tiers below are
// the observed p-max of each class of work on the Ubuntu/Windows CI agents,
// with headroom. Scattered magic numbers are what let a 900_000 ceiling sit on
// a 300ms assertion; a named tier makes the claim reviewable.
//
// ── Choosing a tier ──────────────────────────────────────────────
//
//   Does the test spawn a `dotnet` CLI process?      -> DOTNET_CLI_MS
//   Does it drive a live debug session?              -> DEBUG_SESSION_MS
//   Does it await a semantic (sidecar) reply?        -> LSP_RESPONSE_MS
//   Does it round-trip one editor command?           -> COMMAND_MS
//   Is it pure in-process assertion?                 -> FAST_MS
//
// ── ONE initialization per suite ─────────────────────────────────
//
// The INITIALIZATION tiers at the bottom are for `suiteSetup`/`suiteTeardown`
// ONLY. A test body must never claim one: paying restore + build inside a test
// means the suite is initialising more than once, which is the thing the
// per-suite setup exists to prevent.
//
// A suite pays ONE initialization. Activating the extension, writing the
// fixture, restoring it and building it happen once in `suiteSetup`; every test
// after that reuses the same activated host, the same built assemblies and the
// same discovered tree. A suite that re-activates or re-builds per test is not
// a slow suite -- it is a suite whose second test can no longer prove anything
// about state the first one left behind, because there is none.
//
// That is also why the per-test ceilings below are SMALL. They are ceilings on
// incremental work against an already-warm host, not on the setup. A test that
// needs an initialization tier is either misplaced work or a suite missing a
// `suiteSetup`.
//
// Implements the timeout half of [DIST-CI-WIN-VSIX] and [DIST-CI-LAYOUT].

// ── Per-test ceilings ────────────────────────────────────────────

/**
 * Pure in-process work: parsers, tree builders, HTML rendering, manifest
 * conformance, pure functions over already-loaded state. No IPC, no editor
 * round trip, no disk beyond a temp file.
 *
 * Observed max across the suite: <200ms.
 */
export const FAST_MS = 500;

/**
 * One command round trip through the extension host — opening a document,
 * executing a contributed command, reading a tree node, awaiting a
 * configuration change. Crosses a process boundary but never reaches a sidecar.
 *
 * A NORMAL operation. One second, and that is the whole budget: an editor
 * round trip that has not answered in a second is not slow, it is broken, and
 * a ceiling that waits longer only delays the report.
 */
export const COMMAND_MS = 1_000;

/**
 * A test that rewrites SCOPED settings several times over -- user (`Global`) or
 * workspace, which cost the same.
 *
 * `COMMAND_MS` covers ONE command round trip. A `workspace.getConfiguration()
 * .update(...)` is heavier than that -- it writes a `settings.json` and waits
 * for the change event to propagate back through the extension host -- and a
 * test that does it four times costs four of them. Measured at 4.56s, which is
 * already above `COMMAND_MS`: a settings sweep is not a command round trip.
 */
export const SETTINGS_WRITE_MS = 12_000;

/**
 * One semantic request answered by a WARM sidecar: completion, hover,
 * definition, references, rename, code action, diagnostics refresh.
 *
 * Observed max: ~5.3s (F# code-fix generation). Cold first-request cost belongs
 * to {@link SIDECAR_COLD_MS} and is paid in `suiteSetup`, not here.
 */
export const LSP_RESPONSE_MS = 10_000;

/**
 * A live netcoredbg session: launch, bind breakpoints, step, evaluate, detach.
 *
 * Observed max: ~9.7s (hot reload applying an edit to a running session).
 */
export const DEBUG_SESSION_MS = 20_000;

/**
 * Ceiling for a TEST that drives a live debug session.
 *
 * Strictly above `DEBUG_SESSION_MS`, and it must stay that way. The debug kits
 * poll for stops, steps and termination at `DEBUG_SESSION_MS`; a test ending at
 * the same value means mocha always fires first, so the kit's diagnostic --
 * which stop reasons it actually saw -- is never printed and every failure in
 * the debug suites reads as an opaque timeout
 * ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
 */
export const DEBUG_TEST_MS = 25_000;

/**
 * A spawned `dotnet` console process becoming ready -- started, JIT'd, and
 * printing its first output.
 *
 * Sits below `DEBUG_SESSION_MS` so a test that starts a debuggee and then
 * attaches to it reports the poll's own message rather than an opaque hook
 * timeout. A budget of `DOTNET_CLI_MS` here could never elapse: the enclosing
 * test is killed first.
 */
export const PROCESS_START_MS = 15_000;

/**
 * A test that shells out to the real `dotnet` CLI — `build`, `test`, `run`,
 * `new` — against an ALREADY-RESTORED fixture. The restore itself is
 * initialization ({@link FIXTURE_BUILD_MS}); this is the incremental cost.
 *
 * Observed max: ~37s (cross-language rename rebuilding both languages).
 */
export const DOTNET_CLI_MS = 60_000;

/**
 * One semantic request per symbol, swept across a whole loaded solution.
 *
 * `LSP_RESPONSE_MS` covers ONE request. A test that resolves every symbol node
 * in the tree and compares each against the editor hover issues two sidecar
 * round trips per symbol, so its cost scales with the fixture, not with the
 * protocol. Measured at 31.9s over TestFixtures.sln on a warm Windows host.
 */
export const LSP_SWEEP_MS = 45_000;

/**
 * A test that deliberately KILLS or restarts the language server and waits for
 * it to serve again.
 *
 * The cold start is the assertion here, not setup, so it belongs in the test
 * body -- this is the one sanctioned exception to "initialization tiers are for
 * hooks". Sits above `SIDECAR_COLD_MS` so the post-restart poll reports before
 * the ceiling does.
 */
export const SERVER_RESTART_MS = 60_000;

// ── Initialization ceilings — `suiteSetup`/`suiteTeardown` ONLY ──

/**
 * Activating the extension: resolving the bundled host, spawning it, spawning
 * the Roslyn and FCS sidecars, and reaching the ready state.
 */
export const ACTIVATION_MS = 20_000;

/**
 * The FIRST semantic call against a freshly opened project, while the sidecar
 * cracks the project and loads its references.
 */
export const SIDECAR_COLD_MS = 45_000;

/**
 * A cold `dotnet restore` + `build` (and, for the Test Explorer, the VSTest
 * adapter JIT) over a fixture solution written moments earlier, on a CI agent
 * with a cold NuGet cache.
 */
export const FIXTURE_BUILD_MS = 180_000;

/**
 * Cloning, restoring and cold-loading a pinned THIRD-PARTY repository
 * (serilog, FluentValidation, FsToolkit.ErrorHandling). Ubuntu-only stress
 * suites; the Windows chunks never pay this.
 */
export const REAL_REPO_MS = 480_000;

/**
 * A warmup POLL inside a `REAL_REPO_MS` hook, not a ceiling of its own.
 *
 * It must sit strictly below the hook that contains it. A poll budget equal to
 * (or above) its hook can never elapse -- mocha kills the hook at the same
 * instant, so the helper's own "what did it actually see" message is never
 * printed and the failure reads as an opaque hook timeout
 * ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
 */
export const REAL_REPO_WARMUP_MS = 360_000;

// ── Runner-level ceilings ────────────────────────────────────────

/**
 * The ceiling a test inherits when it declares none.
 *
 * Deliberately one of the SMALL tiers. A suite that needs longer says so
 * explicitly, which is reviewable; a large default silently covers for every
 * test that never thought about its cost.
 */
export const DEFAULT_TEST_MS = LSP_RESPONSE_MS;

/**
 * Whole-run ceiling for one chunk, applied by the outer `vscode-test` wrapper.
 *
 * MUST stay below the CI job's `timeout-minutes` ([DIST-CI-VSIX-SHARDS]): when
 * the job is killed there is no mocha report at all, so a hang is diagnosed
 * from a truncated log. Reaching this means an entire chunk hung, not that a
 * chunk legitimately grew — the largest tier above is three minutes, and every
 * chunk pays it at most ONCE, in `suiteSetup`.
 */
export const WHOLE_RUN_MS = 15 * 60 * 1_000;

// ── Polling ──────────────────────────────────────────────────────

/** Gap between polls when waiting for an asynchronous condition. */
export const POLL_INTERVAL_MS = 100;

/**
 * How long to watch for something that must NOT happen. A negative assertion
 * proves nothing beyond the window it observes, so this is deliberately short:
 * a longer quiet window buys almost no additional confidence and costs its
 * length on every single run.
 */
export const QUIET_MS = 2_500;
