/**
 * MTP invocation and reporter negotiation, and how a module is STARTED.
 * Implements [TEST-MTP-RUN] and [NETFX-TEST-MTP].
 */
import * as path from 'node:path';
import { DOTNET_TIMEOUT_MS, runDotnet, runProcess, type DotnetRun } from './dotnet-process.js';
import type { TestRunOptions } from './test-execution.js';
import { netFrameworkDebugRefusal } from './test-frameworks.js';
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
  return path.extname(modulePath).toLowerCase() === '.exe';
}

/** Why a .NET Framework module must not start: off Windows, or under Debug. */
function netFrameworkRefusal(modulePath: string, options: TestRunOptions): string | undefined {
  const name = path.basename(modulePath);
  if (process.platform !== 'win32') return `${name} targets .NET Framework, which runs only on Windows`;
  return options.debug === true ? netFrameworkDebugRefusal(name) : undefined;
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
  const refusal = netFrameworkRefusal(modulePath, options);
  if (refusal === undefined) return await runProcess(modulePath, moduleArgs, cwd, timeoutMs, signal, hooks);
  return { stdout: '', stderr: '', failed: true, killed: false, exitCode: undefined, errorMessage: refusal };
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
  return ['exec', modulePath, ...moduleRunArgs(uids, resultsDirectory, options, trxName, reporter)];
}

/** The module's own arguments for one invocation. Debug writes no report. */
function moduleRunArgs(
  uids: readonly string[],
  resultsDirectory: string,
  options: TestRunOptions,
  trxName: string,
  reporter: Reporter,
): string[] {
  return [
    ...(uids.length === 0 ? [] : ['--filter-uid', ...uids]),
    ...(options.debug === true
      ? []
      : [`--report-${reporter}`, `--report-${reporter}-filename`, trxName]),
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
  const args = moduleRunArgs(uids, resultsDirectory, options, trxName, reporter);
  return await runModule(modulePath, args, cwd, options);
}
