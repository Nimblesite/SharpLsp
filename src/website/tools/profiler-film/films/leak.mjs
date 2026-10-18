// Implements [WEB-DESIGN-MEDIA]. The memory-leak walkthrough the "Fix a Memory
// Leak" guide plays (`profiler-fix-memory-leak`): the C# Storefront demo's leak
// followed to the static field that roots it, the fix typed in, the fixed build
// tracked again.
//
//   node src/website/tools/profiler-film/film.mjs leak
import { memoryLoop } from '../kit/acts/memory.mjs';
import { prepare } from '../kit/scenes.mjs';
import { STOREFRONT } from '../kit/set.mjs';

const FILE = 'SessionCache.cs';

export default {
  name: 'profiler-fix-memory-leak',
  demo: STOREFRONT,
  poster: { scene: 'graph', at: 5 },
  scenes: [
    { offCamera: prepare(FILE) },
    ...memoryLoop(
      {
        file: FILE,
        type: 'Storefront.CustomerSession',
        // Each entry replaces one line of SessionCache.cs.
        fix: [
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
        ],
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
  ],
};
