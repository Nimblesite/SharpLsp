// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]. The .NET debuggee of the profiler
// suites ported from Basilisk that launch through the debugger: Run & Profile
// CPU, Run & Track Memory, the autopilot, and memory ops on a live debuggee.
//
// It is written and built inside the opened workspace folder, so "Current
// File" launches resolve its project exactly as a user's would. One pass of its
// loop leaks one `Widget` (64 KiB) and burns CPU in `Spin`; 128 seeded Widgets
// keep the type in a top-50 summary even during Windows runtime startup. The loop line takes
// breakpoints. Line numbers are fixed by the text below.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DapRecorder } from './debug-dap-kit';
import { fakeFolder, stopAnyDebugSession } from './run-debug-kit';
import {
  buildProject,
  builtDll,
  isolateFromRepoMsbuild,
  type ConsoleProject,
} from './run-debug-fixtures';
import { removeDirRecursive, requireWorkspaceRoot } from './test-helpers';
import { DEBUG_SESSION_MS, FIXTURE_BUILD_MS } from './test-timeouts';
import { profilerStore } from './profiler-kit';
import { pollUntilResult } from './profiler-ui-helpers';

export const DEBUGGEE_NAME = 'LoopLeak';

const PROGRAM = `// A debuggee for the profiler's debug-launched flows: one leak and one hot loop per pass.
namespace LoopLeak;

internal sealed class Widget
{
    public byte[] Payload { get; } = new byte[64 * 1024];
}

internal static class Program
{
    private static readonly List<Widget> Cache = Enumerable.Range(0, 128).Select(_ => new Widget()).ToList();

    private static int LeakRound(int index)
    {
        Cache.Add(new Widget()); if (index == 0) Console.WriteLine("READY");
        return Cache.Count + index;
    }

    private static double Spin(int iterations)
    {
        var sum = 0.0;
        for (var i = 0; i < iterations; i++)
        {
            sum += Math.Sqrt(i) * Math.Sin(i);
        }
        return sum;
    }

    private static void Main(string[] args)
    {
        var seconds = args.Length > 0 && int.TryParse(args[0], out var parsed) ? parsed : 20;
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        var total = 0;
        var sink = 0.0;
        for (var index = 0; DateTime.UtcNow < deadline; index++)
        {
            total = LeakRound(index);
            sink += Spin(2_000_000);
        }
        Console.WriteLine($"done {total} {sink}");
    }
}
`;

/** 1-based: the leaked type's declaration, where the .NET runtime anchors its sites. */
export const WIDGET_LINE = 4;
/** 1-based: the Widget's 64 KiB payload, where its bytes are allocated. */
export const PAYLOAD_LINE = 6;
/** The two lines a leaked Widget is attributed to: its type and its payload. */
export const LEAK_LINES: readonly number[] = [WIDGET_LINE, PAYLOAD_LINE];
/** 1-based: `Cache.Add(new Widget());`, the allocation site. */
export const ALLOC_LINE = 15;
/** 1-based: the hot statement inside `Spin`. */
export const HOT_LINE = 24;
/** 1-based: `total = LeakRound(index);`, the loop breakpoint. */
export const LOOP_LINE = 37;

const PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <DebugType>portable</DebugType>
    <Optimize>false</Optimize>
  </PropertyGroup>
</Project>
`;

/** A built debuggee and where its program lives. */
export interface Debuggee {
  readonly project: ConsoleProject;
  readonly dll: string;
  readonly program: string;
  readonly folder: vscode.WorkspaceFolder;
}

/** Write and build the debuggee under a fresh scratch dir in the workspace. */
export async function materialiseDebuggee(prefix: string): Promise<Debuggee> {
  const root = fs.mkdtempSync(path.join(requireWorkspaceRoot(), prefix));
  isolateFromRepoMsbuild(root);
  const dir = path.join(root, DEBUGGEE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${DEBUGGEE_NAME}.csproj`), PROJECT, 'utf8');
  const program = path.join(dir, 'Program.cs');
  fs.writeFileSync(program, PROGRAM, 'utf8');
  const project: ConsoleProject = {
    projectFile: path.join(dir, `${DEBUGGEE_NAME}.csproj`),
    sourceFile: program,
    dir,
    assemblyName: DEBUGGEE_NAME,
  };
  await buildProject(project);
  const dll = builtDll(project);
  assert.ok(fs.existsSync(dll), `the debuggee must build to ${dll}`);
  return { project, dll, program, folder: fakeFolder(requireWorkspaceRoot()) };
}

