/**
 * MTP invocation and reporter negotiation, and how a module is STARTED.
 * Implements [TEST-MTP-RUN] and [NETFX-TEST-MTP].
 */
import * as fs from 'node:fs';
import { directoryOf, fileNameOf, hasExtension, joinPath } from './paths';
import { info } from './log';
import { DOTNET_TIMEOUT_MS, runDotnet, runProcess, type DotnetRun } from './dotnet-process.js';
import type { TestRunOptions, TestRunOutcome } from './test-execution.js';
import { netFrameworkDebugRefusal } from './test-frameworks.js';
import type { MtpModuleRun } from './test-listing-model.js';
import { rejectedMtpOption } from './test-mtp.js';

type Reporter = 'trx' | 'xunit-trx';

interface MtpInvocation {
  readonly modulePath: string;
  readonly uids: readonly string[];
  readonly resultsDirectory: string;
  readonly cwd: string;
  readonly options: TestRunOptions;
  readonly trxName: string;
}

/**
 * True for a .NET Framework module: MSBuild's `TargetPath` for it is the
 * `<Name>.exe` itself, while a .NET module's is always its `.dll`.
 */
export function isNetFrameworkModule(modulePath: string): boolean {
  return hasExtension(modulePath, '.exe');
}

/** Why a .NET Framework module must not start: it runs only on Windows. */
function netFrameworkRefusal(modulePath: string): string | undefined {
  return process.platform === 'win32'
    ? undefined
    : `${fileNameOf(modulePath)} targets .NET Framework, which runs only on Windows`;
}

/** A run's modules: those it starts, and the .NET Framework ones Debug refuses. */
export interface StartedModules {
  readonly start: readonly MtpModuleRun[];
  readonly refused: readonly MtpModuleRun[];
}

/**
 * The modules a run starts. Under Debug only .NET modules start: nothing can
 * attach to the desktop CLR. A .NET Framework module is REFUSED when a selected
 * test it carries has no .NET module; otherwise its tests are debugged under
 * .NET and it is left out ([NETFX-DEBUG]).
 */
export function startedModules(
  modules: readonly MtpModuleRun[],
  testIds: readonly string[],
  options: TestRunOptions,
): StartedModules {
  if (options.debug !== true) return { start: modules, refused: [] };
  const isNet = (module: MtpModuleRun): boolean => !isNetFrameworkModule(module.modulePath);
  const netIds = new Set(modules.filter(isNet).flatMap((module) => [...module.uidsById.keys()]));
  const selected = (module: MtpModuleRun): string[] =>
    testIds.length === 0
      ? [...module.uidsById.keys()]
      : testIds.filter((id) => module.uidsById.has(id));
  const netFrameworkOnly = (module: MtpModuleRun): boolean =>
    !isNet(module) && selected(module).some((id) => !netIds.has(id));
  return { start: modules.filter(isNet), refused: modules.filter(netFrameworkOnly) };
}

/**
 * A refused module's outcome: nothing ran, and the refusal is its failure.
 * Log this constructed refusal once; settlement never logs arbitrary failure content.
 */
export function refusedOutcome(module: MtpModuleRun): TestRunOutcome {
  const refusal = netFrameworkDebugRefusal(fileNameOf(module.modulePath));
  info(`Test debug: ${refusal}`);
  return {
    results: new Map(),
    summary: undefined,
    failure: refusal,
    runInfos: [],
    retriedUnfiltered: false,
    durationMs: 0,
    output: '',
  };
}

/**
 * Start a module with `moduleArgs`: a .NET Framework `.exe` as ITSELF —
 * `dotnet exec` cannot host the desktop CLR — and any other through
 * `dotnet exec`, which needs no apphost and no execute bit. Never rejects.
 */
export async function runModule(
  modulePath: string,
  moduleArgs: readonly string[],
  cwd: string,
  options: TestRunOptions,
): Promise<DotnetRun> {
  const timeoutMs = options.timeoutMs ?? DOTNET_TIMEOUT_MS;
  const { signal, hooks } = options;
  if (!isNetFrameworkModule(modulePath)) {
    return await runDotnet(['exec', modulePath, ...moduleArgs], cwd, timeoutMs, signal, hooks);
  }
  const refusal = netFrameworkRefusal(modulePath);
  if (refusal === undefined)
    return await runProcess(modulePath, moduleArgs, cwd, timeoutMs, signal, hooks);
  return {
    stdout: '',
    stderr: '',
    failed: true,
    killed: false,
    exitCode: undefined,
    errorMessage: refusal,
  };
}

