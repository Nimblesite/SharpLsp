/**
 * Cobertura coverage report parsing for the Test Explorer's "Run with Coverage"
 * profile. Kept separate from test discovery/run so `testing.ts` stays focused
 * on the VS Code TestController wiring.
 *
 * Implements [TEST-COVERAGE].
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { info } from './log.js';
import { getErrorMessage } from './utils.js';

interface CoberturaLine {
  readonly '@_number': string;
  readonly '@_hits': string;
  readonly '@_branch'?: string;
}

interface CoberturaClass {
  /**
   * Optional because the PARSER decides, not the schema: a `<class>` element
   * written without the attribute — which a report truncated mid-write is full
   * of — yields `undefined`, and `Uri.file(undefined)` throws out of a step
   * whose whole contract is that it never fails a run.
   */
  readonly '@_filename'?: string;
  readonly lines?: { line?: CoberturaLine | CoberturaLine[] };
}

interface CoberturaPackage {
  readonly classes?: { class?: CoberturaClass | CoberturaClass[] };
}

interface CoberturaReport {
  readonly coverage?: {
    readonly packages?: { package?: CoberturaPackage | CoberturaPackage[] };
  };
}

const coberturaParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (tagName) => tagName === 'package' || tagName === 'class' || tagName === 'line',
});

/**
 * EVERY `coverage.cobertura.xml` one directory below `resultsDir`.
 *
 * The collector writes one report per test project, each into its own
 * run-id folder. Taking only the first — as this did — silently dropped every
 * other project's coverage from a solution-wide run, and which one "first" meant
 * depended on directory order.
 */
export function findCoberturaFiles(resultsDir: string): string[] {
  if (!fs.existsSync(resultsDir)) return [];
  const reports: string[] = [];
  for (const entry of fs.readdirSync(resultsDir)) {
    const candidate = path.join(resultsDir, entry, 'coverage.cobertura.xml');
    if (fs.existsSync(candidate)) reports.push(candidate);
  }
  return reports.sort();
}

/** The first `coverage.cobertura.xml` one directory below `resultsDir`. */
export function findCoberturaFile(resultsDir: string): string | undefined {
  return findCoberturaFiles(resultsDir)[0];
}

/**
 * Parse a cobertura XML report into VS Code FileCoverage entries.
 *
 * Attaching coverage is a REPORTING step: it runs after a `dotnet test` whose
 * tests have already passed or failed on their own terms, and it must never be
 * the thing that fails the run. A report the collector never wrote (the run was
 * cancelled before it got that far, or `coverlet.collector` is not referenced
 * at all) made `readFileSync` throw ENOENT straight out of the run handler,
 * which VS Code surfaces as "An error occurred attempting to run tests" over a
 * run that actually completed. No report is no coverage, reported as such.
 */
export function parseCoberturaXml(filePath: string): vscode.FileCoverage[] {
  const doc = readReport(filePath);
  if (doc === undefined) return [];
  const packages = doc.coverage?.packages?.package;
  if (packages === undefined) return [];

  const pkgList = Array.isArray(packages) ? packages : [packages];
  const result: vscode.FileCoverage[] = [];

  for (const pkg of pkgList) {
    const classes = pkg.classes?.class;
    if (classes === undefined) continue;
    const classList = Array.isArray(classes) ? classes : [classes];

    for (const cls of classList) {
      const fc = fileCoverageForClass(cls);
      if (fc !== undefined) result.push(fc);
    }
  }

  return result;
}

/**
 * Read and parse one report, or report why it could not be read.
 *
 * Both halves can fail on a report a cancelled run left half-written: the file
 * may not be there at all, and what IS there may be truncated mid-element.
 */
function readReport(filePath: string): CoberturaReport | undefined {
  try {
    const xml = fs.readFileSync(filePath, 'utf-8');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- fast-xml-parser returns untyped output; CoberturaReport mirrors the known schema
    return coberturaParser.parse(xml);
  } catch (error: unknown) {
    info(`No usable coverage report at ${filePath}: ${getErrorMessage(error)}`);
    return undefined;
  }
}

