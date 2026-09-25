// Fixtures for the F# suites whose subject is MSBuild itself, and the launch
// gestures that depend on the frameworks MSBuild declares:
//
//   • Msb — MSBuild owns the compilation. A Directory.Build.props adds a
//     Compile item that is CONDITIONED (.NET Framework only), LINKED (the file
//     lives outside the project directory) and RELATIVE (to the project
//     directory); a Directory.Build.targets adds a define; and the project globs
//     a folder whose two files only compile in MSBuild's order
//     ([NETFX-PROJECTS-FSHARP]).
//   • Degrade — a Directory.Build.targets fails the F# design-time compile on
//     purpose, so the project must keep its literal Compile items against the
//     sidecar runtime and say why ([NETFX-PROJECTS-FSHARP]).
//   • RunProbe + NetfxOnly — console programs whose exit code names the
//     framework they really ran under: one built for net48 and .NET, one built
//     for .NET Framework alone, which F5 must refuse ([NETFX-DEBUG]).
//
// MSBuild files are STRUCTURED, so they come out of an XML serializer, never
// spliced together from lines; the project files come from the shared
// buildProjectXml.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { XMLBuilder } from 'fast-xml-parser';
import * as vscode from 'vscode';
import {
  buildProjectXml,
  createSolution,
  dotnet,
  installedFrameworkPair,
  installedNetCoreTargets,
} from './dotnet-project-kit';
import { declared, type ProjectFrameworks } from './netfx-context-kit';
import type { LoadedFixture } from './netfx-language-kit';
import type { Anchor } from './real-repo-kit';
import { isolateFromRepoMsbuild, writeLaunchSettings } from './run-debug-fixtures';

// `XMLBuilder` is marked deprecated in fast-xml-parser 5 in favour of the
// days-old `fast-xml-builder` package — the same trade dotnet-project-kit makes:
// MSBuild files must come out of a real serializer, and taking a brand-new
// package into the extension's dependency tree for a test fixture is worse.
// eslint-disable-next-line @typescript-eslint/no-deprecated -- see above; the replacement package is days old
const msbuildWriter = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
});

/** Serialize one `<Project>` (a Directory.Build.* file) to `file`. */
function writeMsbuild(file: string, project: Readonly<Record<string, unknown>>): void {
  const xml: string = msbuildWriter.build({ Project: project });
  fs.writeFileSync(file, xml.trimStart(), 'utf8');
}

/** Write root-relative files, creating their directories. */
function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text, 'utf8');
  }
}

/** The newest .NET this agent runs. */
async function newestNet(root: string): Promise<string> {
  const net = (await installedNetCoreTargets(root)).at(-1);
  assert.ok(net !== undefined, 'this agent runs at least one .NET');
  return net;
}

/** What one F# fixture project declares and compiles. */
interface FsharpProject {
  readonly name: string;
  readonly frameworks: ProjectFrameworks;
  readonly compile: readonly string[];
  readonly properties?: Readonly<Record<string, string>>;
}

/** Write `project` from the shared writer; return its project file. */
function writeFsharpProject(root: string, project: FsharpProject): string {
  const properties = {
    ...project.properties,
    TargetFrameworks: project.frameworks.available.join(';'),
  };
  const xml = buildProjectXml({ properties, compileIncludes: project.compile });
  const file = `${project.name}/${project.name}.fsproj`;
  writeFiles(root, { [file]: xml });
  return path.join(root, file);
}

/** A solution the `dotnet` CLI authors around `projectFiles`, restored. */
async function restoredSolution(
  root: string,
  name: string,
  projectFiles: readonly string[],
): Promise<string> {
  const solution = await createSolution(
    root,
    name,
    projectFiles.map((file) => path.dirname(file)),
  );
  await dotnet(['restore', solution], root);
  return solution;
}

/** The MSBuild condition that admits an item on .NET Framework only. */
const NETFX_ONLY = "'$(TargetFrameworkIdentifier)' == '.NETFramework'";

/** Program.fs's use of the linked, .NET Framework-only file. */
export const LINKED_USE: Anchor = ['let viaLink = Msb.Linked.linkedValue', 'linkedValue'];
/** Program.fs's use of the second globbed file. */
export const GLOB_USE: Anchor = ['let viaGlob = Msb.Globbed.B.second', 'second'];
/** B.fs's use of A.fs — valid only in MSBuild's glob order, A before B. */
export const ORDERED_USE: Anchor = ['let second = Msb.Globbed.A.first + 1', 'first'];
/** First.fs's name, defined only by the Directory.Build.targets define. */
export const DIRECTORY_BUILD_NAME: Anchor = ['let fromDirectoryBuild = 1', 'fromDirectoryBuild'];