/** Remove the scratch tree a debuggee was built in. */
export function removeDebuggee(debuggee: Debuggee | undefined): void {
  if (debuggee !== undefined) removeDirRecursive(path.dirname(debuggee.project.dir));
}

/** A plain SharpLsp launch of the debuggee, running for `seconds`. */
export function launchConfig(
  debuggee: Debuggee,
  name: string,
  seconds = 120,
): vscode.DebugConfiguration {
  return {
    type: 'sharplsp-coreclr',
    request: 'launch',
    name,
    program: debuggee.dll,
    args: [String(seconds)],
    cwd: debuggee.project.dir,
    console: 'internalConsole',
    stopAtEntry: false,
    justMyCode: true,
  };
}

/** Start `config` and wait for the SharpLsp session to be active. */
export async function launch(
  debuggee: Debuggee,
  config: vscode.DebugConfiguration,
): Promise<vscode.DebugSession> {
  const started = await vscode.debug.startDebugging(debuggee.folder, config);
  assert.ok(started, `the debug session "${config.name}" must launch`);
  const session = await pollUntilResult({
    fn: async () => vscode.debug.activeDebugSession,
    until: (active) => active?.type === 'sharplsp-coreclr',
    timeoutMs: DEBUG_SESSION_MS,
    description: 'an active SharpLsp debug session',
  });
  assert.ok(session);
  return session;
}

/** Show the debuggee's source, so decorations have an editor to land on. */
export async function showProgram(debuggee: Debuggee): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(debuggee.program);
  return vscode.window.showTextDocument(document, { preview: false });
}

/** Set breakpoints on 1-based `lines` of the debuggee's source. */
export function setBreakpoints(debuggee: Debuggee, lines: readonly number[]): void {
  vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
  vscode.debug.addBreakpoints(
    lines.map(
      (line) =>
        new vscode.SourceBreakpoint(
          new vscode.Location(vscode.Uri.file(debuggee.program), new vscode.Position(line - 1, 0)),
        ),
    ),
  );
}

/** Wait for the `count`-th stop the recorder has seen. */
export async function waitForPause(recorder: DapRecorder, count: number): Promise<void> {
  const stops = await recorder.waitForStops(count);
  assert.ok(stops.length >= count, `the debuggee must pause ${count} time(s)`);
}

/** Continue the paused debuggee. */
export async function resume(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.debug.continue');
}

/** Stop any debug session and wait for the workbench to forget it. */
export async function endSessions(): Promise<void> {
  await stopAnyDebugSession();
  vscode.debug.removeBreakpoints([...vscode.debug.breakpoints]);
}

/** The debuggee PID the SharpLsp adapter reported for `session` (DAP `process` event). */
export async function debuggeePid(session: vscode.DebugSession): Promise<number> {
  const pid = await pollUntilResult({
    fn: () => profilerStore().getDebuggeeProcessId(session.id),
    until: (found) => found !== undefined,
    timeoutMs: 30_000,
    description: 'the debuggee PID from the DAP process event',
  });
  assert.ok(pid !== undefined);
  return pid;
}

/** What a debug-launched profiler suite drives: its built debuggee and this test's DAP recorder. */
export interface DebuggeeHarness {
  readonly debuggee: () => Debuggee;
  readonly recorder: () => DapRecorder;
}

/**
 * The hooks every debug-launched profiler suite shares: build the debuggee
 * once, record DAP traffic per test, and end every session (then `cleanup`)
 * after each test.
 */
export function useDebuggee(
  prefix: string,
  cleanup: () => Promise<unknown> | undefined = () => undefined,
): DebuggeeHarness {
  let built: Debuggee | undefined;
  let recorder: DapRecorder | undefined;
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    built = await materialiseDebuggee(prefix);
  });
  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    removeDebuggee(built);
  });
  setup(() => {
    recorder = new DapRecorder();
  });
  teardown(async function () {
    this.timeout(60_000);
    await cleanup();
    await endSessions();
    recorder?.dispose();
  });
  return {
    debuggee: () => {
      assert.ok(built, 'the debuggee must be built in suiteSetup');
      return built;
    },
    recorder: () => {
      assert.ok(recorder, 'the recorder must be armed in setup');
      return recorder;
    },
  };
}
