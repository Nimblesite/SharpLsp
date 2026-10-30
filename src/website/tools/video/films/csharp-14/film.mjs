// Implements [WEB-DESIGN-MEDIA]. The footage for the "C# 14 features in VS
// Code" tutorial reel: write an extension block, use its extension property
// through completion and hover, go to its definition, give a property a body
// with the `field` keyword, and assign through `?.`. This film only shoots: the
// reel's page, voice and score are rendered by the TikTok factory's
// screen-film pipeline, which reads these clips from out/csharp-14/clips.
//
//   node src/website/tools/video/film.mjs csharp-14
import fs from 'node:fs';
import path from 'node:path';
import { hoverOn } from '../../kit/code.mjs';
import { LANGUAGE, awaitSemantics, complete, navigate, scene, typeText } from '../../kit/acts/language.mjs';
import { runCommand } from '../../kit/editor.mjs';
import { shootWalkthrough } from '../../kit/scenes.mjs';
import { CSHARP14 } from '../../kit/set.mjs';
import { PARK, openFile, sleep, typeAt } from '../../kit/workbench.mjs';

/** Code big enough to read on a phone, without the reference counts between every line. */
const READABLE = { ...LANGUAGE, 'editor.fontSize': 21, 'editor.lineHeight': 32, 'editor.codeLens': false };

/** The extension block, typed into the empty line of TextExtensions. */
const EXTENSION = ['    extension(string text)', '    {', '        public bool IsBlank => string.IsNullOrWhiteSpace(text);', '    }'].join('\n');

/** Off camera: notifications silenced, the side bar away, Program.cs open once Roslyn answers. */
async function prepare({ page }) {
  await runCommand(page, 'Notifications: Toggle Do Not Disturb Mode');
  await runCommand(page, 'View: Toggle Primary Side Bar Visibility');
  await openFile(page, 'Program.cs');
  await awaitSemantics(page, { line: 3, word: 'Customer' });
  await openFile(page, 'Extensions.cs');
  await sleep(1500);
}

/** Save, and let the engine see the saved file. */
async function save(page) {
  await page.keyboard.press('Meta+S');
  await sleep(1500);
}

/** Leave the pointer parked and any hover closed. */
async function rest(page) {
  await page.mouse.move(PARK.x, PARK.y);
  await page.keyboard.press('Escape');
  await sleep(600);
}

/** Step 1: an extension block on string, holding one extension property. */
async function extensionBlock({ page }) {
  await typeAt(page, { line: 5, text: EXTENSION });
  await page.keyboard.press('Escape');
  await save(page);
  await hoverOn(page, { line: 7, word: 'IsBlank' });
  await sleep(3500);
  await rest(page);
}

/** Step 2: the property on any string, offered by completion and explained by hover. */
async function useIt({ page }) {
  await openFile(page, 'Program.cs');
  await typeAt(page, { line: 4, text: 'if (customer.Name.' });
  await complete(page, 'IsBl');
  await typeText(page, ') Console.WriteLine("No name");');
  await page.keyboard.press('Escape');
  await save(page);
  await hoverOn(page, { line: 4, word: 'IsBlank' });
  await sleep(3500);
  await rest(page);
}

/** Step 3: F12 on the extension property lands in its extension block. */
async function definition({ page }) {
  await navigate(page, { line: 4, word: 'IsBlank' }, 'F12');
  await page.locator('.tab.active', { hasText: 'Extensions.cs' }).waitFor({ timeout: 20_000 });
  await sleep(3500);
}

/** Step 4: a setter with a body and no backing field: `field` is the one the compiler makes. */
async function fieldKeyword({ page }) {
  await openFile(page, 'Customer.cs');
  await typeAt(page, { line: 5, text: '    public string Name { get; set => field = value.Trim(); } = "";' });
  await page.keyboard.press('Escape');
  await save(page);
  await hoverOn(page, { line: 5, word: 'field' });
  await sleep(3500);
  await rest(page);
}

/** Step 5: assign through `?.`: when Address is null, nothing is assigned, and the build stays clean. */
async function nullConditional({ page }) {
  await openFile(page, 'Program.cs');
  await typeAt(page, { line: 4, append: true, text: '\ncustomer.Address?.City = "London";' });
  await page.keyboard.press('Escape');
  await save(page);
  await sleep(2500);
  // The hover is a bonus here: the clean status bar is the point, so a slow answer never fails the take.
  await hoverOn(page, { line: 5, word: 'City' }).catch(() => undefined);
  await sleep(3000);
  await rest(page);
}

const SCENES = [
  { offCamera: prepare },
  scene('extension', 1, 'Write an extension block', extensionBlock),
  scene('use', 2, 'Use it on any string', useIt),
  scene('definition', 3, 'Go to its definition', definition),
  scene('field', 4, 'The field keyword', fieldKeyword),
  scene('assign', 5, 'Null-conditional assignment', nullConditional),
];

/** The shot clips, in order: what the reel's factory reads. */
const clipsOf = (out) => SCENES.filter((each) => each.clip).map((each) => path.join(out, 'clips', `${each.clip}.mp4`));

export default {
  name: 'csharp-14',
  shoot: (out) => shootWalkthrough({ demo: CSHARP14, out, scenes: SCENES, settings: READABLE }),
  publish: async (out) => {
    const missing = clipsOf(out).filter((clip) => !fs.existsSync(clip));
    if (missing.length) throw new Error(`not shot: ${missing.join(', ')}`);
    return 0;
  },
  preview: async () => 0,
};
