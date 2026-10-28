// The sources of the logging fixtures ([TEST-RUN-OUTPUT]), from ONE model of
// each test rendered into C# or F#. Every call a channel makes is spelled the
// same in both languages, so the two projects of a framework differ only in
// the syntax around those calls.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mtpProjectXml, projectXml, writeProject } from './dotnet-project-kit';
import {
  FAILS,
  NOTHING,
  ROWS,
  markerOf,
  primaryOf,
  rowPrefixOf,
  testNameOf,
  type OutputFixture,
} from './test-output-fixtures';

/** One test: its name, attributes, and the calls its body makes. */
interface TestMethod {
  readonly name: string;
  readonly attributes: readonly string[];
  /** A theory takes the row number; its body receives the language's spelling of it as text. */
  readonly row: boolean;
  readonly body: (rowText: string) => readonly string[];
}

const TEST_ATTRIBUTE = { xunit: 'Fact', nunit: 'Test', mstest: 'TestMethod' } as const;

/** One passing test per channel, then the failing, the silent and the theory test. */
function testsOf(fixture: OutputFixture): TestMethod[] {
  const attribute = TEST_ATTRIBUTE[fixture.framework];
  const write = (key: string): string =>
    `${primaryOf(fixture).receiver}("${markerOf(fixture, key)}")`;
  const plain = (key: string, body: readonly string[]): TestMethod => ({
    name: testNameOf(fixture, key),
    attributes: [attribute],
    row: false,
    body: () => body,
  });
  return [
    ...fixture.channels.map((each) =>
      plain(each.key, [`${each.receiver}("${markerOf(fixture, each.key)}")`]),
    ),
    plain(FAILS, [write(FAILS), 'Assert.Fail("deliberate failure")']),
    plain(NOTHING, []),
    ...(fixture.framework === 'xunit' ? [rowsTest(fixture)] : []),
  ];
}

/** The xUnit theory whose two rows each write one line. */
function rowsTest(fixture: OutputFixture): TestMethod {
  return {
    name: testNameOf(fixture, ROWS),
    attributes: ['Theory', 'InlineData(1)', 'InlineData(2)'],
    row: true,
    body: (rowText) => [`${primaryOf(fixture).receiver}("${rowPrefixOf(fixture)}" + ${rowText})`],
  };
}

/** Namespaces every source opens: the logging types, then the framework's. */
function namespacesOf(fixture: OutputFixture): string[] {
  const own = {
    xunit: fixture.runner === 'mtp' ? ['Xunit'] : ['Xunit', 'Xunit.Abstractions'],
    nunit: ['NUnit.Framework'],
    mstest: [
      'Microsoft.VisualStudio.TestTools.UnitTesting',
      'Microsoft.VisualStudio.TestTools.UnitTesting.Logging',
    ],
  }[fixture.framework];
  return ['System', 'System.Diagnostics', ...own];
}

/** xunit.v3 captures Console, Debug and Trace only when the assembly opts in. */
function assemblyAttributesOf(fixture: OutputFixture): string[] {
  return fixture.framework === 'xunit' && fixture.runner === 'mtp'
    ? ['CaptureConsole', 'CaptureTrace']
    : [];
}

/** One C# test method. */
function csharpTest(test: TestMethod): string[] {
  const parameter = test.row ? 'int row' : '';
  const body = test.body('row').map((call) => `${call}; `);
  return [
    `        [${test.attributes.join(', ')}]`,
    `        public void ${test.name}(${parameter}) { ${body.join('')}}`,
  ];
}

/** The C# source: the xUnit helper through the primary constructor, MSTest's context by property. */
function csharpSource(fixture: OutputFixture): string {
  const xunit = fixture.framework === 'xunit';
  return [
    ...namespacesOf(fixture).map((name) => `using ${name};`),
    ...assemblyAttributesOf(fixture).map((name) => `[assembly: ${name}]`),
    '',
    `namespace ${fixture.projectName}`,
    '{',
    ...(fixture.framework === 'mstest' ? ['    [TestClass]'] : []),
    `    public class OutputTests${xunit ? '(ITestOutputHelper output)' : ''}`,
    '    {',
    ...(fixture.framework === 'mstest'
      ? ['        public TestContext TestContext { get; set; }']
      : []),
    ...testsOf(fixture).flatMap(csharpTest),
    '    }',
    '}',
    '',
  ].join('\n');
}

/** One F# member: a backtick name when it carries spaces. */
function fsharpTest(test: TestMethod): string[] {
  const name = test.name.includes(' ') ? `\`\`${test.name}\`\`` : test.name;
  const body = test.body('string row');
  return [
    `    [<${test.attributes.join('; ')}>]`,
    `    member this.${name} (${test.row ? 'row: int' : ''}) =`,
    ...(body.length === 0 ? ['()'] : body).map((call) => `        ${call}`),
    '',
  ];
}

/** The F# source: one class in a namespace, so the ids match the C# shape. */
function fsharpSource(fixture: OutputFixture): string {
  const attributes = assemblyAttributesOf(fixture);
  const xunit = fixture.framework === 'xunit';
  return [
    `namespace ${fixture.projectName}`,
    '',
    ...namespacesOf(fixture).map((name) => `open ${name}`),
    '',
    ...attributes.map((name) => `[<assembly: ${name}>]`),
    ...(attributes.length > 0 ? ['do ()', ''] : []),
    ...(fixture.framework === 'mstest' ? ['[<TestClass>]'] : []),
    `type OutputTests(${xunit ? 'output: ITestOutputHelper' : ''}) =`,
    ...(fixture.framework === 'mstest'
      ? ['    member val TestContext = Unchecked.defaultof<TestContext> with get, set', '']
      : []),
    ...testsOf(fixture).flatMap(fsharpTest),
  ].join('\n');
}

/** xUnit diagnostic messages reach the console only once `testconfig.json` opts in. */
function writeDiagnosticsOptIn(dir: string): void {
  const config = { xUnit: { diagnosticMessages: true } };
  fs.writeFileSync(path.join(dir, 'testconfig.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** Write one fixture project under `root` and return its directory. */
export function writeOutputProject(root: string, fixture: OutputFixture): string {
  const fsharp = fixture.language === 'fsharp';
  const sourceFileName = `OutputTests.${fsharp ? 'fs' : 'cs'}`;
  const compile = fsharp ? [sourceFileName] : [];
  const xml =
    fixture.runner === 'mtp'
      ? mtpProjectXml(fixture.packages, ...compile)
      : projectXml(fixture.packages, ...compile);
  const source = fsharp ? fsharpSource(fixture) : csharpSource(fixture);
  const projectFile = `${fixture.projectName}.${fsharp ? 'fsproj' : 'csproj'}`;
  const dir = writeProject(
    path.join(root, fixture.projectName),
    projectFile,
    xml,
    sourceFileName,
    source,
  );
  if (fixture.framework === 'xunit' && fixture.runner === 'mtp') writeDiagnosticsOptIn(dir);
  return dir;
}