/** Build a FileCoverage (and stash its per-line details) for one cobertura class. */
function fileCoverageForClass(cls: CoberturaClass): vscode.FileCoverage | undefined {
  const filename = cls['@_filename'];
  if (filename === undefined || filename === '') return undefined;
  // A class with an EMPTY `<lines>` element is still a file the run loaded —
  // an interface, a record with only generated members, a file whose every
  // statement the compiler elided. Dropping it made the gutter say nothing
  // about a file the coverage run had demonstrably seen, which reads as "not
  // instrumented" rather than "nothing here to cover".
  const lines = cls.lines?.line;
  const lineList = lines === undefined ? [] : Array.isArray(lines) ? lines : [lines];

  let covered = 0;
  const details: vscode.StatementCoverage[] = [];
  for (const line of lineList) {
    const lineNo = parseInt(line['@_number'], 10) - 1;
    const hits = parseInt(line['@_hits'], 10);
    if (hits > 0) covered++;
    details.push(new vscode.StatementCoverage(hits, new vscode.Position(lineNo, 0)));
  }

  const uri = vscode.Uri.file(filename);
  const fc = new vscode.FileCoverage(uri, new vscode.TestCoverageCount(covered, lineList.length));
  coverageDetails.set(uri.toString(), details);
  return fc;
}

/** Coverage details keyed by file URI string, for loadDetailedCoverage. */
const coverageDetails = new Map<string, vscode.StatementCoverage[]>();

/** Per-file statement coverage detail for VS Code's loadDetailedCoverage callback. */
export function loadDetailedCoverage(
  fileCoverage: vscode.FileCoverage,
): vscode.FileCoverageDetail[] {
  return coverageDetails.get(fileCoverage.uri.toString()) ?? [];
}

/**
 * Every report merged: ONE {@link vscode.FileCoverage} per source file, whose
 * detail is the UNION of every report that measured it.
 *
 * [TEST-COVERAGE] warns that "taking only the first drops every other project's
 * coverage". Attaching each report's entry separately loses it just as surely
 * at the other end: two test projects covering one library produce two entries
 * for the SAME file, and the detail behind them is stashed by file URI, so the
 * last report parsed overwrites the first. VS Code then resolves that one
 * report's lines for both entries, and a function the other project executed is
 * painted as dead code — a wrong red gutter on a line that just ran.
 *
 * Hits are taken per line as the MAXIMUM across reports, because a line one
 * project never executed is not evidence that another did not.
 */
export function mergeCoberturaReports(reports: readonly string[]): vscode.FileCoverage[] {
  const hitsByFile = new Map<string, Map<number, number>>();
  for (const report of reports) {
    for (const file of parseCoberturaXml(report)) {
      const key = file.uri.toString();
      const lines = hitsByFile.get(key) ?? new Map<number, number>();
      for (const detail of coverageDetails.get(key) ?? []) {
        const at = detail.location;
        const line = at instanceof vscode.Range ? at.start.line : at.line;
        lines.set(line, Math.max(lines.get(line) ?? 0, Number(detail.executed)));
      }
      hitsByFile.set(key, lines);
    }
  }
  return [...hitsByFile].map(([uri, lines]) => mergedFileCoverage(vscode.Uri.parse(uri), lines));
}

/** Rebuild one file's coverage from the union of its per-line hit counts. */
function mergedFileCoverage(
  uri: vscode.Uri,
  lines: ReadonlyMap<number, number>,
): vscode.FileCoverage {
  const details = [...lines]
    .sort(([a], [b]) => a - b)
    .map(([line, hits]) => new vscode.StatementCoverage(hits, new vscode.Position(line, 0)));
  const covered = details.filter((detail) => Number(detail.executed) > 0).length;
  coverageDetails.set(uri.toString(), details);
  return new vscode.FileCoverage(uri, new vscode.TestCoverageCount(covered, details.length));
}
