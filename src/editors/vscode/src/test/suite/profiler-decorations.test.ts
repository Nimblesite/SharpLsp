// Tests for [PROFILER-SHARED-LIBRARY-VSCODE]: Basilisk's profiler-decorations
// suite on SharpLsp's live extension.
//
// The heat map and the memory track as painted on a real C# editor, read back
// through the libraries' applied-decoration ledgers. Basilisk asserted its
// heat-level boundaries on literal numbers it never classified; here every
// level is the colour the real classifier painted.
import * as assert from 'node:assert/strict';
import {
  appliedProfileDecorations,
  applyProfileDecorations,
  clearProfileDecorations,
  type ProfileHotLine,
} from '@nimblesite/lsp-profiler-ui/out/src/profiler-decorations';
import {
  appliedMemoryDecorations,
  applyMemoryDecorations,
  clearMemoryDecorations,
} from '@nimblesite/lsp-profiler-ui/out/src/memory-decorations';
import {
  DECORATED_SOURCE,
  memorySnapshot,
  openSourceFile,
  profileResult,
  useLspSuite,
} from './profiler-ui-helpers';

/** The heat palette, hottest first ([PROF-UI-HEATMAP]). */
const HEAT = { critical: '#e8500a', hot: '#f97316', warm: '#fbbf24', cool: '#4a5468' } as const;
type Heat = keyof typeof HEAT | 'none';

function clearDecorations(): void {
  clearProfileDecorations();
  clearMemoryDecorations();
}

/** The open decorated source of the current suite. */
let file = '';

function useDecoratedEditor(prefix: string): void {
  const tmpDir = useLspSuite(prefix, clearDecorations);
  setup(async () => {
    file = (await openSourceFile(tmpDir(), 'Hot.cs', DECORATED_SOURCE)).uri.fsPath;
  });
}

/** Paint one hot line per percentage (line n carries the n-th) and read back each level. */
function levelsOf(percentages: readonly number[]): Heat[] {
  const hotLines: ProfileHotLine[] = percentages.map((percentage, index) => ({
    file,
    line: index + 1,
    samples: Math.round(percentage * 10),
    percentage,
  }));
  applyProfileDecorations(profileResult({ hotLines }));
  const byLine = new Map(appliedProfileDecorations().map((entry) => [entry.line, entry.color]));
  return percentages.map((_, index) => {
    const color = byLine.get(index + 1);
    const level = (Object.keys(HEAT) as (keyof typeof HEAT)[]).find((key) => HEAT[key] === color);
    return level ?? 'none';
  });
}

function assertLevels(percentages: readonly number[], expected: readonly Heat[]): void {
  assert.deepEqual(
    levelsOf(percentages),
    expected,
    `${percentages.join('% / ')}% must paint ${expected.join(' / ')}`,
  );
}

/** Paint one hot line of the open source. */
function paintHotLine(line: number, percentage: number, samples: number): void {
  applyProfileDecorations(profileResult({ hotLines: [{ file, line, samples, percentage }] }));
}

/** Paint one allocation of the open source. */
function paintAllocation(line: number, size: number, count: number): void {
  applyMemoryDecorations(memorySnapshot({ topAllocations: [{ file, line, size, count }] }));
}

/** One test per row: its name, the percentages painted, and the levels they must get. */
function levelTests(
  rows: readonly (readonly [string, readonly number[], readonly Heat[]])[],
): void {
  for (const [name, percentages, expected] of rows) {
    test(name, () => {
      assertLevels(percentages, expected);
    });
  }
}

