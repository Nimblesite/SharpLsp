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

interface CoberturaLine {
  readonly '@_number': string;
  readonly '@_hits': string;
  readonly '@_branch'?: string;
}

interface CoberturaClass {
  readonly '@_filename': string;
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

/** Parse a cobertura XML report into VS Code FileCoverage entries. */
export function parseCoberturaXml(filePath: string): vscode.FileCoverage[] {
  const xml = fs.readFileSync(filePath, 'utf-8');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- fast-xml-parser returns untyped output; CoberturaReport mirrors the known schema
  const doc: CoberturaReport = coberturaParser.parse(xml);
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

/** Build a FileCoverage (and stash its per-line details) for one cobertura class. */
function fileCoverageForClass(cls: CoberturaClass): vscode.FileCoverage | undefined {
  const lines = cls.lines?.line;
  if (lines === undefined) return undefined;
  const lineList = Array.isArray(lines) ? lines : [lines];

  let covered = 0;
  const details: vscode.StatementCoverage[] = [];
  for (const line of lineList) {
    const lineNo = parseInt(line['@_number'], 10) - 1;
    const hits = parseInt(line['@_hits'], 10);
    if (hits > 0) covered++;
    details.push(new vscode.StatementCoverage(hits, new vscode.Position(lineNo, 0)));
  }

  const uri = vscode.Uri.file(cls['@_filename']);
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
