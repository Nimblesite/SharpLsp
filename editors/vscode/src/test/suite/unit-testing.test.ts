// Pure-logic unit tests for the Testing module helpers.
// These pin the EXACT behavior of the test-discovery predicates, the
// `dotnet test --filter` argument builder, the cobertura XML parser, and the
// cobertura file finder. No LSP host, no command execution — pure functions
// (plus tmp-dir disk fixtures for the disk-reading helpers).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  isTestName,
  isExpectoTest,
  isFsCheckTest,
  buildFilterArgs,
  parseCoberturaXml,
  findCoberturaFile,
} from '../../testing.js';

/** Build a minimal fake TestItem carrying just the `id` field the helpers read. */
function fakeTestItem(id: string): vscode.TestItem {
  return { id } as unknown as vscode.TestItem;
}

suite('Testing Module — isTestName()', () => {
  test('fully qualified name with namespace dots is a test name', () => {
    assert.strictEqual(isTestName('MyApp.Tests.CalculatorTests.Adds'), true);
    assert.strictEqual(isTestName('A.B'), true);
    assert.strictEqual(isTestName('Ns.Class.Method'), true);
  });

  test('underscores and digits are word chars and allowed', () => {
    assert.strictEqual(isTestName('My_App.Test_1.Method_2'), true);
    assert.strictEqual(isTestName('a1.b2'), true);
    assert.strictEqual(isTestName('_._'), true);
  });

  test('a bare identifier with no dot is NOT a test name', () => {
    assert.strictEqual(isTestName('JustAName'), false);
    assert.strictEqual(isTestName('foo'), false);
    assert.strictEqual(isTestName('Method'), false);
  });

  test('empty and whitespace strings are NOT test names', () => {
    assert.strictEqual(isTestName(''), false);
    assert.strictEqual(isTestName('   '), false);
    assert.strictEqual(isTestName('\t'), false);
    assert.strictEqual(isTestName('\n'), false);
  });

  test('a line containing a space is NOT a test name', () => {
    assert.strictEqual(isTestName('My App.Test'), false);
    assert.strictEqual(isTestName('A.B C'), false);
    assert.strictEqual(isTestName(' A.B'), false);
    assert.strictEqual(isTestName('A.B '), false);
  });

  test('header line "The following Tests are available:" is NOT a test name', () => {
    assert.strictEqual(isTestName('The following Tests are available:'), false);
  });

  test('names with parentheses (parameterized) are NOT test names — paren is not a word char', () => {
    assert.strictEqual(isTestName('Ns.Class.Method(x: 1)'), false);
    assert.strictEqual(isTestName('A.B()'), false);
  });

  test('names with hyphens or special regex chars are NOT test names', () => {
    assert.strictEqual(isTestName('A.B-C'), false);
    assert.strictEqual(isTestName('A.B+C'), false);
    assert.strictEqual(isTestName('A.B*C'), false);
    assert.strictEqual(isTestName('A.B|C'), false);
    assert.strictEqual(isTestName('A.B$'), false);
    assert.strictEqual(isTestName('A/B.c'), false);
  });

  test('a string of only dots passes (word chars not required, dot present)', () => {
    assert.strictEqual(isTestName('.'), true);
    assert.strictEqual(isTestName('..'), true);
  });

  test('generic test name with angle brackets is NOT a test name', () => {
    assert.strictEqual(isTestName('Ns.Class.Method<T>'), false);
  });

  test('unicode letters outside ASCII word class are NOT test names', () => {
    // \w in JS (non-unicode flag) is [A-Za-z0-9_] only.
    assert.strictEqual(isTestName('Café.Test'), false);
    assert.strictEqual(isTestName('Тест.Метод'), false);
    assert.strictEqual(isTestName('测试.方法'), false);
  });
});