/** The `dotnet exec` argument vector for one module invocation. */
export function runArgs(
  modulePath: string,
  uids: readonly string[],
  resultsDirectory: string,
  options: TestRunOptions,
  trxName: string,
  reporter: Reporter = 'trx',
): string[] {
  const report = reportFor(modulePath, options, reporter);
  return ['exec', modulePath, ...moduleRunArgs(uids, resultsDirectory, options, trxName, report)];
}

/** Assemblies a module's build puts beside it: xunit.v3, the TRX extension, NUnit's adapter. */
const XUNIT_V3_CORE = 'xunit.v3.core.dll';
const TRX_REPORT = 'Microsoft.Testing.Extensions.TrxReport.dll';
const NUNIT_ADAPTER = 'NUnit3.TestAdapter.dll';

/** True when the module's build put `assembly` beside it. */
function builtBeside(modulePath: string, assembly: string): boolean {
  return fs.existsSync(joinPath(directoryOf(modulePath), assembly));
}

/**
 * The report one invocation writes. A DEBUG run passes only a reporter the module
 * was built with: xUnit's own, which runs inside the test host, else the TRX
 * extension, whose controller the Debug profile releases once its test host waits.
 * A module with neither writes none ([TEST-MTP-DEBUG], [TEST-RUN-OUTPUT]).
 */
function reportFor(
  modulePath: string,
  options: TestRunOptions,
  reporter: Reporter,
): Reporter | undefined {
  if (options.debug !== true) return reporter;
  if (builtBeside(modulePath, XUNIT_V3_CORE)) return 'xunit-trx';
  return builtBeside(modulePath, TRX_REPORT) ? 'trx' : undefined;
}

/**
 * The uids a DEBUGGED module starts with. NUnit's bridge refuses any uid carrying
 * a space — every idiomatic F# backtick test — by THROWING, and under a debugger
 * that unhandled exception stops the module instead of ending it. So such a
 * selection runs the module unfiltered: the selected tests' breakpoints still
 * bind, and only they are reported ([TEST-MTP-DEBUG], [TEST-FILTER-ESCAPE]).
 */
export function debugUids(modulePath: string, uids: readonly string[]): readonly string[] {
  const refused = builtBeside(modulePath, NUNIT_ADAPTER) && uids.some((uid) => uid.includes(' '));
  return refused ? [] : uids;
}

/** The module's own arguments for one invocation; `report` names the report it writes, if any. */
function moduleRunArgs(
  uids: readonly string[],
  resultsDirectory: string,
  options: TestRunOptions,
  trxName: string,
  report: Reporter | undefined,
): string[] {
  return [
    ...(uids.length === 0 ? [] : ['--filter-uid', ...uids]),
    ...(report === undefined ? [] : [`--report-${report}`, `--report-${report}-filename`, trxName]),
    '--results-directory',
    resultsDirectory,
    '--no-banner',
    '--no-ansi',
    // `--no-progress` is deprecated since MTP 2.3 and warns on every run.
    ...(options.coverage === true ? ['--coverage', '--coverage-output-format', 'cobertura'] : []),
  ];
}

/** A rejected optional reporter must not make a runnable xUnit project fail. */
export async function runReported(invocation: MtpInvocation): Promise<DotnetRun> {
  const standard = await runReporter(invocation, 'trx');
  const { options } = invocation;
  if (options.debug === true || options.signal?.aborted === true) return standard;
  if (!refusedReporter(standard, '--report-trx')) return standard;
  // Command-line validation ran no tests. Keep the selection and report name.
  const fallback = await runReporter(invocation, 'xunit-trx');
  return refusedReporter(fallback, '--report-xunit-trx') ? standard : fallback;
}

/** Missing reporters on other frameworks keep the original package diagnosis. */
function refusedReporter(run: DotnetRun, option: string): boolean {
  return !run.killed && run.failed && rejectedMtpOption(`${run.stdout}\n${run.stderr}`) === option;
}

/** Both reporter attempts share cancellation, hooks, coverage, and literal UIDs. */
async function runReporter(invocation: MtpInvocation, reporter: Reporter): Promise<DotnetRun> {
  const { modulePath, uids, resultsDirectory, cwd, options, trxName } = invocation;
  const report = reportFor(modulePath, options, reporter);
  const args = moduleRunArgs(uids, resultsDirectory, options, trxName, report);
  return await runModule(modulePath, args, cwd, options);
}
