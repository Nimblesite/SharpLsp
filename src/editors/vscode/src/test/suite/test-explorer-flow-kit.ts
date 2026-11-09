// Run-flow bundles shared by the Test Explorer run-profile suites.
//
// A coverage run leaves a DIRECTORY behind, and the claim "[TEST-COVERAGE] makes
// about it — freshly emptied, one report per test project, every report parsed —
// is a claim about what is on disk before and after a gesture. These helpers
// take that whole snapshot, compare a later directory against it, and carry the
// per-function "never executed" loops, so a suite asserts the full contract by
// calling one function ([TEST-COVERAGE], [TEST-FILTER-ESCAPE]).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { findCoberturaFiles } from '../../test-coverage.js';
import type { SharpLspTestController } from '../../testing.js';
import { assertOneProfile, profileOfKind } from './test-explorer-kit';
import { runIds } from './test-explorer-outcome-assertions';

/** The file name the coverage collector always writes. */
export const REPORT_NAME = 'coverage.cobertura.xml';

/** What a coverage results directory holds: its entries, reports and report mtimes. */
export interface CoverageSnapshot {
  /** Every entry beside the solution, sorted. */
  readonly entries: string[];
  /** Every readable Cobertura report, in the reader's own order. */
  readonly reports: string[];
  /** Each report's modification time, so a rewrite is visible. */
  readonly stamps: number[];
}

/** Read the coverage results directory: sorted entries, reports, and their mtimes. */
export function snapshotCoverageDir(dir: string): CoverageSnapshot {
  const reports = findCoberturaFiles(dir);
  return {
    entries: fs.readdirSync(dir).sort(),
    reports,
    stamps: reports.map((report) => fs.statSync(report).mtimeMs),
  };
}

/** Run with Coverage over `ids`, then snapshot the directory it left behind. */
export async function coverAndSnapshot(
  api: SharpLspExtensionApi,
  dir: string,
  ids: readonly string[],
  projects: number,
  why: string,
): Promise<CoverageSnapshot> {
  await runIds(api, vscode.TestRunProfileKind.Coverage, ids);
  const snapshot = snapshotCoverageDir(dir);
  assert.strictEqual(snapshot.reports.length, projects, why);
  return snapshot;
}

/** The directory still holds exactly what `snapshot` recorded, each claim under its own text. */
export function assertCoverageDirUntouched(
  dir: string,
  snapshot: CoverageSnapshot,
  why: { readonly entries: string; readonly reports: string; readonly stamps: string },
): void {
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), snapshot.entries, why.entries);
  assert.deepStrictEqual(findCoberturaFiles(dir), snapshot.reports, why.reports);
  assert.deepStrictEqual(
    findCoberturaFiles(dir).map((report) => fs.statSync(report).mtimeMs),
    snapshot.stamps,
    why.stamps,
  );
}

/** Nothing readable sits under the results directory: no report was attached. */
export function assertNoCoverageReports(dir: string, why: string): void {
  assert.deepStrictEqual(findCoberturaFiles(dir), [], why);
}

/** None of `never` is reported as executed in `lines`, each refusal under its own text. */ export function assertNeverCovered(
  lines: Iterable<number>,
  never: readonly string[],
  lineOf: (name: string) => number,
  why: (name: string) => string,
): void {
  const covered = new Set(lines);
  for (const name of never) {
    assert.ok(!covered.has(lineOf(name)), why(name));
  }
}

/** The collector's report: its own name, one directory down, and real Cobertura XML. */
export function assertCoberturaReport(
  report: string,
  dir: string,
  why: { readonly depth: string; readonly xml: string; readonly absolute?: string },
): void {
  assert.strictEqual(path.basename(report), REPORT_NAME, "the collector's own file name");
  assert.strictEqual(path.dirname(path.dirname(report)), dir, why.depth);
  if (why.absolute !== undefined) assert.ok(path.isAbsolute(report), why.absolute);
  assert.ok(fs.readFileSync(report, 'utf8').includes('<coverage'), why.xml);
}

/** `lines` reports the declaration of `name` exactly as `covered` claims, under `why`. */
export function assertFunctionCoverage(
  lines: Iterable<number>,
  name: string,
  covered: boolean,
  lineOf: (name: string) => number,
  why: string,
): void {
  assert.strictEqual(new Set(lines).has(lineOf(name)), covered, why);
}

/** The controller registers a profile of `kind` whose own kind is `kind`. */
export function assertProfileOfKind(
  controller: SharpLspTestController,
  kind: vscode.TestRunProfileKind,
  why: string,
): void {
  assert.strictEqual(profileOfKind(controller, kind).kind, kind, why);
}

/** Neither line set is a subset of the other: each carries a line its sibling lacks. */
export function assertNeitherSubset(
  first: readonly number[],
  second: readonly number[],
  why: { readonly first: string; readonly second: string },
): void {
  assert.ok(
    first.some((line) => !second.includes(line)),
    `${why.first}: ${first.join(',')} vs ${second.join(',')}`,
  );
  assert.ok(
    second.some((line) => !first.includes(line)),
    `${why.second}: ${second.join(',')} vs ${first.join(',')}`,
  );
}

/** Exactly ONE profile of `kind`, and it is never the Coverage profile relabelled. */
export function assertDistinctProfile(
  controller: SharpLspTestController,
  kind: vscode.TestRunProfileKind,
  why: { readonly single: string; readonly distinct: string },
): void {
  assertOneProfile(controller, kind, why.single);
  assert.notStrictEqual(
    profileOfKind(controller, kind),
    profileOfKind(controller, vscode.TestRunProfileKind.Coverage),
    why.distinct,
  );
}

/** Exactly ONE profile of `kind`, with a profile of `beside` still registered next to it. */
export function assertProfilePair(
  controller: SharpLspTestController,
  kind: vscode.TestRunProfileKind,
  beside: vscode.TestRunProfileKind,
  why: { readonly single: string; readonly beside: string },
): void {
  assertOneProfile(controller, kind, why.single);
  assert.ok(
    controller.profiles.some((profile) => profile.kind === beside),
    why.beside,
  );
}
