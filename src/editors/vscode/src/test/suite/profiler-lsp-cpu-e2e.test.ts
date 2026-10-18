// Tests for [PROFILER-SHARED-LIBRARY-VSCODE], [PROF-CPU-SESSIONS], [PROF-CPU-SNAPSHOT]
// and [PROF-CPU-STOP] over the real F# LSP: one CPU session's whole life on the wire.
import * as assert from 'node:assert/strict';
import type {
  ProfileReport,
  ProfileSessionList,
} from '@nimblesite/lsp-profiler-ui/out/src/wire-generated';
import { execute, executeError, profilingSuite } from './profiler-kit';
import { pollUntilResult } from './profiler-ui-helpers';
import { assertProfileShape } from './profiler-fsharp-soak-kit';
import {
  command,
  count,
  endProfiling,
  isFile,
  LEDGER,
  PRICE_ALL,
  STOP_MS,
  within,
} from './profiler-fsharp-kit';

suite('LSP-level F# CPU protocol — FsOrderLedger', () => {
  const live = profilingSuite('profiler-lsp-cpu-', LEDGER, { stopping: endProfiling });

  test('CPU over the wire on F#: identity on start, samples and versions in list, a snapshot that keeps the session, ranked 1-based positions, a report with artifacts, stop, and no session afterwards', async function () {
    this.timeout(STOP_MS * 4);
    const { target } = live;
    const seeded = await command(target, 'place 1000');
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
    assert.ok(
      stopped.hot_functions.some(
        (fn) => fn.name.includes('priceAll') && isFile(fn.file, 'Ledger.fs'),
      ),
      '[PROF-TESTING] the burning F# function is named in its own source file',
    );
    assert.ok(
      stopped.hot_lines.some((line) => within(PRICE_ALL, line.file, line.line)),
      '[PROF-DOTNET-CPU-SYMBOLS] the report samples inside the F# burn loop',
    );
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
    const alive = await command(target, 'place 1');
    assert.equal(
      count(alive, 'orders'),
      count(seeded, 'orders') + 1,
      'the F# program still accepts and retains work after profiling',
    );
    await command(target, 'burn off');
  });

  test('a duration on start stops the session by itself and keeps its report for the next stop', async function () {
    this.timeout(STOP_MS * 4);
    const { target } = live;
    await command(target, 'burn on');
    // ── [PROF-CPU-SESSIONS] `duration` ends the session automatically.
    const started = await execute<{ session_id: string }>('cpu.start', {
      pid: target.pid,
      duration_secs: 2,
    });
    assert.ok(started.session_id.length > 0, 'a session id with a duration');
    const active = await pollUntilResult({
      fn: async () => (await execute<ProfileSessionList>('cpu.list', {})).sessions,
      until: (sessions) => !sessions.some((entry) => entry.session_id === started.session_id),
      timeoutMs: STOP_MS,
      description: '[PROF-CPU-SESSIONS] the timed session ends and drains its recorded segments',
    });
    assert.equal(
      active.some((entry) => entry.session_id === started.session_id),
      false,
      'the duration elapsed and the session ended by itself',
    );
    // ── Its report is kept for the next stop.
    const kept = await execute<ProfileReport>('cpu.stop', { session_id: started.session_id });
    assert.equal(kept.session_id, started.session_id, 'the kept report belongs to the session');
    assert.ok(kept.total_samples > 0, 'the timed session sampled the running F# workload');
    assert.equal(kept.duration_secs, 2, 'the report records exactly the requested two seconds');
    assertProfileShape(kept);
    assert.ok(
      kept.hot_lines.some((line) => within(PRICE_ALL, line.file, line.line)),
      'the timed report contains the F# workload, not just runtime frames',
    );
    await command(target, 'burn off');
  });
});
