/**
 * Splitting one argument list into command lines a process can actually take.
 *
 * Windows caps a process command line at 32 767 characters, and past it Node's
 * `spawn` THROWS SYNCHRONOUSLY — `spawn ENAMETOOLONG`, before `dotnet` ever
 * runs. Three argument lists reach that: the assemblies handed to one
 * `dotnet vstest`, the `--filter` expression of one `dotnet test`, and the
 * `--filter-uid` values of one MTP module. All three batch by the same rule, so
 * they batch through the same function.
 *
 * Implements [TEST-DISCOVERY-FQN], [TEST-FILTER-ESCAPE] and [TEST-MTP-RUN].
 */

/**
 * Ceiling on one argument list. The list is one part of a whole vector — the
 * executable, the target, the results directory — so the budget leaves the
 * whole vector well under the real limit.
 */
export const MAX_ARG_CHARS = 24_000;

/**
 * Split `items` into batches whose joined argument text stays under `maxChars`.
 *
 * A single over-budget item still gets its OWN batch: dropping it silently
 * would lose a runnable test, and splitting it would corrupt the argument.
 */
export function batchByWidth<T>(
  items: readonly T[],
  cost: (item: T) => number,
  maxChars: number = MAX_ARG_CHARS,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let width = 0;
  for (const item of items) {
    const size = cost(item);
    if (current.length > 0 && width + size > maxChars) {
      batches.push(current);
      current = [];
      width = 0;
    }
    current.push(item);
    width += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
