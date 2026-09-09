/**
 * Microsoft.Testing.Platform: choosing the runner, and reading what a test
 * module reports.
 *
 * An MTP test project builds to an EXECUTABLE test module, and that module —
 * not `vstest.console` — discovers and runs its own tests. Every VSTest command
 * fails against it: `--nologo` is not a valid MTP option, `dotnet vstest`
 * cannot load the assembly, and neither `--filter` nor `--logger trx` exists.
 *
 * This module is PURE: no process, no VS Code. It decides which runner a target
 * uses, and it turns the module's `--list-tests json` answer into test ids.
 *
 * Implements [TEST-MTP-DETECT] and [TEST-MTP-DISCOVERY].
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRecord } from './utils.js';

/** The `global.json` value that selects MTP, lower-cased for comparison. */
const MTP_RUNNER = 'microsoft.testing.platform';

/** The JSON listing schema this reader was written against. */
const KNOWN_SCHEMA_VERSION = 1;

/** One test node a module reported. */
export interface MtpTest {
  /**
   * `namespace.Type.Method`, the Test Explorer's id. Built from the listing's
   * `type` block and NEVER from its display name: MSTest reports the BARE
   * method name as the display name, which is the issue-#180 defect again.
   */
  readonly id: string;
  /** The module's own run key, passed back verbatim to `--filter-uid`. */
  readonly uid: string;
  /** The name the module shows a human. Carries row data; a label, not a key. */
  readonly label: string;
  /** Source file, when the framework reports one. NUnit does not. */
  readonly file: string | undefined;
  /** 1-based first line of the test, when the framework reports one. */
  readonly line: number | undefined;
}

/** What one module's listing produced. Never an exception. */
export interface MtpListing {
  readonly tests: readonly MtpTest[];
  readonly warnings: readonly string[];
}

