// Tests for [PROF-EXPORT] and [PROF-DOTNET-CPU-SYMBOLS]: real F# profile artifacts.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProfileResult } from '@nimblesite/lsp-profiler-ui';
import { comparablePath } from './test-helpers';

/** True when `file` is the fixture file named `name` (any fixture). */
export function isFile(file: string | undefined, name: string): boolean {
  return file !== undefined && path.basename(comparablePath(file)) === comparablePath(name);
}

interface Speedscope {
  shared: { frames: { name: string; file?: string; line?: number }[] };
  profiles: { samples: number[][]; weights: number[] }[];
}

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string } }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

function readJson(file: string | undefined, what: string): unknown {
  assert.ok(file !== undefined && fs.existsSync(file), `${what} is written: ${String(file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** [PROF-EXPORT]: all three artifacts exist, validate, and carry the F# function. */
export function assertArtifacts(result: ProfileResult, identifier: string, file: string): void {
  assert.equal(result.exportError, undefined, `no export error: ${result.exportError}`);
  const speedscope = readJson(result.outputFile, 'the speedscope profile') as Speedscope;
  const { frames } = speedscope.shared;
  const keysSeen = frames.map((f) => `${f.name}|${f.file ?? ''}|${f.line ?? ''}`);
  assert.equal(new Set(keysSeen).size, keysSeen.length, 'frames are deduplicated');
  assert.ok(
    frames.some((f) => f.name.includes(identifier) && isFile(f.file, file)),
    `a speedscope frame names ${identifier} in ${file}`,
  );
  assert.ok(speedscope.profiles.length > 0, 'one profile per thread');
  for (const profile of speedscope.profiles) {
    assert.equal(profile.samples.length, profile.weights.length, 'samples match weights');
    assert.ok(
      profile.weights.every((w) => Number.isFinite(w) && w >= 0),
      'weights are sane',
    );
    assert.ok(
      profile.samples.flat().every((i) => i >= 0 && i < frames.length),
      'indices in range',
    );
  }
  const v8 = readJson(result.cpuProfilePath, 'the V8 .cpuprofile') as CpuProfile;
  const ids = new Set(v8.nodes.map((n) => n.id));
  assert.equal(v8.samples.length, v8.timeDeltas.length, 'one time delta per sample');
  assert.ok(
    v8.samples.every((id) => ids.has(id)),
    'every sample names a node',
  );
  assert.ok(v8.endTime >= v8.startTime, 'time runs forward');
  assert.ok(
    v8.nodes.some((n) => n.callFrame.functionName.includes(identifier)),
    `a .cpuprofile node names ${identifier}`,
  );
  assert.ok(result.flamegraphPath !== undefined, 'a flame graph is exported');
  const svg = fs.readFileSync(result.flamegraphPath, 'utf8');
  assert.ok(
    svg.includes('<svg') && svg.includes(identifier),
    `the flame graph shows ${identifier}`,
  );
}
