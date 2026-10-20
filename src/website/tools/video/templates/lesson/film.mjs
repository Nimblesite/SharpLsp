// Implements [WEB-DESIGN-MEDIA]. TEMPLATE for a lesson: copy this folder to
// films/<name>/, rename `name`, and replace every slide. The finished reference
// is films/refactoring-lesson/. Every layout kit/lesson/deck.js knows is used
// once below; delete the ones a lesson does not need.
//
//   node src/website/tools/video/film.mjs <name> --preview 2,20,60   (stills, no speech)
//   node src/website/tools/video/film.mjs <name>                     (speak, render, publish)
//
// A slide's `id` is the `scene` of its lines in narration.json. An item with
// `line: n` appears as the slide's n-th line (from 0) starts; items sharing a
// line cascade. Footage is cut from a published walkthrough, never mocked:
// `crop` is [x, y, w, h] in its 1920x1200 frame, kept clear of the walkthrough's
// step caption, and `speed` above 1 shows the speed badge the walkthrough had.
const CROP = [430, 108, 1100, 640];
const clip = (from, to, label, speed = 1) => ({ video: '<walkthrough>', from, to, crop: CROP, label, speed });

export default {
  name: '<name>',
  narration: 'narration.json',
  /** The poster's second in the finished lesson: pick a footage slide. */
  poster: 30,
  lesson: {
    series: 'Lesson · <Feature>',
    slides: [
      {
        id: 'intro', layout: 'title', kicker: 'Lesson · <Docs page title>',
        title: '<Promise in<br>a few <em>words</em>.>',
        sub: '<What the viewer will be able to do, in <b>F#</b> and <b>C#</b>.>',
        chips: ['macOS · Linux · Windows', 'F# + C#', 'VS Code', 'Free · MIT'],
      },
      {
        id: 'keys', layout: 'keys', kicker: 'Step 1 · <The shortcut>', heading: '<Heading with an <em>accent</em>>',
        keys: [
          { os: 'macOS', caps: ['⌘', '+', '.'], hot: true, line: 0 },
          { os: 'Windows · Linux', caps: ['Ctrl', '+', '.'], line: 1 },
        ],
        sub: '<One sentence under the keys.>', subLine: 2,
      },
      {
        id: 'points', layout: 'points', kicker: 'Step 2 · <Idea>', heading: '<Heading>',
        rows: [
          { k: '<Term>', v: '<What it means>', w: '<Tag>', line: 1 },
          { k: '<Term>', v: '<What it means>', w: '<Tag>', line: 2 },
        ],
      },
      {
        id: 'footage', layout: 'footage', kicker: 'Step 3 · <F# first>', heading: '<What the clip shows>',
        footage: clip(0, 12, '<File> · <what happens>'),
        notes: [
          { text: '<First thing to notice, with <code>code</code>>', line: 0 },
          { text: '<The key press>', line: 1 },
          { text: '<The result>', line: 2 },
        ],
      },
      {
        id: 'code', layout: 'code', kicker: 'Step 3 · <What it wrote>', heading: 'Before and <em>after</em>',
        panes: [
          { label: 'Before', line: 0, code: [{ text: '<code line>' }, { text: '<flagged line>', mark: 'warn' }] },
          { label: 'After', line: 0, code: [{ text: '<code line>' }, { text: '<added line>', mark: 'add' }] },
        ],
        caption: '<Why the result is right.>', captionLine: 1,
      },
      {
        id: 'cards', layout: 'cards', kicker: 'Step 4 · <Reference>', heading: '<Heading>',
        cards: [
          { code: '<FS0001>', text: '<What it does>', line: 0 },
          { code: '<FS0002>', text: '<What it does>', line: 0 },
          { code: '<FS0003>', text: '<What it does>', line: 0 },
        ],
      },
      {
        id: 'flow', layout: 'flow', kicker: 'Under the hood', heading: '<Heading>',
        stages: [
          { title: '<Stage>', text: '<What happens, with <code>method</code>>', line: 0 },
          { title: '<Stage>', text: '<What happens>', line: 1 },
          { title: '<Stage>', text: '<What happens>', line: 2 },
        ],
        sub: '<The failure case, stated plainly.>', subLine: 3,
      },
      {
        id: 'recap', layout: 'recap', kicker: 'Recap', heading: 'You just learned',
        items: [
          { text: '<Takeaway>', line: 0 },
          { text: '<Takeaway>', line: 1 },
        ],
        url: 'sharplsp.dev/docs/<page>', urlLine: 2,
      },
    ],
  },
};
