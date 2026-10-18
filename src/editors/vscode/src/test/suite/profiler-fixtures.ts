// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. The .NET programs the profiler
// suites profile: where each fixture project lives, and its Release build.
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FIXTURES = path.resolve(__dirname, '../../../../../sharplsp/tests/fixtures');
/** lspkit's own targets, which prove the engine on every .NET language. */
const LSPKIT_FIXTURES = path.resolve(__dirname, '../../../../../../lspkit/dotnet/fixtures');
/** SharpLsp's real-world F# programs: a pricing engine and an event-sourced order ledger. */
const FSHARP_FIXTURES = path.join(FIXTURES, 'fsharp-profiling');

/** A profiling target: its project folder, target framework and source file. */
interface FixtureProject {
  readonly dir: string;
  readonly framework: string;
  readonly source: string;
}

const FIXTURE_PROJECTS: Readonly<Record<string, FixtureProject>> = {
  ProfileTarget: { dir: FIXTURES, framework: 'net10.0', source: 'Program.cs' },
  ProfileLeakTarget: { dir: FIXTURES, framework: 'net10.0', source: 'Program.cs' },
  // F#: records holding union cases leak into a module value ([PROF-TESTING]).
  HotLeakAppFs: { dir: LSPKIT_FIXTURES, framework: 'net8.0', source: 'Program.fs' },
  // F# CPU: CSV parsing, recursive discount rules, fuzzy search, route planning, reports.
  FsPricingEngine: { dir: FSHARP_FIXTURES, framework: 'net10.0', source: 'Program.fs' },
  // F# memory: event, memoize, mailbox and undo-history leaks in an order ledger.
  FsOrderLedger: { dir: FSHARP_FIXTURES, framework: 'net10.0', source: 'Program.fs' },
};

function fixtureProject(name: string): FixtureProject {
  const project = FIXTURE_PROJECTS[name];
  assert.ok(project, `unknown profiling fixture ${name}`);
  return project;
}

/** `dotnet` from PATH, else the user-local install the test host's PATH may lack. */
function dotnetExecutable(): string {
  const candidates = [
    'dotnet',
    path.join(os.homedir(), '.dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'),
  ];
  for (const candidate of candidates) {
    if (spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return candidate;
  }
  throw new Error('dotnet SDK not found: install it or put it on PATH');
}

/** Build a fixture project once (Release) and return its binary. */
export function buildFixture(name: string): string {
  const { dir, framework } = fixtureProject(name);
  const project = path.join(dir, name);
  const binary = path.join(
    project,
    'bin',
    'Release',
    framework,
    process.platform === 'win32' ? `${name}.exe` : name,
  );
  if (!fs.existsSync(binary)) {
    const build = spawnSync(dotnetExecutable(), ['build', '-c', 'Release', '--nologo', '-v', 'q'], {
      cwd: project,
      encoding: 'utf8',
    });
    assert.equal(
      build.status,
      0,
      `building ${name} failed: ${build.stderr ?? build.error?.message}`,
    );
  }
  assert.ok(fs.existsSync(binary), `${binary} missing after build`);
  return binary;
}

/** The source file of a fixture, where hot lines and allocation sites land. */
export function fixtureSource(name: string): string {
  const { dir, source } = fixtureProject(name);
  return path.join(dir, name, source);
}

/** Another source file of a multi-file fixture project. */
export function fixtureFile(name: string, file: string): string {
  return path.join(fixtureProject(name).dir, name, file);
}
