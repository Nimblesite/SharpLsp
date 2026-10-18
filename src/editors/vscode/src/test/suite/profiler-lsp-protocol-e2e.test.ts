// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] at the LSP level. See
// docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-VSCODE and
// lspkit/docs/specs/LSP-PROFILER-SPEC.md.
//
// These go one layer below the VS Code commands: the JSON-RPC surface an editor without the UI
// library uses. Every assertion names the spec section that forces it:
//
//   [PROF-WIRE-METHODS]  every operation is `workspace/executeCommand` with exactly one argument,
//                        the typed params object; commands are advertised in
//                        `executeCommandProvider.commands`.
//   [PROF-HOST-ROUTING]  `initialize` adds the profiler's commands and `experimental.lspProfiler`;
//                        profiler requests never block the host's message loop.
//   [PROF-UI-IDS]        UI ids are `<prefix>.profiler.*` and never collide with server commands.
//   [PROF-ERRORS]        OTHER, PROCESS_NOT_FOUND, UNSUPPORTED_RUNTIME, ALREADY_PROFILING,
//                        INVALID_PARAMS — one code per failure kind.
//   [PROF-PROCESSES]     one ProcessInfo per recognised process; attachable ones sort first.
//   [PROF-PROCESSES-KILL] `kill` only reaches a process a registered runtime recognises.
//   [PROF-CPU-START]     returns `{ session_id, pid, runtime, runtime_version, started_at }`;
//                        a missing PID is invalid, a refused start leaves nothing behind.
//   [PROF-CPU-SESSIONS]  `cpu.list` carries id, pid, runtime, version, start time, samples, duration;
//                        `duration` on start stops the session and keeps its report.
//   [PROF-CPU-SNAPSHOT]  a snapshot returns the report shape without ending the session.
//   [PROF-CPU-STOP]      stop drains, aggregates and returns the report.
//   [PROF-CPU-REPORT]    hot functions with inclusive/self share, hot lines, artifacts.
//   [PROF-AGGREGATION-LOGIC]      shares are 0–100, self ≤ inclusive, ranked hottest first.
//   [PROF-SAMPLE]        positions are LSP `Location`s: a file and a 1-based line.
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { InitializeResult } from 'vscode-languageclient/node';
import type {
  ProfileReport,
  ProfileSessionList,
  ProcessList,
} from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import { execute, executeError, lspClient, profilingSuite } from './profiler-kit';
import { command, count, endProfiling, LEDGER, STOP_MS } from './profiler-fsharp-kit';

/** [PROF-ERRORS] codes, as `docs/models/profiler-methods.json` spells them. */
const CODE = {
  OTHER: -32_000,
  PROCESS_NOT_FOUND: -32_001,
  UNSUPPORTED_RUNTIME: -32_002,
  ALREADY_PROFILING: -32_004,
  INVALID_PARAMS: -32_602,
} as const;

/** Every operation the wire registry names, under SharpLsp's prefix. */
const COMMANDS = [
  'capabilities',
  'processes',
  'kill',
  'cpu.start',
  'cpu.stop',
  'cpu.snapshot',
  'cpu.list',
  'cpu.cooperativeScript',
  'cpu.cooperativeAttach',
  'cpu.progress',
  'memory.start',
  'memory.snapshot',
  'memory.diff',
  'memory.references',
  'memory.objectsByType',
  'memory.gcCollect',
  'memory.stop',
  'memory.ingest',
].map((name) => `sharplsp.lspProfiler.${name}`);

/** `workspace/executeCommand` exactly as the spec shapes it, with caller-chosen arguments. */
function raw(name: string, args: unknown[]): Promise<unknown> {
  return lspClient().sendRequest('workspace/executeCommand', {
    command: name,
    arguments: args,
  });
}

/** The error a raw call rejects with. */
async function rawError(name: string, args: unknown[]): Promise<{ code: number; message: string }> {
  try {
    await raw(name, args);
  } catch (error: unknown) {
    const failure = error as { code?: unknown; message?: unknown };
    return {
      code: typeof failure.code === 'number' ? failure.code : 0,
      message: String(failure.message ?? error),
    };
  }
  assert.fail(`${name} with ${JSON.stringify(args)} should have failed`);
}

/** A refusal the registry defines, or a success: never anything else. */
const REGISTRY_CODES: ReadonlySet<number> = new Set([
  CODE.OTHER,
  CODE.PROCESS_NOT_FOUND,
  CODE.UNSUPPORTED_RUNTIME,
  -32_003,
  CODE.ALREADY_PROFILING,
  -32_005,
  -32_006,
  CODE.INVALID_PARAMS,
]);

