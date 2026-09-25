// Real multi-targeted fixtures for the [NETFX-CONTEXT] language suites, one per
// language, F# first:
//
//   • Shared — a .NET Standard library built for netstandard2.0 AND 2.1, with a
//     member (`combineHash` / `CombineHash`, over System.HashCode) that only its
//     2.1 build compiles;
//   • Probe — built for THREE .NET Framework versions, BOTH .NET Standard
//     versions and the newest .NET this agent runs, referencing Shared. Every
//     framework has an `#if`-guarded name of its own, so a hover proves which
//     framework answered; Remoting sits behind `#if NETFRAMEWORK`; and its Flip
//     file uses `DateOnly` and Shared's 2.1-only member UNGUARDED, so the Errors
//     it carries prove both the active framework and the Shared build MSBuild
//     picked for it (netstandard2.0 for .NET Framework, 2.1 for 2.1 and .NET);
//   • Single — one target framework, which must answer `available: []`.
//
// Observes [NETFX-CONTEXT], [NETFX-PROJECTS-CSHARP] and [NETFX-PROJECTS-FSHARP].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildProjectXml,
  createSolution,
  dotnet,
  installedNetCoreTargets,
  symbolFor,
} from './dotnet-project-kit';
import { declared, type ProjectFrameworks } from './netfx-context-kit';
import { isNetFramework } from './netfx-test-kit';
import {
  fixtureSolutionPath,
  loadSolutionInServer,
  openRepoFile,
  positionOf,
  waitForSemanticReady,
} from './real-repo-helpers';
import type { Anchor } from './real-repo-kit';
import { closeAllEditors, pollUntilResult, removeDirRecursive } from './test-helpers';
import {
  ACTIVATION_MS,
  FIXTURE_BUILD_MS,
  LSP_RESPONSE_MS,
  REAL_REPO_WARMUP_MS,
} from './test-timeouts';

/** The two languages every [NETFX] feature serves, F# first. */
export type NetfxLanguage = 'fsharp' | 'csharp';

/** A built fixture: where everything is, and what each framework must show. */
export interface LanguageFixture {
  readonly root: string;
  readonly solution: string;
  /** Probe's frameworks: three .NET Framework, two .NET Standard, one .NET. */
  readonly probe: ProjectFrameworks;
  /** Shared's frameworks: both .NET Standard versions. */
  readonly shared: ProjectFrameworks;
  /** Repo-relative source files. */
  readonly files: {
    readonly probe: string;
    readonly flip: string;
    readonly shared: string;
    readonly single: string;
  };
  /** The `#if`-guarded name each framework alone compiles. */
  readonly nameOf: (tfm: string) => Anchor;
  /** Remoting, compiled only under `#if NETFRAMEWORK`. */
  readonly remoting: Anchor;
  /** Probe's call into Shared, and the name it binds. */
  readonly greetCall: Anchor;
  /** Shared's 2.1-only member, at its declaration. */
  readonly combineHash: Anchor;
  /** The identifiers Flip's Errors name: the .NET-only type, the 2.1-only member. */
  readonly flipNames: { readonly dateOnly: string; readonly combineHash: string };
}

/** Everything that differs between the two languages. */
interface LanguageShape {
  readonly extension: 'fs' | 'cs';
  readonly nameOf: (tfm: string) => string;
  readonly guardedName: (tfm: string) => string[];
  readonly probeSource: (frameworks: readonly string[]) => string;
  readonly flipSource: string;
  readonly sharedSource: string;
  readonly singleSource: string;
  readonly remoting: Anchor;
  readonly greetCall: Anchor;
  readonly combineHash: Anchor;
  readonly flipNames: { readonly dateOnly: string; readonly combineHash: string };
}

/** `#if <SYMBOL>` … `#endif` around one declaration: the same in both languages. */
function guarded(symbol: string, lines: readonly string[]): string[] {
  return [`#if ${symbol}`, ...lines, '#endif'];
}

