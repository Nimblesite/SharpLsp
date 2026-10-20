// Implements [WEB-DESIGN-MEDIA]. The F# walkthrough the profiler docs play
// (`profiler-fsharp`): FsStorefront's CPU down to its F# lines and pipeline
// stages, then its memory: records and union cases painted where the code
// builds them, the module value that roots the leak, the fix, and a second run.
//
//   node src/website/tools/video/film.mjs fsharp
import { snap } from '../../kit/camera.mjs';
import { profilerTour } from '../../kit/acts/tour.mjs';
import { FS_STOREFRONT } from '../../kit/set.mjs';

const CHECKOUT = 'Checkout.fs';
const SESSIONS = 'Sessions.fs';

export default {
  name: 'profiler-fsharp',
  demo: FS_STOREFRONT,
  narration: 'narration.json',
  poster: { scene: 'suspect', at: 6 },
  scenes: profilerTour(
    {
      file: CHECKOUT,
      stills: 'profiler-fsharp',
      captions: {
        profile: 'Profile CPU on a running F# app',
        heat: 'Stop: every hot F# line gets its share of the samples',
        results: 'Hot functions keep their F# names, down to each pipeline stage',
      },
    },
    {
      file: SESSIONS,
      type: 'FsStorefront.CustomerSession',
      // A bounded window: the comment line is replaced; the eviction follows the store.
      fix: [
        { line: 5, text: '// Remembers the last 1,000 orders "for analytics", and forgets older ones.' },
        { line: 10, append: true, text: '\n    sessions.Remove(order.Id - 1_000) |> ignore' },
      ],
      captions: {
        track: 'Track Memory on the same app',
        grow: 'Let it run: SharpLsp snapshots the heap every 10 seconds',
        suspect: 'Records and union cases rank by growth. Click one to jump to the line that builds it',
        graph: 'Ask what keeps it alive: SharpLsp: Show Reference Graph',
        rooted: 'The root is the module value sessions, named as in your source',
        fix: 'Fix it: keep the last 1,000 sessions and evict the rest',
        retrack: 'Rebuild, run, and track memory again',
        steady: 'The heap holds steady, and no suspect climbs past Low',
      },
      afterSuspect: (shot) => snap(shot, 'profiler-fsharp-leaks'),
      atGraph: (shot) => snap(shot, 'profiler-fsharp-graph'),
    },
  ),
};
