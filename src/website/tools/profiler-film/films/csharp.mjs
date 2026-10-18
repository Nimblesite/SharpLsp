// Implements [WEB-DESIGN-MEDIA]. The C# walkthrough the Profiler page plays
// (`profiler-csharp`): Storefront's CPU down to its hot C# lines, then its
// memory: the leak suspect, the static field that roots it, the fix, and a
// second run. The memory half is the leak film's story.
//
//   node src/website/tools/profiler-film/film.mjs csharp
import { profilerTour } from '../kit/acts/tour.mjs';
import { STOREFRONT } from '../kit/set.mjs';
import { leakStory } from './leak.mjs';

export default {
  name: 'profiler-csharp',
  demo: STOREFRONT,
  narration: 'csharp.narration.json',
  poster: { scene: 'heat', at: 5 },
  scenes: profilerTour(
    {
      file: 'CheckoutPipeline.cs',
      captions: {
        profile: 'Profile CPU on a running .NET app, no restart',
        heat: 'Stop: every hot C# line gets its share of the samples',
        results: 'The hottest functions, by self and total time',
      },
    },
    { ...leakStory, captions: { ...leakStory.captions, track: 'Track Memory on the same app' } },
  ),
};