const FSHARP: LanguageShape = {
  extension: 'fs',
  nameOf: (tfm) => `on${symbolFor(tfm)}`,
  guardedName: (tfm) => guarded(symbolFor(tfm), [`let on${symbolFor(tfm)} = "${tfm}"`]),
  probeSource: (frameworks) =>
    [
      'module Fx.Probe',
      '',
      ...frameworks.flatMap((tfm) => FSHARP.guardedName(tfm)),
      ...guarded('NETFRAMEWORK', [
        'let isProxy (o: obj) = System.Runtime.Remoting.RemotingServices.IsTransparentProxy o',
      ]),
      'let greeting = Fx.Shared.greet "probe"',
      '',
    ].join('\n'),
  flipSource: [
    'module Fx.Flip',
    '',
    'let today () = System.DateOnly.MinValue',
    'let hashed = Fx.Shared.combineHash 1 2',
    '',
  ].join('\n'),
  sharedSource: [
    'module Fx.Shared',
    '',
    'let greet (name: string) = "hello " + name',
    ...guarded('NETSTANDARD2_1', [
      'let combineHash (a: int) (b: int) = System.HashCode.Combine(a, b)',
    ]),
    '',
  ].join('\n'),
  singleSource: ['module Fx.Single', '', 'let only = 1', ''].join('\n'),
  remoting: ['System.Runtime.Remoting.RemotingServices.IsTransparentProxy o', 'RemotingServices'],
  greetCall: ['Fx.Shared.greet "probe"', 'greet'],
  combineHash: ['let combineHash (a: int) (b: int)', 'combineHash'],
  flipNames: { dateOnly: 'DateOnly', combineHash: 'combineHash' },
};

/** A C# class body, wrapped in the namespace every fixture file shares. */
function csharpClass(name: string, members: readonly string[]): string {
  return [
    'namespace Fx',
    '{',
    `    public static class ${name}`,
    '    {',
    ...members,
    '    }',
    '}',
    '',
  ].join('\n');
}

const CSHARP: LanguageShape = {
  extension: 'cs',
  nameOf: (tfm) => `On${symbolFor(tfm)}`,
  guardedName: (tfm) =>
    guarded(symbolFor(tfm), [`        public const string On${symbolFor(tfm)} = "${tfm}";`]),
  probeSource: (frameworks) =>
    csharpClass('Probe', [
      ...frameworks.flatMap((tfm) => CSHARP.guardedName(tfm)),
      ...guarded('NETFRAMEWORK', [
        '        public static bool IsProxy(object o) => System.Runtime.Remoting.RemotingServices.IsTransparentProxy(o);',
      ]),
      '        public static string Greeting => Shared.Greet("probe");',
    ]),
  flipSource: csharpClass('Flip', [
    '        public static object Today() => System.DateOnly.MinValue;',
    '        public static int Hashed() => Shared.CombineHash(1, 2);',
  ]),
  sharedSource: csharpClass('Shared', [
    '        public static string Greet(string name) => "hello " + name;',
    ...guarded('NETSTANDARD2_1', [
      '        public static int CombineHash(int a, int b) => System.HashCode.Combine(a, b);',
    ]),
  ]),
  singleSource: csharpClass('Single', ['        public const int Only = 1;']),
  remoting: ['System.Runtime.Remoting.RemotingServices.IsTransparentProxy(o)', 'RemotingServices'],
  greetCall: ['Shared.Greet("probe")', 'Greet'],
  combineHash: ['public static int CombineHash(int a, int b)', 'CombineHash'],
  flipNames: { dateOnly: 'DateOnly', combineHash: 'CombineHash' },
};

/** One fixture project: its directory, file name, XML and sources. */
interface ProjectSpec {
  readonly name: string;
  readonly frameworks: readonly string[];
  readonly sources: Readonly<Record<string, string>>;
  readonly references?: readonly string[];
}

/** Write one project and its sources; return its directory. */
function writeFixtureProject(root: string, shape: LanguageShape, spec: ProjectSpec): string {
  const dir = path.join(root, spec.name);
  fs.mkdirSync(dir, { recursive: true });
  const properties = { TargetFrameworks: spec.frameworks.join(';') };
  const compileIncludes = shape.extension === 'fs' ? Object.keys(spec.sources) : [];
  const xml = buildProjectXml({
    properties,
    compileIncludes,
    projectReferences: spec.references ?? [],
  });
  fs.writeFileSync(path.join(dir, `${spec.name}.${shape.extension}proj`), xml, 'utf8');
  for (const [file, source] of Object.entries(spec.sources))
    fs.writeFileSync(path.join(dir, file), source, 'utf8');
  return dir;
}

/** The three projects, in the order the solution lists them. */
function projectSpecs(shape: LanguageShape, probe: readonly string[], net: string): ProjectSpec[] {
  const ext = shape.extension;
  return [
    {
      name: 'Shared',
      frameworks: ['netstandard2.0', 'netstandard2.1'],
      sources: { [`Shared.${ext}`]: shape.sharedSource },
    },
    {
      name: 'Probe',
      frameworks: probe,
      sources: { [`Probe.${ext}`]: shape.probeSource(probe), [`Flip.${ext}`]: shape.flipSource },
      references: [path.join('..', 'Shared', `Shared.${ext}proj`)],
    },
    { name: 'Single', frameworks: [net], sources: { [`Single.${ext}`]: shape.singleSource } },
  ];
}

