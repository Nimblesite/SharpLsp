// The two xUnit fixtures — C# and F# — that the Test Explorer suites discover
// side by side, and every fully-qualified name the pair exposes.
import { fixtureFor } from './test-explorer-fixtures';

export const CS = fixtureFor('xunit-csharp');
export const FS_FIXTURE = fixtureFor('xunit-fsharp');

/** The idiomatic F# backtick binding whose xUnit FQN literally contains spaces. */
export const FS_FACT_SPACED = 'Fs.Xunit.Fixtures.adds two numbers with spaces';
/** The theories whose two rows DISAGREE — both report under this one FQN. */
export const FS_MIXED_THEORY = 'Fs.Xunit.Fixtures.mixed theory';
export const CS_MIXED_THEORY = 'Cs.Xunit.Fixtures.CalculatorTests.Mixed_Theory';

/** EXHAUSTIVELY every FQN the two xUnit fixtures expose: six F# (first), five C#. */
export const XUNIT_PAIR_IDS = [
  FS_FIXTURE.passing,
  FS_FACT_SPACED,
  FS_FIXTURE.failing,
  FS_FIXTURE.skipped,
  FS_FIXTURE.parameterized,
  FS_MIXED_THEORY,
  CS.passing,
  CS.failing,
  CS.skipped,
  CS.parameterized,
  CS_MIXED_THEORY,
] as const;
