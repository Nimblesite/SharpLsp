// Implements [WEB-DESIGN-MEDIA]. The "Refactoring & Code Actions" lesson
// (`refactoring-lesson`): the shortcut, where actions come from, an F# match
// completed and the F# fixes by diagnostic, rename across files, C# fixes that
// generate a method and add a using, what happens underneath, and what is not a
// code action. Its footage is cut from the `refactoring` walkthrough.
//
//   node src/website/tools/video/film.mjs refactoring-lesson
//   node src/website/tools/video/film.mjs refactoring-lesson --preview 2,20,60
//
// Each clip is a crop of the walkthrough's 1920x1200 editor: the code and its
// menus, without the step caption the walkthrough recorded under them.
const FSHARP = [430, 108, 1100, 640];
const RENAME = [430, 108, 1250, 727];
const CSHARP = [430, 170, 1100, 640];
const clip = (from, to, crop, label, speed = 1) => ({ video: 'refactoring', from, to, crop, label, speed });

export default {
  name: 'refactoring-lesson',
  narration: 'refactoring-lesson.narration.json',
  poster: 32,
  lesson: {
    series: 'Lesson · Code actions',
    slides: [
      {
        id: 'intro', layout: 'title', kicker: 'Lesson · Refactoring & Code Actions',
        title: 'Turn problems<br>into <em>code</em>.',
        sub: 'Fix code, generate code and rename across files, in <b>F#</b> and <b>C#</b>: what to press, what you get, and what happens underneath.',
        chips: ['macOS · Linux · Windows', 'F# + C#', 'VS Code', 'Free · MIT'],
      },
      {
        id: 'shortcut', layout: 'keys', kicker: 'Step 1 · The shortcut', heading: 'Every action starts from <em>one</em> shortcut',
        keys: [
          { os: 'macOS', caps: ['⌘', '+', '.'], hot: true, line: 0 },
          { os: 'Windows · Linux', caps: ['Ctrl', '+', '.'], line: 1 },
          { os: 'Or click', caps: ['💡'], line: 2 },
        ],
        sub: 'The menu lists only what applies to your <b>cursor</b>, your <b>selection</b> or the <b>diagnostic</b> under it.', subLine: 3,
      },
      {
        id: 'context', layout: 'points', kicker: 'Step 2 · Where actions come from', heading: 'Actions are <em>context-dependent</em>',
        rows: [
          { k: 'A diagnostic', v: 'A warning or error asks for its own fix', w: 'Quick fix', line: 1 },
          { k: 'The cursor', v: 'A type or member you can reshape', w: 'Refactor', line: 2 },
          { k: 'A selection', v: 'Refactorings that work on the code you highlight', w: 'Refactor', line: 3 },
          { k: 'A blank line', v: 'An empty menu. SharpLsp never guesses', w: 'Nothing', line: 4 },
        ],
      },
      {
        id: 'fsharp', layout: 'footage', kicker: 'Step 3 · F# first', heading: 'Complete an F# <em>match</em>',
        footage: clip(0, 13.7, FSHARP, 'Sessions.fs · FS0025: incomplete match', 2),
        notes: [
          { text: '<code>describe</code> matches on <code>stage</code>, but misses a union case', line: 0 },
          { text: 'The compiler warns: <code>FS0025</code>, incomplete pattern match', line: 1 },
          { text: '<code>⌘.</code> → <b>Generate 1 missing union case(s)</b>', line: 2 },
          { text: 'Or <b>Add wildcard case</b> for a catch-all <code>| _ -&gt;</code>', line: 3 },
        ],
      },
      {
        id: 'fsharp-code', layout: 'code', kicker: 'Step 3 · What it wrote', heading: 'Before and <em>after</em>',
        panes: [
          { label: 'Before · FS0025', line: 0, code: [
            { text: 'let describe stage =' }, { text: '    match stage with', mark: 'warn' }, { text: '    | Browsing -&gt; "still browsing"' },
          ] },
          { label: 'After · Generate missing case', line: 0, code: [
            { text: 'let describe stage =' }, { text: '    match stage with' }, { text: '    | Browsing -&gt; "still browsing"' },
            { text: '    | CheckedOut _ -&gt; failwith "todo"', mark: 'add' },
          ] },
        ],
        caption: 'The compiler knows every case of the union, so the arm is exact. <b>You write the body.</b>', captionLine: 1,
      },
      {
        id: 'fsharp-fixes', layout: 'cards', kicker: 'Step 4 · The F# toolkit', heading: 'F# quick fixes, <em>by diagnostic</em>',
        cards: [
          { code: 'FS0025', text: 'Add a wildcard match arm', line: 0 },
          { code: 'FS0026', text: 'Remove a redundant pattern', line: 0 },
          { code: 'FS0001', text: 'Insert a known conversion', line: 0 },
          { code: 'FS0039', text: 'Add the <code>open</code> that resolves a name', line: 1 },
          { code: 'FS1182', text: 'Prefix an unused binding with <code>_</code>', line: 1 },
          { code: 'FS0020', text: 'Pipe a discarded value to <code>ignore</code>', line: 1 },
          { code: 'match', text: 'Generate missing union cases', line: 2 },
          { code: '{ record }', text: 'Generate missing fields', line: 2 },
          { code: 'interface', text: 'Generate member stubs', line: 2 },
        ],
      },
      {
        id: 'rename', layout: 'footage', kicker: 'Step 5 · Rename', heading: 'Rename is <em>F2</em>, not a code action',
        footage: clip(13.75, 35.3, RENAME, 'Sessions.fs → Program.fs · Rename Symbol'),
        notes: [
          { text: 'Cursor on <code>remember</code>, press <code>F2</code>', line: 0 },
          { text: 'Type <code>rememberOrder</code>, press <code>Enter</code>', line: 1 },
          { text: 'The call in <code>Program.fs</code> follows', line: 2 },
          { text: 'C#: Roslyn\'s solution. F#: the loaded F# project', line: 3 },
        ],
      },
      {
        id: 'generate', layout: 'footage', kicker: 'Step 6 · C#', heading: 'Call it first, <em>generate</em> it second',
        footage: clip(35.35, 59.7, CSHARP, 'CheckoutPipeline.cs · Generate method'),
        notes: [
          { text: 'Write the call you wish existed: <code>Receipt(invoice)</code>', line: 0 },
          { text: 'It doesn\'t exist yet, so it\'s an error', line: 1 },
          { text: '<code>⌘.</code> → <b>Generate method</b>', line: 2 },
          { text: 'Roslyn writes the stub, typed from your call', line: 3 },
        ],
      },
      {
        id: 'using', layout: 'footage', kicker: 'Step 7 · C#', heading: 'Add the missing <em>using</em>',
        footage: clip(59.75, 87.1, CSHARP, 'CheckoutPipeline.cs · Add using'),
        notes: [
          { text: 'Use <code>StringBuilder</code> without its namespace', line: 0 },
          { text: '<code>⌘.</code> offers <code>using System.Text;</code> first', line: 1 },
          { text: 'Or qualify it in place, or generate a class', line: 2 },
          { text: 'Roslyn\'s own fixes, bundled with SharpLsp', line: 3 },
        ],
      },
      {
        id: 'under', layout: 'flow', kicker: 'Under the hood', heading: 'Two requests: <em>list</em>, then <em>resolve</em>',
        stages: [
          { title: 'Ask', text: 'The editor sends <code>textDocument/codeAction</code> for the cursor or selection', line: 0 },
          { title: 'List', text: 'Roslyn (C#) or the F# compiler (F#) returns titles only, so the menu is quick', line: 1 },
          { title: 'Resolve', text: 'Pick one: only then does <code>codeAction/resolve</code> compute its edits', line: 2 },
          { title: 'Apply', text: 'One workspace edit, which can change several files', line: 3 },
        ],
        sub: 'Stale action, or a restarted sidecar? Resolve returns <b>no edit</b>. It never guesses.', subLine: 4,
      },
      {
        id: 'separate', layout: 'points', kicker: 'Good to know', heading: 'Formatting and sorting are <em>separate</em>',
        rows: [
          { k: 'Format C#', v: 'Use <b>CSharpier</b>', w: 'Not an LSP format', line: 1 },
          { k: 'Format F#', v: 'Use <b>Fantomas</b>', w: 'Not an LSP format', line: 1 },
          { k: 'Sort Members', v: 'Right-click a C# type in the Solution Explorer', w: 'Its own command', line: 2 },
        ],
      },
      {
        id: 'recap', layout: 'recap', kicker: 'Recap', heading: 'You just learned',
        items: [
          { text: '<code>⌘.</code> or <code>Ctrl .</code> opens every action that applies', line: 0 },
          { text: 'F# fixes follow compiler diagnostics, and write whole match cases', line: 1 },
          { text: '<code>F2</code> renames across files, in F# and C#', line: 2 },
          { text: 'In C#, call first and generate second', line: 3 },
        ],
        url: 'sharplsp.dev/docs/refactoring', urlLine: 4,
      },
    ],
  },
};