suite('Testing Module — isExpectoTest()', () => {
  test('names containing "Expecto" match', () => {
    assert.strictEqual(isExpectoTest('Expecto'), true);
    assert.strictEqual(isExpectoTest('MyLib.Tests.Expecto.Foo'), true);
    assert.strictEqual(isExpectoTest('prefixExpectosuffix'), true);
  });

  test('names containing "testCase" match', () => {
    assert.strictEqual(isExpectoTest('testCase'), true);
    assert.strictEqual(isExpectoTest('Suite.testCaseFoo'), true);
  });

  test('names containing "testList" match', () => {
    assert.strictEqual(isExpectoTest('testList'), true);
    assert.strictEqual(isExpectoTest('My.testList.Group'), true);
  });

  test('matching is case-sensitive — lowercased variants do NOT match', () => {
    assert.strictEqual(isExpectoTest('expecto'), false);
    assert.strictEqual(isExpectoTest('testcase'), false);
    assert.strictEqual(isExpectoTest('TestCase'), false);
    assert.strictEqual(isExpectoTest('testlist'), false);
    assert.strictEqual(isExpectoTest('TestList'), false);
  });

  test('non-Expecto names do NOT match', () => {
    assert.strictEqual(isExpectoTest(''), false);
    assert.strictEqual(isExpectoTest('MyApp.Tests.Calculator.Adds'), false);
    assert.strictEqual(isExpectoTest('xUnit.Theory'), false);
  });

  test('a name matching multiple substrings still matches once', () => {
    assert.strictEqual(isExpectoTest('Expecto.testList.testCase'), true);
  });
});

suite('Testing Module — isFsCheckTest()', () => {
  test('names containing "FsCheck" match', () => {
    assert.strictEqual(isFsCheckTest('FsCheck'), true);
    assert.strictEqual(isFsCheckTest('MyLib.FsCheck.Props'), true);
    assert.strictEqual(isFsCheckTest('preFsCheckpost'), true);
  });

  test('names containing "Property" match', () => {
    assert.strictEqual(isFsCheckTest('Property'), true);
    assert.strictEqual(isFsCheckTest('My.PropertyBased.Test'), true);
  });

  test('matching is case-sensitive — lowercased variants do NOT match', () => {
    assert.strictEqual(isFsCheckTest('fscheck'), false);
    assert.strictEqual(isFsCheckTest('fsCheck'), false);
    assert.strictEqual(isFsCheckTest('property'), false);
    assert.strictEqual(isFsCheckTest('PROPERTY'), false);
  });

  test('non-FsCheck names do NOT match', () => {
    assert.strictEqual(isFsCheckTest(''), false);
    assert.strictEqual(isFsCheckTest('MyApp.Tests.Calculator.Adds'), false);
    assert.strictEqual(isFsCheckTest('NUnit.TestFixture'), false);
  });

  test('Expecto and FsCheck predicates are independent', () => {
    assert.strictEqual(isExpectoTest('FsCheck'), false);
    assert.strictEqual(isFsCheckTest('Expecto'), false);
    assert.strictEqual(isFsCheckTest('testCase'), false);
    assert.strictEqual(isExpectoTest('Property'), false);
  });
});

