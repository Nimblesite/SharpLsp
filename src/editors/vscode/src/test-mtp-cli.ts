/**
 * Microsoft.Testing.Platform, second dialect: the command line `xunit.v3` gives
 * its test module when it does NOT delegate to MTP's option manager.
 *
 * `xunit.v3` 4.0.0 registers Microsoft.Testing.Platform's own options and a
 * module built from it answers `--list-tests json`. From 4.0.1 the package
 * ships its OWN runner console instead: every MTP option is refused with
 * `error: unknown option: --filter-uid` — discovery lists nothing, a run
 * reports nothing, and on the .NET 10 SDK the VSTest target refuses the project
 * outright (#581). The module still answers two commands of its own:
 *
 *   • `-list full/json` — every test case as one JSON document;
 *   • `-id <uid>` (repeatable) with `-result-trx <file>` — a run selected by the
 *     uids the listing reported, reported as the same TRX [TEST-RUN-TRX] reads.
 *
 * Which dialect a module speaks is learned from the module itself — never from
 * a package version guessed out of a project file — by trying the MTP listing
 * and reading the refusal ([TEST-MTP-DISCOVERY]). This module is PURE: the
 * readers, the argument vectors, and nothing that touches a process.
 *
 * Implements [TEST-MTP-DISCOVERY], [TEST-MTP-RUN]; issue #581.
 */

import { joinPath } from './paths';
import type { MtpListing, MtpTest } from './test-mtp.js';

/** Which command line a test module speaks. */
export type MtpCli = 'mtp' | 'xunit';

/** The module's own arguments asking the xunit.v3 runner for its tests. */
export const XUNIT_LIST_OPTIONS: readonly string[] = ['-list', 'full/json'];

/** The `dotnet exec` argument vector that lists an xunit.v3 module's tests. */
export function xunitListArgs(modulePath: string): string[] {
  return ['exec', modulePath, ...XUNIT_LIST_OPTIONS];
}

/** A non-empty string at `key`, or `undefined`. */
function text(bag: Record<string, unknown>, key: string): string | undefined {
  const value = bag[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The id of one listed xunit.v3 test: its class and method, the same
 * `className` + `.` + `name` pair the module's own TRX report carries, so
 * [TEST-RUN-TRX] attributes outcomes with no change. The DISPLAY name is never
 * the id: it is `classAndMethod` only by default, and `-methodDisplay method`
 * would make it the BARE method name — the issue-#180 defect.
 */
function idOf(entry: Record<string, unknown>): string | undefined {
  const className = text(entry, 'Class');
  const method = text(entry, 'Method');
  return className !== undefined && method !== undefined
    ? `${className}.${method}`
    : (text(entry, 'DisplayName') ?? undefined);
}

/** One `-list full/json` entry, or `undefined` when it carries no usable uid. */
function toTest(entry: unknown): MtpTest | undefined {
  if (!isRecord(entry)) return undefined;
  const uid = text(entry, 'ID');
  if (uid === undefined) return undefined;
  const label = text(entry, 'DisplayName') ?? uid;
  // The xunit.v3 listing reports no source location; [TEST-GOTO-SOURCE]
  // locates the test from the workspace symbols instead.
  return { id: idOf(entry) ?? label, uid, label, file: undefined, line: undefined };
}

/** The JSON document inside a module's stdout, or `undefined`. */
function documentIn(stdout: string): unknown {
  // The runner prints the array as THE document — nothing before it but a blank
  // line or a byte-order mark, so a `{` first means this is no listing at all.
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end <= start) return undefined;
  const lead = stdout
    .slice(0, start)
    .replace(/^\uFEFF/, '')
    .trim();
  if (lead !== '') return undefined;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** True for a plain object, so a JSON shape is narrowed before it is read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read one module's `-list full/json` answer. Never throws. */
export function parseXunitTestList(stdout: string): MtpListing {
  // The document is the ARRAY the runner prints, nothing before it; anything
  // else is no listing at all, whatever else it might be.
  const document = documentIn(stdout);
  if (!Array.isArray(document)) {
    return { tests: [], warnings: ['Test listing was not a JSON document'] };
  }
  const tests = document
    .map((entry) => toTest(entry))
    .filter((test): test is MtpTest => test !== undefined);
  const warnings: string[] = [];
  if (tests.length !== document.length)
    warnings.push('Test listing contained nodes without usable IDs');
  return { tests, warnings };
}

/** How an xunit.v3 module starts the line refusing an option it does not know. */
const UNKNOWN_OPTION = 'error: unknown option: ';

/** How it starts the line refusing an option that was given no argument. */
const MISSING_ARGUMENT = 'error: missing argument for ';

/**
 * The option an xunit.v3 module refused, or `undefined`.
 *
 * The refusal is this runner's own shape — `error: unknown option: --filter-uid`
 * — lower-cased, unquoted, and painted with ANSI colour even when redirected.
 * MTP's own refusals keep their own shape ([TEST-MTP-DISCOVERY]), so the two
 * never collide and this never matches one.
 */
export function rejectedXunitOption(output: string): string | undefined {
  for (const raw of output.split('\n')) {
    const name = refusedName(stripAnsi(raw.trim()));
    if (name !== undefined) return name;
  }
  return undefined;
}

/** The refused option of one line, when the line is a refusal. */
function refusedName(line: string): string | undefined {
  for (const shape of [UNKNOWN_OPTION, MISSING_ARGUMENT]) {
    if (line.startsWith(shape)) {
      const name = line.slice(shape.length).trim();
      if (name !== '') return name;
    }
  }
  return undefined;
}

/** `line` with every ANSI escape sequence removed. */
function stripAnsi(line: string): string {
  let plain = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';
    if (character !== '\u001B') {
      plain += character;
      continue;
    }
    const end = line.indexOf('m', index);
    if (end === -1) return plain;
    index = end;
  }
  return plain;
}

/**
 * The module's own arguments for one xunit.v3 invocation.
 *
 * `-id` takes the listing's `ID` verbatim and may repeat; a uid is a hex
 * digest, so the literal value needs no escaping, exactly as `--filter-uid`
 * needs none ([TEST-MTP-RUN]). `-result-trx` takes the report's whole path —
 * the runner has no `--results-directory`. There is no coverage option to
 * forward: the collection request is answered by the caller, not the module.
 */
export function xunitRunArgs(
  uids: readonly string[],
  resultsDirectory: string,
  trxName: string,
): string[] {
  return [
    '-noLogo',
    '-noColor',
    '-result-trx',
    joinPath(resultsDirectory, trxName),
    ...uids.flatMap((uid) => ['-id', uid]),
  ];
}