const MSB_SOURCES: Readonly<Record<string, string>> = {
  'Shared/Linked.fs': 'module Msb.Linked\n\nlet linkedValue = 48\n',
  'Msb/First.fs': [
    'module Msb.First',
    '',
    '#if SHARPLSP_DIRECTORY_BUILD',
    'let fromDirectoryBuild = 1',
    '#endif',
    '',
  ].join('\n'),
  'Msb/Globbed/A.fs': 'module Msb.Globbed.A\n\nlet first = 1\n',
  'Msb/Globbed/B.fs': 'module Msb.Globbed.B\n\nlet second = Msb.Globbed.A.first + 1\n',
  'Msb/Program.fs': [
    'module Msb.Program',
    '',
    'let viaLink = Msb.Linked.linkedValue',
    'let viaGlob = Msb.Globbed.B.second',
    'let viaDirectoryBuild = Msb.First.fromDirectoryBuild',
    '',
  ].join('\n'),
};

/** The Msb fixture: its frameworks and its root-relative files. */
export interface MsbuildFixture extends LoadedFixture {
  readonly project: ProjectFrameworks;
  readonly files: {
    readonly program: string;
    readonly first: string;
    readonly a: string;
    readonly b: string;
    readonly linked: string;
  };
}

/** Write the Msb fixture: Directory.Build.props/targets, a glob, and a linked file. */
export async function writeMsbuildFixture(root: string): Promise<MsbuildFixture> {
  const project = declared('net48', await newestNet(root));
  const linked = {
    '@_Include': '../Shared/Linked.fs',
    '@_Link': 'Linked.fs',
    '@_Condition': NETFX_ONLY,
  };
  writeMsbuild(path.join(root, 'Directory.Build.props'), { ItemGroup: { Compile: linked } });
  const define = { DefineConstants: '$(DefineConstants);SHARPLSP_DIRECTORY_BUILD' };
  writeMsbuild(path.join(root, 'Directory.Build.targets'), { PropertyGroup: define });
  writeFiles(root, MSB_SOURCES);
  const compile = ['First.fs', 'Globbed/*.fs', 'Program.fs'];
  const projectFile = writeFsharpProject(root, { name: 'Msb', frameworks: project, compile });
  const solution = await restoredSolution(root, 'Msb', [projectFile]);
  const files = {
    program: 'Msb/Program.fs',
    first: 'Msb/First.fs',
    a: 'Msb/Globbed/A.fs',
    b: 'Msb/Globbed/B.fs',
    linked: 'Shared/Linked.fs',
  };
  return { root, solution, project, files, ready: { file: files.program, anchor: GLOB_USE } };
}

/** What the fixture's Directory.Build.targets makes every F# design-time compile fail with. */
export const DESIGN_TIME_FAILURE = 'SharpLsp fixture: the F# design-time compile fails on purpose';

/** Plain code, compiled whatever the framework. */
export const PLAIN: Anchor = ['let plain = 1', 'plain'];
/** A name only a NETFRAMEWORK define lights. */
export const NETFX_NAME: Anchor = ['let netfxName = 2', 'netfxName'];

/** The Degrade fixture: its frameworks, its project file and its one source. */
export interface DegradeFixture extends LoadedFixture {
  readonly project: ProjectFrameworks;
  readonly projectFile: string;
  readonly probe: string;
}

/**
 * Write the Degrade fixture. Its Directory.Build.targets fails ONLY the F#
 * design-time compile: `dotnet restore`, `dotnet build`, evaluation and every
 * C# project's MSBuildWorkspace load are untouched.
 */
export async function writeDegradeFixture(root: string): Promise<DegradeFixture> {
  const project = declared('net48', await newestNet(root));
  const fail = {
    '@_Name': 'SharpLspFailFSharpDesignTime',
    '@_BeforeTargets': 'CoreCompile',
    '@_Condition': "'$(DesignTimeBuild)' == 'true' And '$(Language)' == 'F#'",
    Error: { '@_Text': DESIGN_TIME_FAILURE },
  };
  writeMsbuild(path.join(root, 'Directory.Build.targets'), { Target: fail });
  const probe = 'Degrade/Probe.fs';
  const source = [
    'module Fx.Degrade',
    '',
    'let plain = 1',
    '',
    '#if NETFRAMEWORK',
    'let netfxName = 2',
    '#endif',
    '',
  ];
  writeFiles(root, { [probe]: source.join('\n') });
  const projectFile = writeFsharpProject(root, {
    name: 'Degrade',
    frameworks: project,
    compile: ['Probe.fs'],
  });
  const solution = await restoredSolution(root, 'Degrade', [projectFile]);
  return { root, solution, project, projectFile, probe, ready: { file: probe, anchor: PLAIN } };
}