suite('Profiler — Decoration Modules', () => {
  useDecoratedEditor('profiler-dec-');

  test('profiler-decorations exports applyProfileDecorations function', () => {
    paintHotLine(2, 30, 5);
    assert.deepEqual(
      appliedProfileDecorations().map((entry) => entry.line),
      [2],
      'it paints',
    );
  });

  test('profiler-decorations exports clearProfileDecorations function', () => {
    paintHotLine(2, 30, 5);
    clearProfileDecorations();
    assert.deepEqual(appliedProfileDecorations(), [], 'it clears');
  });

  test('memory-decorations exports applyMemoryDecorations function', () => {
    paintAllocation(3, 4096, 8);
    assert.deepEqual(
      appliedMemoryDecorations().map((entry) => entry.line),
      [3],
      'it paints',
    );
  });

  test('memory-decorations exports clearMemoryDecorations function', () => {
    paintAllocation(3, 4096, 8);
    clearMemoryDecorations();
    assert.deepEqual(appliedMemoryDecorations(), [], 'it clears');
  });

  test('clearProfileDecorations does not throw when no decorations exist', () => {
    clearProfileDecorations();
    clearProfileDecorations();
    assert.deepEqual(appliedProfileDecorations(), []);
  });

  test('clearMemoryDecorations does not throw when no decorations exist', () => {
    clearMemoryDecorations();
    clearMemoryDecorations();
    assert.deepEqual(appliedMemoryDecorations(), []);
  });

  test('ProfileResult type has required fields', () => {
    applyProfileDecorations(
      profileResult({
        totalSamples: 1000,
        hotFunctions: [
          { name: 'Process', file, line: 4, samples: 800, percentage: 40, selfPercentage: 30 },
        ],
        hotLines: [{ file, line: 6, samples: 500, percentage: 25 }],
      }),
    );
    assert.deepEqual(
      appliedProfileDecorations()
        .map((entry) => entry.line)
        .sort((a, b) => a - b),
      [4, 6],
      'both the hot function and the hot line of the result are painted',
    );
  });

  test('ProfileHotLine type has required fields', () => {
    paintHotLine(5, 25, 500);
    const [painted] = appliedProfileDecorations();
    assert.equal(painted?.line, 5);
    assert.ok(painted.contentText.includes('25.0% (500 samples)'), painted.contentText);
  });

  test('ProfileHotFunction type has required fields', () => {
    applyProfileDecorations(
      profileResult({
        hotFunctions: [
          { name: 'ProcessData', file, line: 8, samples: 800, percentage: 40, selfPercentage: 30 },
        ],
      }),
    );
    const [painted] = appliedProfileDecorations();
    assert.equal(painted?.line, 8);
    assert.ok(
      painted.contentText.includes('ProcessData — 40.0% CPU (30.0% self)'),
      painted.contentText,
    );
  });

  test('MemoryAllocation type has required fields', () => {
    applyMemoryDecorations(
      memorySnapshot({ topAllocations: [{ file, line: 9, size: 10_485_760, count: 5000 }] }),
    );
    const [painted] = appliedMemoryDecorations();
    assert.equal(painted?.line, 9);
    assert.ok(
      painted.contentText.includes('10.0 MB allocated (5000 objects)'),
      painted.contentText,
    );
  });

  test('MemorySnapshotResult type has required fields', () => {
    applyMemoryDecorations(
      memorySnapshot({
        topAllocations: [
          { file, line: 1, size: 104_857_600, count: 1 },
          { file, line: 2, size: 512, count: 1 },
        ],
      }),
    );
    assert.deepEqual(
      appliedMemoryDecorations()
        .map((entry) => entry.color)
        .sort(),
      ['#7c3aed', '#c084fc'],
      'every allocation of the snapshot is painted, coloured by size',
    );
  });
});