/** Write, restore and half-build the fixture: Shared builds; Probe's Flip must not. */
async function writeLanguageFixture(
  language: NetfxLanguage,
  root: string,
): Promise<LanguageFixture> {
  const shape = language === 'fsharp' ? FSHARP : CSHARP;
  const net = (await installedNetCoreTargets(root)).at(-1);
  assert.ok(net !== undefined, 'this agent runs at least one .NET');
  const probe = declared('net462', 'net472', 'net48', 'netstandard2.0', 'netstandard2.1', net);
  const dirs = projectSpecs(shape, probe.available, net).map((spec) =>
    writeFixtureProject(root, shape, spec),
  );
  const solution = await createSolution(root, 'NetfxLanguage', dirs);
  await dotnet(['restore', solution], root);
  await dotnet(['build', path.join(root, 'Shared', `Shared.${shape.extension}proj`)], root);
  return fixtureOf(shape, root, solution, probe);
}

/** The observable contract of a written fixture. */
function fixtureOf(
  shape: LanguageShape,
  root: string,
  solution: string,
  probe: ProjectFrameworks,
): LanguageFixture {
  const ext = shape.extension;
  return {
    root,
    solution,
    probe,
    shared: declared('netstandard2.0', 'netstandard2.1'),
    files: {
      probe: `Probe/Probe.${ext}`,
      flip: `Probe/Flip.${ext}`,
      shared: `Shared/Shared.${ext}`,
      single: `Single/Single.${ext}`,
    },
    nameOf: (tfm) => [shape.guardedName(tfm)[1]?.trim() ?? '', shape.nameOf(tfm)],
    remoting: shape.remoting,
    greetCall: shape.greetCall,
    combineHash: shape.combineHash,
    flipNames: shape.flipNames,
  };
}

/**
 * Build `language`'s fixture for the suite and load it through the real
 * extension, waiting until Probe answers SEMANTIC hover under its first
 * framework. Teardown puts the default fixture solution back.
 */
export function useLanguageFixture(language: NetfxLanguage): () => LanguageFixture {
  let fixture: LanguageFixture | undefined;
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS + REAL_REPO_WARMUP_MS);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sharplsp-netfx-${language}-`));
    fixture = await writeLanguageFixture(language, root);
    await loadSolutionInServer(fixture.solution);
    const { doc, uri } = await openRepoFile(root, fixture.files.probe);
    await waitForSemanticReady(
      uri,
      positionOf(doc, ...fixture.nameOf(fixture.probe.first)),
      REAL_REPO_WARMUP_MS,
    );
  });
  suiteTeardown(async function () {
    this.timeout(ACTIVATION_MS);
    await closeAllEditors();
    await loadSolutionInServer(fixtureSolutionPath());
    if (fixture !== undefined) removeDirRecursive(fixture.root);
  });
  return () => {
    assert.ok(fixture, 'the language fixture is built in suiteSetup');
    return fixture;
  };
}

/**
 * The Flip names that must be Errors under `tfm`: `DateOnly` everywhere but
 * .NET; Shared's 2.1-only member wherever MSBuild hands Probe Shared's
 * netstandard2.0 build — every .NET Framework version, and netstandard2.0.
 */
export function flipErrorsUnder(fixture: LanguageFixture, tfm: string): string[] {
  const modern = !isNetFramework(tfm) && !tfm.startsWith('netstandard');
  const sharedIsTwoOne = modern || tfm === 'netstandard2.1';
  return [
    ...(modern ? [] : [fixture.flipNames.dateOnly]),
    ...(sharedIsTwoOne ? [] : [fixture.flipNames.combineHash]),
  ];
}

/** The Flip names the file's Error diagnostics mention, sorted. */
function erroredNames(uri: vscode.Uri, names: readonly string[]): string[] {
  const errors = vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
  return names.filter((name) => errors.some((error) => error.message.includes(name))).sort();
}

/** Poll until Flip's Errors name EXACTLY `expected`, then assert it. */
export async function assertFlipErrors(
  fixture: LanguageFixture,
  uri: vscode.Uri,
  expected: readonly string[],
  tfm: string,
): Promise<void> {
  const names = [fixture.flipNames.dateOnly, fixture.flipNames.combineHash];
  const want = [...expected].sort();
  const got = await pollUntilResult(
    async () => erroredNames(uri, names),
    (found) => JSON.stringify(found) === JSON.stringify(want),
    LSP_RESPONSE_MS,
    500,
    `Flip's Errors under ${tfm} to name ${want.join(', ') || 'nothing'}`,
  );
  assert.deepStrictEqual(
    got,
    want,
    `under ${tfm}, Flip's Errors name exactly ${want.join(', ') || 'nothing'}`,
  );
}