suite('Testing Module — buildFilterArgs()', () => {
  test('empty test list returns an empty args array', () => {
    const args = buildFilterArgs([]);
    assert.deepStrictEqual(args, []);
    assert.strictEqual(args.length, 0);
  });

  test('single test produces --filter and one FullyQualifiedName clause', () => {
    const args = buildFilterArgs([fakeTestItem('Ns.Class.Method')]);
    assert.deepStrictEqual(args, ['--filter', 'FullyQualifiedName=Ns.Class.Method']);
    assert.strictEqual(args.length, 2);
    assert.strictEqual(args[0], '--filter');
    assert.strictEqual(args[1], 'FullyQualifiedName=Ns.Class.Method');
  });

  test('multiple tests are OR-joined with a pipe inside a single clause string', () => {
    const args = buildFilterArgs([
      fakeTestItem('Ns.A.One'),
      fakeTestItem('Ns.B.Two'),
      fakeTestItem('Ns.C.Three'),
    ]);
    assert.strictEqual(args.length, 2);
    assert.strictEqual(args[0], '--filter');
    assert.strictEqual(
      args[1],
      'FullyQualifiedName=Ns.A.One|FullyQualifiedName=Ns.B.Two|FullyQualifiedName=Ns.C.Three',
    );
  });

  test('the joined filter contains exactly one pipe per extra test', () => {
    const args = buildFilterArgs([
      fakeTestItem('A.One'),
      fakeTestItem('A.Two'),
      fakeTestItem('A.Three'),
      fakeTestItem('A.Four'),
    ]);
    const clause = args[1] ?? '';
    const pipeCount = clause.split('|').length - 1;
    assert.strictEqual(pipeCount, 3);
    assert.strictEqual(clause.split('|').length, 4);
  });

  test('only the id field is read (label and other fields are ignored)', () => {
    const item = {
      id: 'Real.Id.Used',
      label: 'IgnoredLabel',
      description: 'ignored',
    } as unknown as vscode.TestItem;
    const args = buildFilterArgs([item]);
    assert.strictEqual(args[1], 'FullyQualifiedName=Real.Id.Used');
    assert.ok(!(args[1] ?? '').includes('IgnoredLabel'));
  });

  test('test ids are used verbatim — special characters are not escaped', () => {
    const args = buildFilterArgs([fakeTestItem('Ns.Class.Method(x: "a|b")')]);
    assert.strictEqual(args[1], 'FullyQualifiedName=Ns.Class.Method(x: "a|b")');
  });

  test('an empty id still produces a clause with an empty value', () => {
    const args = buildFilterArgs([fakeTestItem('')]);
    assert.deepStrictEqual(args, ['--filter', 'FullyQualifiedName=']);
  });

  test('order of tests is preserved in the joined output', () => {
    const args = buildFilterArgs([fakeTestItem('Z.last'), fakeTestItem('A.first')]);
    assert.strictEqual(args[1], 'FullyQualifiedName=Z.last|FullyQualifiedName=A.first');
  });
});

// ── Cobertura XML parsing (disk fixtures) ─────────────────────────

const COBERTURA_SINGLE_FILE = `<?xml version="1.0"?>
<coverage>
  <packages>
    <package>
      <classes>
        <class filename="/src/Foo.cs">
          <lines>
            <line number="1" hits="5"/>
            <line number="2" hits="0"/>
            <line number="10" hits="3"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

const COBERTURA_MULTI_FILE = `<?xml version="1.0"?>
<coverage>
  <packages>
    <package>
      <classes>
        <class filename="/src/Alpha.cs">
          <lines>
            <line number="1" hits="1"/>
            <line number="2" hits="1"/>
          </lines>
        </class>
        <class filename="/src/Beta.cs">
          <lines>
            <line number="1" hits="0"/>
          </lines>
        </class>
      </classes>
    </package>
    <package>
      <classes>
        <class filename="/src/Gamma.cs">
          <lines>
            <line number="3" hits="0"/>
            <line number="4" hits="0"/>
            <line number="5" hits="0"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

const COBERTURA_NO_PACKAGES = `<?xml version="1.0"?><coverage><packages></packages></coverage>`;
const COBERTURA_BARE_COVERAGE = `<?xml version="1.0"?><coverage></coverage>`;