/** Every F# sidecar log line about `projectFile`: the logs roll daily and are shared machine-wide. */
export function fsharpSidecarLinesAbout(projectFile: string): string[] {
  const dir = path.join(os.tmpdir(), 'sharplsp-logs');
  if (!fs.existsSync(dir)) return [];
  const logs = fs.readdirSync(dir).filter((file) => file.startsWith('sidecar-fsharp'));
  const unique = path.basename(path.dirname(path.dirname(projectFile)));
  return logs
    .flatMap((file) => fs.readFileSync(path.join(dir, file), 'utf8').split('\n'))
    .filter((line) => line.includes(path.basename(projectFile)) && line.includes(unique));
}

/** A console program's exit code on .NET Framework, and on .NET: the proof of what ran. */
export const EXIT_ON_NETFX = 48;
export const EXIT_ON_NET = 10;

/** One runnable fixture project. */
export interface RunnableProject {
  readonly name: string;
  readonly frameworks: ProjectFrameworks;
  readonly projectFile: string;
  /** Root-relative path of its Program.fs. */
  readonly program: string;
  /** The arguments its launch profile passes; empty when it has no profile. */
  readonly profileArgs: readonly string[];
}

/** Both runnable projects, in one solution. */
export interface RunFixture extends LoadedFixture {
  /** net48 FIRST, then TWO .NET versions: F5's first-.NET and active-.NET cases differ. */
  readonly probe: RunnableProject;
  /** .NET Framework alone, with a launch profile: runnable, never debuggable. */
  readonly netfxOnly: RunnableProject;
}

/**
 * A console program named `name` returning 48 on .NET Framework and 10 on
 * .NET, PLUS the number of arguments it received — so an exit code proves both
 * the framework that ran and the arguments that reached it.
 */
function writeConsole(root: string, name: string, frameworks: ProjectFrameworks): string {
  const program = `${name}/Program.fs`;
  const exits = [
    '#if NETFRAMEWORK',
    `    ${String(EXIT_ON_NETFX)} + argv.Length`,
    '#else',
    `    ${String(EXIT_ON_NET)} + argv.Length`,
    '#endif',
  ];
  writeFiles(root, {
    [program]: [`module Fx.${name}`, '', '[<EntryPoint>]', 'let main argv =', ...exits, ''].join(
      '\n',
    ),
  });
  const properties = { OutputType: 'Exe' };
  return writeFsharpProject(root, { name, frameworks, compile: ['Program.fs'], properties });
}

/** The arguments NetfxOnly's launch profile passes. */
const PROFILE_ARGS = ['alpha', 'beta'];

/**
 * Write RunProbe (net48 + the two newest .NET) and NetfxOnly (net462 + net48,
 * with a launch profile) into one solution. Launching needs the fixture inside
 * a workspace folder — inside the SharpLsp repository — so the root first stops
 * every upward MSBuild and `.editorconfig` walk, or the repo's analyzers would
 * fail the build.
 */
export async function writeRunFixture(root: string): Promise<RunFixture> {
  isolateFromRepoMsbuild(root);
  const probeFrameworks = declared('net48', ...(await installedFrameworkPair(root)));
  const probeFile = writeConsole(root, 'RunProbe', probeFrameworks);
  const netfxFrameworks = declared('net462', 'net48');
  const netfxFile = writeConsole(root, 'NetfxOnly', netfxFrameworks);
  const profile = { commandName: 'Project', commandLineArgs: PROFILE_ARGS.join(' ') };
  writeLaunchSettings(path.dirname(netfxFile), { profiles: { NetfxOnly: profile } });
  const solution = await restoredSolution(root, 'Launch', [probeFile, netfxFile]);
  const project = (
    name: string,
    frameworks: ProjectFrameworks,
    projectFile: string,
    profileArgs: readonly string[],
  ): RunnableProject => ({
    name,
    frameworks,
    projectFile,
    program: `${name}/Program.fs`,
    profileArgs,
  });
  const probe = project('RunProbe', probeFrameworks, probeFile, []);
  const netfxOnly = project('NetfxOnly', netfxFrameworks, netfxFile, PROFILE_ARGS);
  const ready: LoadedFixture['ready'] = {
    file: probe.program,
    anchor: ['let main argv =', 'main'],
  };
  return { root, solution, probe, netfxOnly, ready };
}

/** A started task's definition, and whether it runs a process with no shell. */
export interface StartedTask {
  readonly definition: vscode.TaskDefinition;
  readonly isProcess: boolean;
}

/** Record every task that starts until disposed: its full definition, not just its type. */
export function recordStartedTasks(): {
  readonly started: StartedTask[];
  readonly dispose: () => void;
} {
  const started: StartedTask[] = [];
  const subscription = vscode.tasks.onDidStartTask((event) => {
    const task = event.execution.task;
    started.push({
      definition: task.definition,
      isProcess: task.execution instanceof vscode.ProcessExecution,
    });
  });
  return {
    started,
    dispose: () => {
      subscription.dispose();
    },
  };
}
