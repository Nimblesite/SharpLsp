/** MTP invocation and reporter negotiation. Implements [TEST-MTP-RUN]. */
import { DOTNET_TIMEOUT_MS, runDotnet, type DotnetRun } from './dotnet-process.js';
import type { TestRunOptions } from './test-execution.js';
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

/** The argument vector for one module invocation. Debug writes no report. */
export function runArgs(
  modulePath: string,
  uids: readonly string[],
  resultsDirectory: string,
  options: TestRunOptions,
  trxName: string,
  reporter: Reporter = 'trx',
): string[] {
  return [
    'exec',
    modulePath,
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
  return await runDotnet(
    runArgs(modulePath, uids, resultsDirectory, options, trxName, reporter),
    cwd,
    options.timeoutMs ?? DOTNET_TIMEOUT_MS,
    options.signal,
    options.hooks,
  );
}