suite('Testing Module — parseCoberturaXml()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-cobertura-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeXml(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  test('single class produces one FileCoverage with correct covered/total counts', () => {
    const result = parseCoberturaXml(writeXml('single.xml', COBERTURA_SINGLE_FILE));
    assert.strictEqual(result.length, 1);
    const fc = result[0];
    assert.ok(fc !== undefined);
    // 3 total lines, 2 with hits > 0 (5 and 3), 1 with 0 hits.
    assert.strictEqual(fc.statementCoverage.total, 3);
    assert.strictEqual(fc.statementCoverage.covered, 2);
  });

  test('FileCoverage uri matches the cobertura class filename', () => {
    const result = parseCoberturaXml(writeXml('single.xml', COBERTURA_SINGLE_FILE));
    const fc = result[0];
    assert.ok(fc !== undefined);
    assert.strictEqual(fc.uri.scheme, 'file');
    assert.strictEqual(fc.uri.fsPath, path.normalize('/src/Foo.cs'));
    assert.strictEqual(fc.uri.toString(), vscode.Uri.file('/src/Foo.cs').toString());
  });

  test('multiple packages and classes each yield a FileCoverage in order', () => {
    const result = parseCoberturaXml(writeXml('multi.xml', COBERTURA_MULTI_FILE));
    assert.strictEqual(result.length, 3);

    const alpha = result[0];
    const beta = result[1];
    const gamma = result[2];
    assert.ok(alpha !== undefined && beta !== undefined && gamma !== undefined);

    assert.strictEqual(alpha.uri.fsPath, path.normalize('/src/Alpha.cs'));
    assert.strictEqual(alpha.statementCoverage.total, 2);
    assert.strictEqual(alpha.statementCoverage.covered, 2);

    assert.strictEqual(beta.uri.fsPath, path.normalize('/src/Beta.cs'));
    assert.strictEqual(beta.statementCoverage.total, 1);
    assert.strictEqual(beta.statementCoverage.covered, 0);

    assert.strictEqual(gamma.uri.fsPath, path.normalize('/src/Gamma.cs'));
    assert.strictEqual(gamma.statementCoverage.total, 3);
    assert.strictEqual(gamma.statementCoverage.covered, 0);
  });

  test('a fully-covered file reports covered === total', () => {
    const result = parseCoberturaXml(writeXml('multi.xml', COBERTURA_MULTI_FILE));
    const alpha = result.find((fc) => fc.uri.fsPath === path.normalize('/src/Alpha.cs'));
    assert.ok(alpha !== undefined);
    assert.strictEqual(alpha.statementCoverage.covered, alpha.statementCoverage.total);
  });

  test('a fully-uncovered file reports covered === 0 with total > 0', () => {
    const result = parseCoberturaXml(writeXml('multi.xml', COBERTURA_MULTI_FILE));
    const gamma = result.find((fc) => fc.uri.fsPath === path.normalize('/src/Gamma.cs'));
    assert.ok(gamma !== undefined);
    assert.strictEqual(gamma.statementCoverage.covered, 0);
    assert.ok(gamma.statementCoverage.total > 0);
  });

  test('a single line (not an array) is still parsed into one statement', () => {
    const xml = `<?xml version="1.0"?>
<coverage><packages><package><classes>
<class filename="/src/Solo.cs"><lines><line number="7" hits="0"/></lines></class>
</classes></package></packages></coverage>`;
    const result = parseCoberturaXml(writeXml('solo.xml', xml));
    assert.strictEqual(result.length, 1);
    const fc = result[0];
    assert.ok(fc !== undefined);
    assert.strictEqual(fc.statementCoverage.total, 1);
    assert.strictEqual(fc.statementCoverage.covered, 0);
  });

  test('a class with no <lines> is skipped (produces no FileCoverage)', () => {
    const xml = `<?xml version="1.0"?>
<coverage><packages><package><classes>
<class filename="/src/Empty.cs"></class>
<class filename="/src/Has.cs"><lines><line number="1" hits="2"/></lines></class>
</classes></package></packages></coverage>`;
    const result = parseCoberturaXml(writeXml('skip.xml', xml));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.uri.fsPath, path.normalize('/src/Has.cs'));
  });

  test('a package with no classes is skipped', () => {
    const xml = `<?xml version="1.0"?>
<coverage><packages>
<package></package>
<package><classes><class filename="/src/Only.cs"><lines><line number="1" hits="1"/></lines></class></classes></package>
</packages></coverage>`;
    const result = parseCoberturaXml(writeXml('emptypkg.xml', xml));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.uri.fsPath, path.normalize('/src/Only.cs'));
  });

  test('report with empty <packages> returns an empty array', () => {
    const result = parseCoberturaXml(writeXml('nopkg.xml', COBERTURA_NO_PACKAGES));
    assert.deepStrictEqual(result, []);
    assert.strictEqual(result.length, 0);
  });

  test('bare <coverage/> with no packages element returns an empty array', () => {
    const result = parseCoberturaXml(writeXml('bare.xml', COBERTURA_BARE_COVERAGE));
    assert.deepStrictEqual(result, []);
  });

  test('an empty file returns an empty array (parses to {})', () => {
    const result = parseCoberturaXml(writeXml('empty.xml', ''));
    assert.deepStrictEqual(result, []);
  });

  test('a whitespace-only file returns an empty array', () => {
    const result = parseCoberturaXml(writeXml('ws.xml', '   \n\t  '));
    assert.deepStrictEqual(result, []);
  });

  test('hits are summed correctly with mixed zero and non-zero counts', () => {
    const xml = `<?xml version="1.0"?>
<coverage><packages><package><classes>
<class filename="/src/Mixed.cs"><lines>
<line number="1" hits="100"/>
<line number="2" hits="0"/>
<line number="3" hits="1"/>
<line number="4" hits="0"/>
<line number="5" hits="0"/>
</lines></class>
</classes></package></packages></coverage>`;
    const result = parseCoberturaXml(writeXml('mixed.xml', xml));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.statementCoverage.total, 5);
    assert.strictEqual(result[0]?.statementCoverage.covered, 2);
  });

  test('reading a non-existent file throws (not defensively swallowed)', () => {
    const missing = path.join(tmpDir, 'does-not-exist.xml');
    assert.throws(() => parseCoberturaXml(missing));
  });

  test('a malformed (non-XML) file throws from the parser', () => {
    const filePath = writeXml('bad.xml', 'this is not xml at all <<<');
    assert.throws(() => parseCoberturaXml(filePath));
  });
});

