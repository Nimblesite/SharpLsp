// Test projects that LOG, in every way each framework captures ([TEST-RUN-OUTPUT]).
//
// What a test writes is shown where its framework sends it. Probed against
// real builds, the frameworks send it to one of two places:
//
//   • the TEST'S OWN RESULT, which the TRX report carries — VSTest and MTP's
//     `--report-trx` as `<Output><StdOut>`/`<StdErr>`, xUnit's own
//     `--report-xunit-trx` as one `<TextMessages><Message>` per line:
//       xUnit 2    `ITestOutputHelper`
//       xunit.v3   `ITestOutputHelper`, `TestContext.Current.TestOutputHelper`,
//                  Console out and error (`[CaptureConsole]`), Debug and Trace
//                  (`[CaptureTrace]`)
//       NUnit      `TestContext.Out`, `TestContext.WriteLine`, `TestContext.Error`,
//                  Console out and error
//       MSTest     `TestContext.WriteLine`, Console out and error, Debug, Trace,
//                  `Logger.LogMessage`
//   • the RUNNER'S CONSOLE, outside any one test: xunit.v3 diagnostic messages
//     (opted in through `testconfig.json`) and NUnit's `TestContext.Progress`
//     on MTP. VSTest prints adapter progress only above its default verbosity,
//     exactly as `dotnet test` does in a terminal.
//
// xUnit 2 captures neither Console, Debug nor Trace by design; its docs point
// at `ITestOutputHelper`, so that is the only xUnit 2 channel.
//
// Every project exists in F# and C#. The F# xunit.v3 module deliberately has NO
// `Microsoft.Testing.Extensions.TrxReport`, so its run falls back to xUnit's own
// reporter and proves the `<TextMessages>` shape; the C# one proves `<StdOut>`.
// Every line carries its project's tag and its test's channel, so output shown
// on the wrong test or the wrong project is caught, not only output that is lost.
import {
  MSTEST_PACKAGES,
  MTP_MSTEST_PACKAGES,
  MTP_NUNIT_PACKAGES,
  MTP_TRX_REPORT,
  MTP_XUNIT_PACKAGES,
  NUNIT_PACKAGES,
  XUNIT_PACKAGES,
  type PackageRef,
} from './dotnet-project-kit';

export type OutputFramework = 'xunit' | 'nunit' | 'mstest';
export type OutputRunner = 'vstest' | 'mtp';

/** Where the framework sends what one call writes. */
export type Destination = 'test' | 'run';

/** One way to log: `<receiver>("<text>")`, spelled the same in C# and F#. */
export interface Channel {
  /** Kebab-case; the test's name derives from it. */
  readonly key: string;
  readonly receiver: string;
  readonly destination: Destination;
}

/** One logging test project. */
export interface OutputFixture {
  /** The prefix of every line the project writes; also its stable key. */
  readonly tag: string;
  readonly framework: OutputFramework;
  readonly language: 'fsharp' | 'csharp';
  readonly runner: OutputRunner;
  readonly projectName: string;
  readonly packages: readonly PackageRef[];
  /** One passing test per channel, each writing one line through it. */
  readonly channels: readonly Channel[];
}

/** A channel captured into the test's own result unless `destination` says otherwise. */
function channel(key: string, receiver: string, destination: Destination = 'test'): Channel {
  return { key, receiver, destination };
}

const CONSOLE = channel('console', 'Console.WriteLine');
const CONSOLE_ERROR = channel('console-error', 'Console.Error.WriteLine');
const DEBUG = channel('debug', 'Debug.WriteLine');
const TRACE = channel('trace', 'Trace.WriteLine');
const HELPER = channel('helper', 'output.WriteLine');

/** Every channel each framework captures, per runner. The first one also writes the failing test. */
const CHANNELS: Record<OutputFramework, Record<OutputRunner, readonly Channel[]>> = {
  xunit: {
    vstest: [HELPER],
    mtp: [
      HELPER,
      channel('context-helper', 'TestContext.Current.TestOutputHelper.WriteLine'),
      CONSOLE,
      CONSOLE_ERROR,
      DEBUG,
      TRACE,
      channel('diagnostic', 'TestContext.Current.SendDiagnosticMessage', 'run'),
    ],
  },
  nunit: { vstest: nunitChannels(), mtp: [...nunitChannels(), nunitProgress()] },
  mstest: { vstest: mstestChannels(), mtp: mstestChannels() },
};

/** NUnit's per-test channels, on either runner. */
function nunitChannels(): Channel[] {
  return [
    channel('context-out', 'TestContext.Out.WriteLine'),
    channel('context-write-line', 'TestContext.WriteLine'),
    channel('context-error', 'TestContext.Error.WriteLine'),
    CONSOLE,
    CONSOLE_ERROR,
  ];
}