suite('Profiler — Decoration Apply/Clear', () => {
  useDecoratedEditor('profiler-dec2-');

  test('applyProfileDecorations handles empty result without throwing', () => {
    applyProfileDecorations(profileResult({ totalSamples: 0, duration: 0 }));
    assert.deepEqual(appliedProfileDecorations(), [], 'an empty profile paints nothing');
  });

  test('applyMemoryDecorations handles empty result without throwing', () => {
    applyMemoryDecorations(memorySnapshot({ currentMemory: 0, peakMemory: 0 }));
    assert.deepEqual(appliedMemoryDecorations(), [], 'an empty snapshot paints nothing');
  });

  test('ProfileResult with populated hotFunctions validates structure', () => {
    applyProfileDecorations(
      profileResult({
        hotFunctions: [
          { name: 'Compute', file, line: 10, samples: 2500, percentage: 50, selfPercentage: 35 },
          { name: 'Transform', file, line: 11, samples: 1000, percentage: 20, selfPercentage: 15 },
        ],
        hotLines: [{ file, line: 12, samples: 2000, percentage: 40 }],
      }),
    );
    const painted = new Map(
      appliedProfileDecorations().map((entry) => [entry.line, entry.contentText]),
    );
    assert.ok(painted.get(10)?.includes('Compute — 50.0% CPU (35.0% self)'));
    assert.ok(painted.get(11)?.includes('Transform — 20.0% CPU (15.0% self)'));
    assert.ok(painted.get(12)?.includes('40.0% (2000 samples)'));
  });
});

suite('Profiler — Heat Level Classification', () => {
  useDecoratedEditor('profiler-heat-');

  levelTests([
    ['critical heat level classification (>= 20%)', [25, 20], ['critical', 'critical']],
    ['hot heat level classification (10-20%)', [15, 10], ['hot', 'hot']],
    ['warm heat level classification (5-10%)', [7, 5], ['warm', 'warm']],
    ['cool heat level classification (1-5%)', [3, 1], ['cool', 'cool']],
    ['below threshold (< 1%) is not classified', [0.5], ['none']],
  ]);

  test('heat level boundaries are mutually exclusive', () => {
    assertLevels(
      [25, 20, 19.9, 10, 9.9, 5, 4.9, 1, 0.9],
      ['critical', 'critical', 'hot', 'hot', 'warm', 'warm', 'cool', 'cool', 'none'],
    );
  });
});

suite('Profiler — Decoration Contracts', () => {
  useDecoratedEditor('profiler-deco-');

  test('applyProfileDecorations with multiple files and varying percentages', () => {
    applyProfileDecorations(
      profileResult({
        hotFunctions: [
          {
            name: 'HotFunc',
            file: '/nonexistent/A.cs',
            line: 1,
            samples: 1500,
            percentage: 50,
            selfPercentage: 40,
          },
          { name: 'Here', file, line: 2, samples: 300, percentage: 10, selfPercentage: 8 },
        ],
        hotLines: [
          { file: '/nonexistent/B.cs', line: 12, samples: 200, percentage: 6.7 },
          { file, line: 3, samples: 30, percentage: 1 },
        ],
      }),
    );
    assert.deepEqual(
      appliedProfileDecorations()
        .map((entry) => [entry.line, entry.color])
        .sort(),
      [
        [2, HEAT.hot],
        [3, HEAT.cool],
      ],
      'only the open file is painted, each line at its own level',
    );
  });

  levelTests([
    ['heat level classification boundary at exactly 1%', [1, 0.99], ['cool', 'none']],
    ['heat level classification boundary at exactly 5%', [5, 4.99], ['warm', 'cool']],
    ['heat level classification boundary at exactly 10%', [10, 9.99], ['hot', 'warm']],
    ['heat level classification boundary at exactly 20%', [20, 19.99], ['critical', 'hot']],
  ]);
});

suite('Profiler — Decoration Lifecycle', () => {
  useDecoratedEditor('profiler-deco2-');

  test('clearProfileDecorations removes all decorations without error', () => {
    paintHotLine(1, 50, 50);
    assert.equal(appliedProfileDecorations().length, 1, 'painted before the clear');
    clearProfileDecorations();
    clearProfileDecorations();
    assert.deepEqual(appliedProfileDecorations(), [], 'a double clear leaves nothing');
  });

  test('decorations apply after opening file and survive re-application', () => {
    const result = profileResult({ hotLines: [{ file, line: 2, samples: 250, percentage: 50 }] });
    applyProfileDecorations(result);
    clearProfileDecorations();
    applyProfileDecorations(result);
    applyProfileDecorations(result);
    assert.deepEqual(
      appliedProfileDecorations().map((entry) => entry.line),
      [2],
      're-application replaces rather than stacks',
    );
  });
});