// ── Cobertura file discovery (disk fixtures) ──────────────────────

suite('Testing Module — findCoberturaFile()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-find-cobertura-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns undefined when the results directory does not exist', () => {
    const missing = path.join(tmpDir, 'no-such-dir');
    assert.strictEqual(findCoberturaFile(missing), undefined);
  });

  test('returns undefined when the results directory is empty', () => {
    assert.strictEqual(findCoberturaFile(tmpDir), undefined);
  });

  test('finds coverage.cobertura.xml one level below the results dir', () => {
    const guidDir = path.join(tmpDir, 'a1b2c3d4-guid');
    fs.mkdirSync(guidDir);
    const expected = path.join(guidDir, 'coverage.cobertura.xml');
    fs.writeFileSync(expected, COBERTURA_BARE_COVERAGE, 'utf-8');

    const found = findCoberturaFile(tmpDir);
    assert.strictEqual(found, expected);
  });

  test('returns undefined when the coverage file is directly in the results dir (not nested)', () => {
    // The finder only looks ONE level down, inside subdirectories.
    fs.writeFileSync(path.join(tmpDir, 'coverage.cobertura.xml'), COBERTURA_BARE_COVERAGE, 'utf-8');
    assert.strictEqual(findCoberturaFile(tmpDir), undefined);
  });

  test('returns undefined when a subdir exists but lacks the coverage file', () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'other.xml'), 'x', 'utf-8');
    assert.strictEqual(findCoberturaFile(tmpDir), undefined);
  });

  test('returns the first matching subdir when multiple subdirs contain coverage files', () => {
    const entries = ['aaa', 'bbb'];
    for (const e of entries) {
      const sub = path.join(tmpDir, e);
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, 'coverage.cobertura.xml'), COBERTURA_BARE_COVERAGE, 'utf-8');
    }
    const found = findCoberturaFile(tmpDir);
    assert.ok(found !== undefined);
    // readdirSync returns sorted entries on the platforms used in CI; the
    // result must be one of the real candidates and must end with the file name.
    assert.ok(found.endsWith(path.join('coverage.cobertura.xml')));
    assert.ok(entries.some((e) => found.includes(path.join(e, 'coverage.cobertura.xml'))));
    assert.ok(fs.existsSync(found));
  });

  test('the path it finds is consumable by parseCoberturaXml end-to-end', () => {
    const guidDir = path.join(tmpDir, 'run-1');
    fs.mkdirSync(guidDir);
    fs.writeFileSync(
      path.join(guidDir, 'coverage.cobertura.xml'),
      COBERTURA_SINGLE_FILE,
      'utf-8',
    );
    const found = findCoberturaFile(tmpDir);
    assert.ok(found !== undefined);
    const coverages = parseCoberturaXml(found);
    assert.strictEqual(coverages.length, 1);
    assert.strictEqual(coverages[0]?.statementCoverage.total, 3);
    assert.strictEqual(coverages[0]?.statementCoverage.covered, 2);
  });
});
