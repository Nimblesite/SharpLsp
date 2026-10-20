// Implements [WEB-DESIGN-MEDIA]. The home page's one-minute composited film
// (`profiler-film`), and the unedited CPU and memory recordings beside it. It is
// a composite: capture.mjs shoots stills and screencasts on the Storefront demo,
// and render.mjs steps film.html (film.js draws every frame from t) over them.
//
//   node src/website/tools/video/film.mjs profiler
//   node src/website/tools/video/film.mjs profiler --preview 2,9.5,24
import { shoot } from './capture.mjs';
import { preview, publish } from './render.mjs';

export default { name: 'profiler-film', shoot, publish, preview };