/** A non-empty string at `key`, or `undefined`. */
function text(bag: Record<string, unknown>, key: string): string | undefined {
  const value = bag[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * True when `globalJson` opts the whole target into MTP.
 *
 * Parsed, never searched: `"Microsoft.Testing.Platform"` also appears in a
 * comment, in a package name and in an unrelated property, and a string search
 * would switch a VSTest solution onto a path that cannot run it.
 */
export function mtpRunnerSelected(globalJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(globalJson);
    if (!isRecord(parsed)) return false;
    const test: unknown = parsed.test;
    if (!isRecord(test)) return false;
    return (text(test, 'runner') ?? '').toLowerCase() === MTP_RUNNER;
  } catch {
    return false;
  }
}

/**
 * The nearest `global.json` at or above `startDir`, or `undefined`.
 *
 * The SDK resolves the runner the same way, so a solution in a sub-directory of
 * the repository that holds the opt-in must find it too.
 */
export function findGlobalJson(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, 'global.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** True when the `global.json` above `startDir` selects the MTP runner. */
export function usesMtpRunner(startDir: string): boolean {
  const file = findGlobalJson(startDir);
  if (file === undefined) return false;
  try {
    return mtpRunnerSelected(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The id of one listed test.
 *
 * The `type` block holds the namespace, the type and the method separately, and
 * it carries NO row data — so the rows of a data-driven test collapse onto the
 * one id they share, as [TEST-DISCOVERY-FQN] requires. The joined value is also
 * exactly the `className` + `.` + `name` pair the TRX report holds, which is
 * what lets [TEST-RUN-TRX] attribute an MTP outcome with no change.
 *
 * A module that sends no `type` block falls back to the display name. That is
 * weaker — MSTest would give a bare method name — but it is never worse than
 * dropping the test.
 */
function idOf(node: Record<string, unknown>, label: string): string {
  const type = node.type;
  if (!isRecord(type)) return label;
  const parts = [text(type, 'namespace'), text(type, 'typeName'), text(type, 'methodName')];
  const named = parts.filter((part): part is string => part !== undefined);
  return named.length === 0 ? label : named.join('.');
}

/** The 1-based start line of a node's `location`, when it has one. */
function lineOf(node: Record<string, unknown>): number | undefined {
  const location = node.location;
  if (!isRecord(location)) return undefined;
  const start: unknown = location.lineStart;
  return typeof start === 'number' && Number.isInteger(start) && start > 0 ? start : undefined;
}

/** The source file of a node's `location`, when it has one. */
function fileOf(node: Record<string, unknown>): string | undefined {
  const location = node.location;
  return isRecord(location) ? text(location, 'file') : undefined;
}

/** One `tests[]` entry, or `undefined` when it carries no usable uid. */
function toTest(entry: unknown): MtpTest | undefined {
  if (!isRecord(entry)) return undefined;
  const uid = text(entry, 'uid');
  if (uid === undefined) return undefined;
  const label = text(entry, 'displayName') ?? uid;
  return { id: idOf(entry, label), uid, label, file: fileOf(entry), line: lineOf(entry) };
}

/** The JSON document inside a module's stdout, or `undefined`. */
function documentIn(stdout: string): Record<string, unknown> | undefined {
  // The listing is preceded by a blank line, and on Windows by a byte-order
  // mark, so the scan starts at the first brace rather than at character zero.
  const start = stdout.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A warning when the module answered in a schema this reader does not know. */
function schemaWarning(document: Record<string, unknown>): string[] {
  const version: unknown = document.schemaVersion;
  if (version === KNOWN_SCHEMA_VERSION) return [];
  return [
    `Test listing reported schemaVersion ${String(version)}; ` +
      `this reader was written for ${String(KNOWN_SCHEMA_VERSION)}`,
  ];
}

/** Read one module's `--list-tests json` answer. Never throws. */
export function parseMtpTestList(stdout: string): MtpListing {
  const document = documentIn(stdout);
  if (document === undefined) {
    return { tests: [], warnings: ['Test listing was not a JSON document'] };
  }
  const entries: unknown = document.tests;
  if (!Array.isArray(entries)) {
    return { tests: [], warnings: ['Test listing carried no "tests" array'] };
  }
  const tests = entries
    .map((entry) => toTest(entry))
    .filter((test): test is MtpTest => test !== undefined);
  return { tests, warnings: schemaWarning(document) };
}

/** The ids one module reported, in listing order, without repeats. */
export function mtpIds(tests: readonly MtpTest[]): string[] {
  return [...new Set(tests.map((test) => test.id))];
}

/**
 * Every uid each id owns, in listing order.
 *
 * A data-driven test lists one node PER ROW, each with its own uid and all
 * sharing one id. Running that id must run every row, so the map holds a list.
 */
export function mtpUidsById(tests: readonly MtpTest[]): Map<string, string[]> {
  const uids = new Map<string, string[]>();
  for (const test of tests) {
    const existing = uids.get(test.id);
    if (existing === undefined) uids.set(test.id, [test.uid]);
    else existing.push(test.uid);
  }
  return uids;
}

/** The first source location reported for each id, when there is one. */
export function mtpLocationsById(
  tests: readonly MtpTest[],
): Map<string, { file: string; line: number | undefined }> {
  const locations = new Map<string, { file: string; line: number | undefined }>();
  for (const test of tests) {
    if (test.file === undefined || locations.has(test.id)) continue;
    locations.set(test.id, { file: test.file, line: test.line });
  }
  return locations;
}

/** The MTP exit code for a command line the module could not understand. */
export const MTP_INVALID_COMMAND_LINE = 5;

/** Prefix of the message a module prints when it rejects an option. */
const UNKNOWN_OPTION = "Unknown option '";

/**
 * The option a module rejected, or `undefined`.
 *
 * `--report-trx` and `--coverage` are EXTENSIONS, not part of MTP. A module
 * that does not register the extension exits with code 5 and prints this line.
 * Reporting it as itself is what tells the user to reference the package;
 * swallowing it would report every selected test as "No result reported".
 */
export function rejectedMtpOption(output: string): string | undefined {
  const start = output.indexOf(UNKNOWN_OPTION);
  if (start < 0) return undefined;
  const rest = output.slice(start + UNKNOWN_OPTION.length);
  const end = rest.indexOf("'");
  return end <= 0 ? undefined : rest.slice(0, end);
}
