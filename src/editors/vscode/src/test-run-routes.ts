/**
 * Which runner runs which test, when one sweep found BOTH.
 *
 * The runner is chosen per discovery TARGET ([TEST-MTP-DETECT]), and a
 * multi-root workspace with no solution loaded has one target per folder. So
 * one tree can hold VSTest tests beside Microsoft.Testing.Platform tests, and
 * one ▶ can select from both. Each id goes to the runner that discovered it: an
 * MTP module OWNS its ids, and every other id is a VSTest filter value, exactly
 * as it was before MTP existed. Sending everything to MTP whenever any folder
 * was MTP left every VSTest test reporting "No result reported".
 *
 * Implements [TEST-MTP-ROUTING].
 */

import { mergePlans, ownedBy, type MtpRunPlan, type TestListing } from './test-listing-model.js';
import { mergeKeepingFailures, runMtpTests } from './test-mtp-run.js';
import { runTests, type TestRunOptions, type TestRunOutcome } from './test-execution.js';

/** What the last discovery sweep found, as far as running it goes. */
export interface RunnerMap {
  /** How to run the MTP tests, when any target was MTP. */
  readonly mtp: MtpRunPlan | undefined;
  /** True when at least one target was enumerated by VSTest. */
  readonly vstest: boolean;
}

/** The runners of a sweep that found nothing yet: VSTest, as ever. */
export const VSTEST_ONLY: RunnerMap = { mtp: undefined, vstest: true };

/**
 * The runners one sweep's listings call for. A listing with no MTP plan that
 * named any test was VSTest's; with no MTP plan at all, VSTest runs everything.
 */
export function runnersFor(listings: readonly TestListing[]): RunnerMap {
  const mtp = mergePlans(
    listings.flatMap((listing) => (listing.mtp === undefined ? [] : [listing.mtp])),
  );
  const vstest = listings.some((listing) => listing.mtp === undefined && listing.names.length > 0);
  return { mtp, vstest: vstest || mtp === undefined };
}

/** One runner and the ids it gets; no ids means "everything it discovered". */
export type RunnerCall =
  | { readonly runner: 'vstest'; readonly ids: readonly string[] }
  | { readonly runner: 'mtp'; readonly plan: MtpRunPlan; readonly ids: readonly string[] };

/**
 * The invocations one selection needs, VSTest first.
 *
 * With only one runner discovered, it gets every id — an id no module owns
 * still goes where it always went. With both, the whole tree (no ids) starts
 * both, and a selection is split by ownership; a half with no id is not started.
 */
export function splitByRunner(runners: RunnerMap, ids: readonly string[]): RunnerCall[] {
  const plan = runners.mtp;
  if (plan === undefined) return [{ runner: 'vstest', ids }];
  if (!runners.vstest) return [{ runner: 'mtp', plan, ids }];
  if (ids.length === 0)
    return [
      { runner: 'vstest', ids },
      { runner: 'mtp', plan, ids },
    ];
  const vstest = ids.filter((id) => !ownedBy(plan, id));
  const mtp = ids.filter((id) => ownedBy(plan, id));
  return [
    ...(vstest.length > 0 ? [{ runner: 'vstest' as const, ids: vstest }] : []),
    ...(mtp.length > 0 ? [{ runner: 'mtp' as const, plan, ids: mtp }] : []),
  ];
}

/** One invocation of one runner. */
async function invokeRunner(
  call: RunnerCall,
  cwd: string,
  options: TestRunOptions,
): Promise<TestRunOutcome> {
  if (call.runner === 'vstest') return await runTests(call.ids, cwd, options);
  return await runMtpTests(call.plan, call.ids, cwd, options);
}

/**
 * Run `ids` (all tests when empty) with whichever runner owns each, and merge
 * what came back. Each runner answers for its own tests, so a failure of one
 * is kept beside the other's results rather than erased by them.
 */
export async function runRouted(
  runners: RunnerMap,
  ids: readonly string[],
  cwd: string,
  options: TestRunOptions,
): Promise<TestRunOutcome> {
  const [first, ...rest] = splitByRunner(runners, ids);
  // A non-empty selection always has an owner, so `first` exists; VSTest is
  // where an id with none has always gone.
  let merged = await invokeRunner(first ?? { runner: 'vstest', ids }, cwd, options);
  for (const call of rest) {
    merged = mergeKeepingFailures(merged, await invokeRunner(call, cwd, options));
  }
  return merged;
}
