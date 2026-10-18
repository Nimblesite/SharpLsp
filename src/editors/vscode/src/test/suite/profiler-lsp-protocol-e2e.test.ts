// Tests for [PROFILER-SHARED-LIBRARY-VSCODE] on real F# processes.
// SharpLsp contract: docs/specs/PROFILER-SPEC.md.
// Shared contract: lspkit/docs/specs/LSP-PROFILER-SPEC.md.
// Each journey cites the specific protocol, CPU, memory and UI requirements it enforces.
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import type { InitializeResult } from 'vscode-languageclient/node';
import type {
  ProfileSessionList,
  ProcessList,
} from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import { execute, executeError, lspClient, profilingSuite } from './profiler-kit';
import { CODE, raw, rawError } from './profiler-fsharp-soak-kit';
import { endProfiling, LEDGER, STOP_MS } from './profiler-fsharp-kit';

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
  'memory.start',
  'memory.snapshot',
  'memory.diff',
  'memory.references',
  'memory.objectsByType',
  'memory.gcCollect',
  'memory.stop',
  'memory.ingest',
].map((name) => `sharplsp.lspProfiler.${name}`);

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

    // ── [PROF-WIRE-METHODS] every request is advertised; progress is a server notification.
    assert.equal(
      advertised.includes('sharplsp.lspProfiler.cpu.progress'),
      false,
      '[PROF-CPU-PROGRESS] progress is not an executable client command',
    );
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

    // ── [PROF-WIRE-METHODS] top-level capabilities/processes/kill and area operations share a prefix.
    for (const commandId of COMMANDS) {
      assert.match(
        commandId,
        /^sharplsp\.lspProfiler\.[A-Za-z]+(?:\.[A-Za-z]+)?$/,
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
      ['two arguments', [{}, {}]],
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
    const extra = await rawError(cpuList, [{}, {}]);
    assert.equal(
      extra.code,
      CODE.INVALID_PARAMS,
      '[PROF-WIRE-METHODS] two valid parameter objects are rejected for their argument count',
    );
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

  test('all seventeen requests enforce their typed arguments with INVALID_PARAMS and leave the server responsive', async function () {
    this.timeout(STOP_MS * 4);
    for (const commandId of COMMANDS) {
      // [PROF-WIRE-METHODS] only these two requests have no required object fields.
      const empty = ['capabilities', 'cpu.list'].some(
        (name) => commandId === `sharplsp.lspProfiler.${name}`,
      );
      if (empty) {
        const result = await raw(commandId, [{}]);
        assert.ok(
          result !== null && typeof result === 'object',
          `${commandId} accepts its empty params object`,
        );
      } else {
        for (const args of [[{}], [{}]]) {
          const failure = await rawError(commandId, args);
          assert.equal(failure.code, CODE.INVALID_PARAMS, `${commandId} requires its typed fields`);
        }
      }
      // ── [PROF-HOST-ROUTING] the loop still serves the next request.
      const sessions = await execute<ProfileSessionList>('cpu.list', {});
      assert.ok(Array.isArray(sessions.sessions), `the loop answered after ${commandId}`);
      // ── [PROF-CPU-START] a refused call leaves nothing running.
      assert.deepEqual(sessions.sessions, [], `${commandId} created no CPU session`);
    }
    // [PROF-WIRE-METHODS] exactly one typed object, for EVERY operation.
    for (const commandId of COMMANDS) {
      for (const args of [[], [{}, {}], [42], ['not-an-object']]) {
        const failure = await rawError(commandId, args);
        assert.equal(
          failure.code,
          CODE.INVALID_PARAMS,
          `${commandId} rejects ${JSON.stringify(args)}`,
        );
      }
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
      const scopedTarget = scoped.processes.find((entry) => entry.pid === target.pid);
      assert.ok(scopedTarget, 'the F# target survives scoping');
      assert.equal(
        fsharp.in_workspace,
        false,
        'without roots the fixture is outside the workspace',
      );
      const fixtureRoot = fsharp.entry!;
      const containing = await execute<ProcessList>('processes', {
        workspace_roots: [fixtureRoot],
      });
      assert.equal(
        containing.processes.find((entry) => entry.pid === target.pid)?.in_workspace,
        true,
        '[PROF-PROCESSES-SCOPE] membership follows the supplied root, without hiding the target',
      );
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
});