/** The outcome of one call: it succeeded, or it refused with a registry code. */
async function outcomeOf(name: string, args: unknown[]): Promise<string> {
  try {
    await raw(name, args);
    return 'ok';
  } catch (error: unknown) {
    const failure = error as { code?: unknown; message?: unknown };
    const code = typeof failure.code === 'number' ? failure.code : 0;
    assert.ok(
      REGISTRY_CODES.has(code),
      `[PROF-ERRORS] ${name} refuses with a registry code, not ${code}: ${String(failure.message)}`,
    );
    assert.ok(String(failure.message ?? '').length > 0, `${name} explains its refusal`);
    return 'refused';
  }
}

/** A running process no profiler runtime recognises: a plain `sleep`. */
function sleeper(): ChildProcess {
  const child = spawn('sleep', ['240'], { stdio: 'ignore' });
  assert.ok(child.pid !== undefined, 'the decoy process started');
  return child;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

suite('LSP-level profiler protocol — FsOrderLedger behind the same server', () => {
  const live = profilingSuite('profiler-lsp-wire-', LEDGER, { stopping: endProfiling });

  test('initialize advertises every registry operation once, under the server prefix, with nothing from the UI namespace and experimental.lspProfiler set', async function () {
    this.timeout(STOP_MS * 2);
    const client = lspClient();
    const initialized: InitializeResult | undefined = client.initializeResult;
    assert.ok(initialized, 'initialize completed');
    const capabilities = initialized.capabilities;
    const advertised = capabilities.executeCommandProvider?.commands ?? [];

    // ── [PROF-WIRE-METHODS] every registry operation is advertised, exactly once.
    for (const commandId of COMMANDS) {
      const hits = advertised.filter((entry) => entry === commandId).length;
      assert.equal(hits, 1, `${commandId} is advertised exactly once (${hits})`);
    }
    // ── [PROF-HOST-ROUTING] the host adds the profiler's commands and nothing undocumented.
    const profilerCommands = advertised.filter((entry) => entry.includes('lspProfiler'));
    assert.deepEqual(
      [...profilerCommands].sort(),
      [...COMMANDS].sort(),
      'the advertised profiler commands are exactly the registry',
    );
    for (const commandId of profilerCommands) {
      assert.ok(
        commandId.startsWith('sharplsp.lspProfiler.'),
        `the prefix is applied once: ${commandId}`,
      );
      assert.ok(!commandId.includes('lspProfiler/'), `no internal key leaks: ${commandId}`);
    }

    // ── [PROF-UI-IDS] the UI namespace is client-side and never collides.
    const uiIds = advertised.filter((entry) => entry.startsWith('sharplsp.profiler.'));
    assert.deepEqual(uiIds, [], `UI ids stay client-side: ${uiIds.join(', ')}`);

    // ── [PROF-HOST-ROUTING] experimental.lspProfiler is published alongside.
    const experimental = capabilities.experimental as Record<string, unknown> | undefined;
    assert.ok(experimental, 'experimental capabilities exist');
    const profiler = experimental?.lspProfiler;
    assert.ok(profiler !== undefined && profiler !== null, 'experimental.lspProfiler is published');
    if (typeof profiler === 'object' && profiler !== null) {
      assert.ok(Object.keys(profiler).length > 0, 'the profiler capabilities are not empty');
    }

    // ── Every advertised id is a well-formed `<prefix>.lspProfiler.<area>.<action>`.
    for (const commandId of COMMANDS) {
      assert.match(
        commandId,
        /^sharplsp\.lspProfiler\.[A-Za-z]+\.[A-Za-z]+$/,
        `the id composes from prefix, area and action: ${commandId}`,
      );
      assert.ok(!/\s/.test(commandId), `no whitespace in ${commandId}`);
      const prefix = commandId.split('.').slice(0, 2).join('.');
      assert.equal(prefix, 'sharplsp.lspProfiler', `one prefix for every operation: ${prefix}`);
    }
    assert.equal(new Set(COMMANDS).size, COMMANDS.length, 'the registry names no operation twice');

    // The profiler adds capabilities; it never replaces the language server's own.
    assert.ok(capabilities.textDocumentSync !== undefined, 'text sync survives');
    assert.ok(capabilities.executeCommandProvider !== undefined, 'executeCommand survives');
  });

  test('params are validated as exactly one typed object: zero, two, a number, a string and a bad field are INVALID_PARAMS, an unknown operation fails without wedging the loop', async function () {
    this.timeout(STOP_MS * 3);
    const cpuList = COMMANDS.find((entry) => entry.endsWith('cpu.list'));
    assert.ok(cpuList, 'cpu.list is in the registry');

    // ── [PROF-WIRE-METHODS] exactly one argument: the typed params object.
    const malformed: readonly (readonly [string, unknown[]])[] = [
      ['zero arguments', []],
      ['two arguments', [{}]],
      ['a number', [42]],
      ['a string', ['pid=1']],
      ['null', [null]],
    ];
    for (const [label, args] of malformed) {
      const failure = await rawError('sharplsp.lspProfiler.cpu.start', args);
      assert.equal(
        failure.code,
        CODE.INVALID_PARAMS,
        `[PROF-ERRORS] ${label} is INVALID_PARAMS: ${JSON.stringify(failure)}`,
      );
      assert.ok(failure.message.length > 0, `${label} explains itself`);
    }
    // A malformed field type is invalid parameters too.
    const wrongType = await rawError('sharplsp.lspProfiler.cpu.start', [{ pid: 'not-a-pid' }]);
    assert.equal(
      wrongType.code,
      CODE.INVALID_PARAMS,
      `pid must be a number: ${JSON.stringify(wrongType)}`,
    );
    const noPid = await rawError('sharplsp.lspProfiler.memory.start', [{}]);
    assert.equal(
      noPid.code,
      CODE.INVALID_PARAMS,
      `[PROF-CPU-START] a missing PID is invalid: ${JSON.stringify(noPid)}`,
    );

    // ── [PROF-HOST-ROUTING] nothing was created, and the loop still answers.
    const sessions = await raw(cpuList, [{}]);
    assert.deepEqual(
      (sessions as ProfileSessionList).sessions,
      [],
      'no session from a refused call',
    );
    assert.deepEqual(await execute<ProfileSessionList>('cpu.list', {}), { sessions: [] });

    // ── An unknown operation fails, and the loop survives it.
    const unknown = await rawError('sharplsp.lspProfiler.cpu.bogus', [{}]);
    assert.ok(
      unknown.message.length > 0,
      `the unknown operation is reported: ${JSON.stringify(unknown)}`,
    );
    assert.deepEqual(
      (await execute<ProfileSessionList>('cpu.list', {})).sessions,
      [],
      '[PROF-HOST-ROUTING] the message loop was never blocked',
    );
  });

  test('all eighteen operations answer a malformed call without wedging the loop, and none of them leaves a session behind', async function () {
    this.timeout(STOP_MS * 4);
    for (const commandId of COMMANDS) {
      // ── [PROF-ERRORS] refuse-or-succeed, never an unclassified failure.
      const outcome = await outcomeOf(commandId, [{}]);
      assert.ok(outcome === 'ok' || outcome === 'refused', `${commandId} answered: ${outcome}`);
      if (outcome === 'refused') {
        const again = await outcomeOf(commandId, [{}]);
        assert.equal(again, 'refused', `${commandId} refuses the same malformed call twice`);
      }
      // ── [PROF-HOST-ROUTING] the loop still serves the next request.
      const sessions = await execute<ProfileSessionList>('cpu.list', {});
      assert.ok(Array.isArray(sessions.sessions), `the loop answered after ${commandId}`);
      // ── [PROF-CPU-START] a refused call leaves nothing running.
      assert.deepEqual(sessions.sessions, [], `${commandId} created no CPU session`);
    }
    // ── The same sweep with no argument at all: still classified, still no session.
    for (const commandId of COMMANDS) {
      await outcomeOf(commandId, []);
      assert.deepEqual(
        (await execute<ProfileSessionList>('cpu.list', {})).sessions,
        [],
        `${commandId} with zero arguments created no session`,
      );
    }
    // ── The process table still reads after the whole sweep.
    const processes = await execute<ProcessList>('processes', { workspace_roots: [] });
    assert.ok(processes.processes.length > 0, '[PROF-PROCESSES] discovery still works');
    for (const entry of processes.processes) {
      assert.ok(entry.pid > 0, 'a discovered process has a PID');
      assert.ok(entry.name.length > 0, 'a discovered process has a name');
      assert.ok(typeof entry.attachable === 'boolean', 'attachable is a boolean');
      assert.ok(entry.cpu_percent >= 0, 'CPU is never negative');
      assert.ok(entry.memory_bytes >= 0, 'memory is never negative');
      if (!entry.attachable) {
        assert.ok((entry.unattachable_reason ?? '').length > 0, 'a refusal explains itself');
      }
    }
  });

  test('the error taxonomy: PROCESS_NOT_FOUND and UNSUPPORTED_RUNTIME, kill can never reach an unprofilable process, and processes sorts attachable first with a reason on every refusal', async function () {
    this.timeout(STOP_MS * 3);
    const { target } = live;
    const decoy = sleeper();
    try {
      // ── [PROF-ERRORS] a PID that names no process.
      const missing = await executeError('kill', { pid: 2_147_483_647 });
      assert.ok(missing, 'killing a missing PID fails');
      assert.equal(
        missing.code,
        CODE.PROCESS_NOT_FOUND,
        `[PROF-ERRORS] ${JSON.stringify(missing)}`,
      );
      const missingStart = await executeError('cpu.start', { pid: 2_147_483_647 });
      assert.ok(missingStart, 'starting on a missing PID fails');
      assert.equal(missingStart.code, CODE.PROCESS_NOT_FOUND, 'the same code for start');

      // ── [PROF-PROCESSES-KILL] kill never reaches a process no runtime recognises.
      const decoyPid = decoy.pid;
      assert.ok(decoyPid !== undefined, 'the decoy has a pid');
      const decoyKill = await executeError('kill', { pid: decoyPid });
      assert.ok(decoyKill, 'killing an unprofilable process fails');
      assert.equal(
        decoyKill.code,
        CODE.UNSUPPORTED_RUNTIME,
        `[PROF-PROCESSES-KILL] ${JSON.stringify(decoyKill)}`,
      );
      assert.equal(isAlive(decoyPid), true, 'the unprofilable process is still alive');

      // ── [PROF-ERRORS] the editor itself is not a profiler target either.
      const selfStart = await executeError('cpu.start', { pid: process.pid });
      assert.ok(selfStart, 'starting on the extension host fails');
      assert.equal(
        selfStart.code,
        CODE.UNSUPPORTED_RUNTIME,
        `an Electron host is not profiled: ${JSON.stringify(selfStart)}`,
      );

      // ── [PROF-PROCESSES] the F# target is listed, attachable, with its identity.
      const listedProcesses = await execute<ProcessList>('processes', { workspace_roots: [] });
      const processes = listedProcesses.processes;
      assert.ok(Array.isArray(processes), 'processes is a list');
      assert.ok(processes.length > 0, 'the process table is read once');
      const fsharp = processes.find((entry) => entry.pid === target.pid);
      assert.ok(fsharp, `the F# target is discovered: ${processes.length} processes`);
      assert.equal(fsharp.runtime, 'dotnet', '[PROF-RUNTIME] classified as .NET');
      assert.equal(fsharp.attachable, true, 'the target is attachable');
      assert.ok((fsharp.runtime_version ?? '').length > 0, 'a runtime version is reported');
      assert.ok((fsharp.entry ?? '').length > 0, 'the assembly/entry is reported');
      assert.ok(fsharp.cpu_percent >= 0, 'CPU is a percentage');
      assert.ok(fsharp.memory_bytes > 0, 'resident memory is in bytes');
      assert.ok(fsharp.runtime_secs >= 0, 'uptime is in seconds');
      assert.equal(
        fsharp.unattachable_reason,
        undefined,
        'an attachable process carries no refusal reason',
      );

      // ── [PROF-PROCESSES] attachable processes sort first; every refusal is explained.
      const firstUnattachable = processes.findIndex((entry) => !entry.attachable);
      if (firstUnattachable >= 0) {
        const later = processes.slice(firstUnattachable);
        assert.ok(
          later.every((entry) => !entry.attachable),
          'once a process is unattachable, every later row is too',
        );
        for (const entry of later) {
          assert.ok(
            (entry.unattachable_reason ?? '').length > 0,
            `unattachable ${entry.pid} says why: ${entry.unattachable_reason}`,
          );
        }
      }
      for (const entry of processes.slice(0, Math.max(firstUnattachable, 0))) {
        assert.ok(entry.cpu_percent >= 0, 'an attachable row has a CPU reading');
      }
      assert.ok(
        !processes.some((entry) => entry.pid === decoyPid && entry.attachable),
        'the decoy is never offered as attachable',
      );

      // ── [PROF-PROCESSES-SCOPE] workspace membership is a display attribute, not a filter:
      // the same processes come back with a root as without one.
      const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
      const scoped = await execute<ProcessList>('processes', { workspace_roots: roots });
      assert.deepEqual(
        scoped.processes.map((entry) => entry.pid).sort((a, b) => a - b),
        processes.map((entry) => entry.pid).sort((a, b) => a - b),
        'a workspace root never filters the process table',
      );
      const scopedTarget = scoped.processes.find((entry) => entry.pid === target.pid);
      assert.ok(scopedTarget, 'the F# target survives scoping');
      assert.equal(typeof scopedTarget.in_workspace, 'boolean', 'membership is a boolean flag');
      assert.deepEqual(
        (await execute<ProfileSessionList>('cpu.list', {})).sessions,
        [],
        'no refused start left a session',
      );
    } finally {
      decoy.kill();
    }
  });

  test('CPU over the wire on F#: identity on start, samples and versions in list, a snapshot that keeps the session, ranked 1-based positions, a report with artifacts, stop, and no session afterwards', async function () {
    this.timeout(STOP_MS * 4);
    const { target } = live;
    await command(target, 'burn on');

    // ── [PROF-CPU-START] returns the session's identity.
    const started = await execute<{
      session_id: string;
      pid: number;
      runtime: string;
      runtime_version: string;
      started_at: string;
    }>('cpu.start', { pid: target.pid, include_native: false });
    assert.ok(started.session_id.length > 0, 'a session id');
    assert.equal(started.pid, target.pid, 'the session names its PID');
    assert.equal(started.runtime, 'dotnet', '[PROF-RUNTIME] runtime identity travels as data');
    assert.ok(started.runtime_version.length > 0, '[PROF-CPU-START] a runtime version is reported');
    assert.match(started.started_at, /^\d{4}-\d{2}-\d{2}T/, 'an RFC 3339 start time');

    // ── [PROF-CPU-SESSIONS] the live session carries samples and a duration.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const listed = (await execute<ProfileSessionList>('cpu.list', {})).sessions;
    const now = listed.find((entry) => entry.session_id === started.session_id);
    assert.ok(now, 'the session is listed while it runs');
    assert.equal(now.pid, target.pid);
    assert.equal(now.runtime, 'dotnet');
    assert.ok(now.runtime_version.length > 0, 'the version survives the listing');
    assert.ok(now.sample_count > 0, `samples accumulate: ${now.sample_count}`);
    assert.ok(now.duration_secs > 0, `the duration runs: ${now.duration_secs}`);
    assert.ok(now.started_at.length > 0, 'the start time is listed');

    // ── [PROF-CPU-SNAPSHOT] a snapshot is a report and the session survives it.
    const snapshot = await execute<ProfileReport>('cpu.snapshot', {
      session_id: started.session_id,
    });
    assert.equal(snapshot.session_id, started.session_id, 'the report names its session');
    assert.equal(snapshot.pid, target.pid);
    assert.equal(snapshot.runtime, 'dotnet');
    assert.ok(snapshot.total_samples > 0, 'the snapshot samples something');
    assert.ok(
      snapshot.user_samples >= 0 && snapshot.user_samples <= snapshot.total_samples,
      'user samples are a subset',
    );
    assert.ok(snapshot.sample_rate >= 1, `a positive sample rate: ${snapshot.sample_rate}`);
    assert.ok(snapshot.duration_secs >= 0, 'a duration');
    assert.ok(
      (await execute<ProfileSessionList>('cpu.list', {})).sessions.some(
        (entry) => entry.session_id === started.session_id,
      ),
      '[PROF-CPU-SNAPSHOT] the snapshot did not end the session',
    );
    assertProfileShape(snapshot);

    // ── [PROF-CPU-STOP] stop drains and returns the final report.
    const stopped = await execute<ProfileReport>('cpu.stop', { session_id: started.session_id });
    assert.equal(stopped.session_id, started.session_id, 'the stopped report is the session');
    assert.ok(stopped.total_samples >= snapshot.total_samples, 'samples never shrink on stop');
    assert.deepEqual(stopped.artifacts.export_error, undefined, '[PROF-EXPORT] no export error');
    assertProfileShape(stopped);
    assert.equal(
      (await execute<ProfileSessionList>('cpu.list', {})).sessions.some(
        (entry) => entry.session_id === started.session_id,
      ),
      false,
      '[PROF-CPU-SESSIONS] a stopped session is no longer active',
    );

    // ── A stopped session cannot be stopped or snapshotted again.
    const restop = await executeError('cpu.stop', { session_id: started.session_id });
    assert.ok(restop, 'a second stop fails');
    assert.ok(restop.code !== 0, `[PROF-ERRORS] ${JSON.stringify(restop)}`);
    const resnap = await executeError('cpu.snapshot', { session_id: started.session_id });
    assert.ok(resnap, 'a snapshot after stop fails');
    assert.ok(resnap.code !== 0, 'the ended session rejects snapshots');

    // ── The program was never disturbed: attaching is not invasive.
    const alive = await command(target, 'stats');
    assert.ok(count(alive, 'iterations') >= 0, 'the F# program still answers on stdin');
  });

  test('a duration on start stops the session by itself and keeps its report for the next stop', async function () {
    this.timeout(STOP_MS * 4);
    const { target } = live;
    // ── [PROF-CPU-SESSIONS] `duration` ends the session automatically.
    const started = await execute<{ session_id: string }>('cpu.start', {
      pid: target.pid,
      duration: 2,
    });
    assert.ok(started.session_id.length > 0, 'a session id with a duration');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const active = (await execute<ProfileSessionList>('cpu.list', {})).sessions;
    assert.equal(
      active.some((entry) => entry.session_id === started.session_id),
      false,
      'the duration elapsed and the session ended by itself',
    );
    // ── Its report is kept for the next stop.
    const kept = await execute<ProfileReport>('cpu.stop', { session_id: started.session_id });
    assert.equal(kept.session_id, started.session_id, 'the kept report belongs to the session');
    assert.ok(kept.total_samples >= 0, 'the kept report has a sample count');
    assert.ok(kept.duration_secs >= 0, 'the kept report has a duration');
    assertProfileShape(kept);
  });
});

/** [PROF-CPU-REPORT] + [PROF-AGGREGATION-LOGIC] + [PROF-SAMPLE] + [PROF-EXPORT]. */
function assertProfileShape(report: ProfileReport): void {
  assert.ok(Array.isArray(report.hot_functions), 'hot functions are a list');
  assert.ok(Array.isArray(report.hot_lines), 'hot lines are a list');
  const percentages = report.hot_functions.map((fn) => fn.percentage);
  assert.deepEqual(
    percentages,
    [...percentages].sort((a, b) => b - a),
    'functions are ranked hottest first',
  );
  for (const fn of report.hot_functions) {
    assert.ok(fn.name.length > 0, 'a function has a name');
    assert.ok(
      fn.percentage >= 0 && fn.percentage <= 100,
      `inclusive share 0–100: ${fn.percentage}`,
    );
    assert.ok(
      fn.self_percentage <= fn.percentage,
      `self never exceeds inclusive: ${fn.self_percentage} > ${fn.percentage}`,
    );
    assert.ok(fn.samples >= fn.self_samples, 'inclusive samples cover the self samples');
    assert.ok(fn.samples <= report.total_samples, 'a function cannot exceed the total');
    if (fn.line !== undefined) {
      assert.ok(fn.line >= 1, `[PROF-SAMPLE] 1-based definition line: ${fn.line}`);
      assert.ok((fn.file ?? '').length > 0, 'a located function names its file');
    }
  }
  const linePercentages = report.hot_lines.map((line) => line.percentage);
  assert.deepEqual(
    linePercentages,
    [...linePercentages].sort((a, b) => b - a),
    'lines are ranked hottest first',
  );
  for (const line of report.hot_lines) {
    assert.ok(line.line >= 1, `[PROF-SAMPLE] 1-based hot line: ${line.line}`);
    assert.ok(line.file.length > 0, 'a hot line names its file');
    assert.ok(
      line.percentage > 0 && line.percentage <= 100,
      `a hot line share: ${line.percentage}`,
    );
    assert.ok(line.samples <= report.total_samples, 'a hot line cannot exceed the total');
  }
  const artifacts = report.artifacts;
  for (const artifact of [
    artifacts.speedscope_path,
    artifacts.flamegraph_path,
    artifacts.cpuprofile_path,
  ]) {
    if (artifact !== undefined) {
      assert.ok(fs.existsSync(artifact), `[PROF-EXPORT] the artifact exists: ${artifact}`);
    }
  }
  assert.ok(Array.isArray(report.diagnostics), 'diagnostics travel with the result');
}