/** NUnit's live progress: the runner's console, never the test's result. */
function nunitProgress(): Channel {
  return channel('progress', 'TestContext.Progress.WriteLine', 'run');
}

/** MSTest's per-test channels, on either runner. */
function mstestChannels(): Channel[] {
  return [
    channel('context-write-line', 'this.TestContext.WriteLine'),
    CONSOLE,
    CONSOLE_ERROR,
    DEBUG,
    TRACE,
    channel('logger', 'Logger.LogMessage'),
  ];
}

/** The packages a framework runs on, per runner; the F# xunit.v3 module drops its TRX extension. */
function packagesOf(fixture: Omit<OutputFixture, 'packages' | 'channels'>): readonly PackageRef[] {
  const { framework, runner, language } = fixture;
  if (runner === 'vstest') {
    return { xunit: XUNIT_PACKAGES, nunit: NUNIT_PACKAGES, mstest: MSTEST_PACKAGES }[framework];
  }
  if (framework === 'xunit' && language === 'fsharp') {
    return MTP_XUNIT_PACKAGES.filter((pkg) => pkg !== MTP_TRX_REPORT);
  }
  return { xunit: MTP_XUNIT_PACKAGES, nunit: MTP_NUNIT_PACKAGES, mstest: MTP_MSTEST_PACKAGES }[
    framework
  ];
}

/** The fixture for one framework, language and runner. */
function fixtureOf(
  framework: OutputFramework,
  language: 'fsharp' | 'csharp',
  runner: OutputRunner,
): OutputFixture {
  const short = language === 'fsharp' ? 'fs' : 'cs';
  const pascal = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  const projectName = `${pascal(short)}.Output.${pascal(framework)}${pascal(runner)}`;
  const named = {
    tag: `${short}-${framework}-${runner}`,
    framework,
    language,
    runner,
    projectName,
  };
  return { ...named, packages: packagesOf(named), channels: CHANNELS[framework][runner] };
}

/** Every framework on `runner`, F# first. */
function fixturesOn(runner: OutputRunner): OutputFixture[] {
  const frameworks: readonly OutputFramework[] = ['xunit', 'nunit', 'mstest'];
  return frameworks.flatMap((framework) => [
    fixtureOf(framework, 'fsharp', runner),
    fixtureOf(framework, 'csharp', runner),
  ]);
}

export const VSTEST_OUTPUT_FIXTURES: readonly OutputFixture[] = fixturesOn('vstest');
export const MTP_OUTPUT_FIXTURES: readonly OutputFixture[] = fixturesOn('mtp');

/** Words of a test name: `context-out` → `writes context out`. */
function wordsOf(key: string): string[] {
  return ['writes', ...key.split('-')];
}

/**
 * The name a test is declared under: an F# xUnit or NUnit binding is an idiomatic
 * backtick name carrying SPACES; everything else is PascalCase.
 */
export function testNameOf(fixture: OutputFixture, key: string): string {
  const words = wordsOf(key);
  if (fixture.language === 'fsharp' && fixture.framework !== 'mstest') return words.join(' ');
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join('');
}

/** The test id of the test named for `key`. */
export function testIdOf(fixture: OutputFixture, key: string): string {
  return `${fixture.projectName}.OutputTests.${testNameOf(fixture, key)}`;
}

/** The line the test named for `key` writes. */
export function markerOf(fixture: OutputFixture, key: string): string {
  return `${fixture.tag} ${key}`;
}

/** Keys of the tests beside the channel tests: one fails after writing, one writes nothing. */
export const FAILS = 'then-fails';
export const NOTHING = 'nothing';
/** The xUnit theory whose two rows each write one line, under ONE id. */
export const ROWS = 'rows';

/** What each row of {@link ROWS} writes before its row number. */
export function rowPrefixOf(fixture: OutputFixture): string {
  return `${markerOf(fixture, ROWS)} `;
}

/** The lines each row of {@link ROWS} writes. */
export function rowMarkersOf(fixture: OutputFixture): string[] {
  return [1, 2].map((row) => `${rowPrefixOf(fixture)}${String(row)}`);
}

/** Every key the project declares a test for. */
export function keysOf(fixture: OutputFixture): string[] {
  const rows = fixture.framework === 'xunit' ? [ROWS] : [];
  return [...fixture.channels.map((each) => each.key), FAILS, NOTHING, ...rows];
}

/** Every test id the project declares. */
export function idsOf(fixtures: readonly OutputFixture[]): string[] {
  return fixtures.flatMap((fixture) => keysOf(fixture).map((key) => testIdOf(fixture, key)));
}

/** The channel the failing test and the theory rows write through. */
export function primaryOf(fixture: OutputFixture): Channel {
  const [first] = fixture.channels;
  if (first === undefined) throw new Error(`${fixture.tag} declares no channel`);
  return first;
}
