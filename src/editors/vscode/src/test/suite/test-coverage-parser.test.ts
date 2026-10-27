// The Cobertura reader at its boundary: a RELATIVE `<class filename>` must be
// resolved against `<sources><source>` before it becomes a FileCoverage URI.
//
// `coverlet.collector` — the VSTest path — writes the file name relative to a
// `<sources><source>` base ([TEST-COVERAGE]): the drive root when one file was
// measured (`/` + `tmp/…/Value.cs`, `C:\` + `Users\…\Value.cs`), and the common
// directory when several were. Read without its base, the Windows name carries
// no drive letter and resolves against whichever drive the extension host is
// on — not the drive the source lives on. This test writes a real source file
// and the report a collector would write for it, then asserts the parsed entry
// names that exact file, on every platform.
//
// Covers [TEST-COVERAGE].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCoberturaXml } from '../../test-coverage.js';
import { samePath } from '../../paths.js';
import { removeDirRecursive } from './test-helpers';

/** One class with one covered line, exactly as a collector writes it. */
function cobertura(source: string, filename: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="1" branch-rate="1" version="1.9" lines-covered="1" lines-valid="1">
  <sources><source>${source}</source></sources>
  <packages>
    <package name="Library" line-rate="1" branch-rate="1" complexity="1">
      <classes>
        <class name="GraphLib.Value" filename="${filename}" line-rate="1" branch-rate="1" complexity="1">
          <methods><method name="Current" signature="()" line-rate="1" branch-rate="1" complexity="1"><lines><line number="1" hits="1" branch="False" /></lines></method></methods>
          <lines><line number="1" hits="1" branch="False" /></lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;
}

suite('Cobertura reader — [TEST-COVERAGE]', () => {
  test('a relative <class filename> resolves against <sources> to the real source file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-cov-parser-'));
    try {
      const sourceDir = path.join(root, 'Library');
      fs.mkdirSync(sourceDir);
      const sourceFile = path.join(sourceDir, 'Value.cs');
      fs.writeFileSync(sourceFile, 'namespace GraphLib; public static class Value {}\n');
      // The base directory a collector writes as its source, and the name
      // relative to it (a collector writes the base with a trailing separator).
      const base = `${sourceDir}${path.sep}`;
      const report = path.join(root, 'coverage.cobertura.xml');
      fs.writeFileSync(report, cobertura(base, 'Value.cs'), 'utf8');

      const files = parseCoberturaXml(report);

      assert.equal(files.length, 1, 'the report yields one FileCoverage');
      assert.ok(
        samePath(files[0]?.uri.fsPath ?? '', sourceFile),
        `the FileCoverage must name the real source file, got '${files[0]?.uri.fsPath ?? ''}'`,
      );
      assert.equal(files[0]?.statementCoverage.covered, 1, 'the covered line is counted');
    } finally {
      void removeDirRecursive(root);
    }
  });
});
