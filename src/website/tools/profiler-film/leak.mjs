// Implements [WEB-DESIGN-MEDIA]. Shoots and publishes the memory-leak walkthrough
// the "Fix a Memory Leak" guide plays: a real, isolated VS Code with the packaged
// SharpLsp VSIX finds the Storefront demo's leak, follows it to the static field
// that roots it, types the fix, rebuilds, and tracks the fixed build again.
//
//   make _build-vsix VSIX_PREBUILT=1
//   node src/website/tools/profiler-film/leak.mjs              (shoot, then publish)
//   node src/website/tools/profiler-film/leak.mjs --publish    (publish the last shoot)
//
// Clips land in tools/profiler-film/out/leak/ (gitignored). Every stretch the
// published video fast-forwards carries a speed badge on screen.
import path from 'node:path';
import { out as filmOut } from './encode.mjs';
import { STOREFRONT } from './studio.mjs';
import { memoryLoop, prepare, publishWalkthrough, shootWalkthrough } from './walkthrough.mjs';

const out = path.join(filmOut, 'leak');
const FILE = 'SessionCache.cs';

/** The fix: each entry replaces one line of SessionCache.cs. */
const FIX = [
  { line: 3, text: '// Remembers the last 1,000 orders "for analytics", and forgets older ones.' },
  {
    line: 8,
    text: [
      '    public static void Remember(Order order)',
      '    {',
      '        Sessions[order.Id] = new CustomerSession(order);',
      '        Sessions.Remove(order.Id - 1_000);',
      '    }',
    ].join('\n'),
  },
];

const SCENES = [
  { offCamera: (shot) => prepare(shot, FILE) },
  ...memoryLoop(
    {
      file: FILE,
      type: 'Storefront.CustomerSession',
      fix: FIX,
      captions: {
        track: 'Track Memory on the process whose memory keeps climbing',
        grow: 'Let it run: SharpLsp snapshots the heap every 10 seconds',
        suspect: 'Suspects rank by consistent growth. Click one to jump to its code',
        graph: 'Ask what keeps it alive: SharpLsp: Show Reference Graph',
        fix: 'Fix it: keep a bounded window and evict the rest',
        retrack: 'Rebuild, run, and track memory again',
        steady: 'The heap holds steady, and no suspect climbs past Low',
      },
    },
    1,
  ),
];

if (!process.argv.includes('--publish')) await shootWalkthrough({ demo: STOREFRONT, out, scenes: SCENES });
publishWalkthrough({ name: 'profiler-fix-memory-leak', out, scenes: SCENES, posterAt: { scene: 'graph', at: 5 } });
