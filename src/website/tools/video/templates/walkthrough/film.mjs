// Implements [WEB-DESIGN-MEDIA] and [WEB-DESIGN-MEDIA-CAMERA]. TEMPLATE for a
// walkthrough: copy this folder to films/<name>/, rename `name`, and replace
// every scene. The finished reference is films/blazor/.
//
//   make _build-vsix VSIX_PREBUILT=1
//   node src/website/tools/video/film.mjs <name>              (shoot, then publish)
//   node src/website/tools/video/film.mjs <name> --publish    (publish the last shoot)
//
// Every clip is cut through the one camera (kit/zoom.mjs): it pushes in on the
// pointer or the text cursor, whichever moved last, with every widget they open,
// and pulls back when the action goes quiet. So a scene never keys a camera move:
// it puts the pointer and the cursor on what it shows (hoverOn, clickOn, typeAt)
// and holds while the viewer reads. A clip's `scene` names its lines in
// narration.json; show F# before C#.
import { hoverOn } from '../../kit/code.mjs';
import { LANGUAGE, hoverEach, prepareCode, scene, typeThroughCompletion } from '../../kit/acts/language.mjs';
import { SHOP } from '../../kit/set.mjs';
import { sleep } from '../../kit/workbench.mjs';

export default {
  name: '<name>',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'narration.json',
  /** The poster: the cut's frame `at` seconds into `scene`'s clip, camera and caption included. */
  poster: { scene: 'fsharp', at: 4 },
  scenes: [
    { offCamera: prepareCode('<File>.fs', { line: 1, word: '<word>' }) },
    scene('fsharp', 1, '<F#: what the viewer sees>', ({ page }) => hoverEach(page, [{ line: 1, word: '<word>' }])),
    scene('csharp', 2, '<C#: the same feature>', async ({ page }) => {
      await typeThroughCompletion(page, 1, '\n<opening text>', [['<typed>', '<accepted rest>']]);
      await hoverOn(page, { line: 2, word: '<word>' });
      await sleep(3000);
    }),
  ],
};
