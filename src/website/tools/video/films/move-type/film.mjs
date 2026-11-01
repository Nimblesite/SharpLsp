// Implements [WEB-DESIGN-MEDIA]. The footage for the "Move a class out" tutorial
// reel: move a top-level type to its own file, move a private nested record out
// of its container (it turns internal and qualifies what it borrowed), move a
// public nested enum out and watch its callers lose the `Order.` prefix, and
// see the action withheld where the move could not compile
// ([REFACTOR-MOVE-TYPE]). This film only shoots: the reel's page, voice and
// score are rendered by the TikTok factory's screen-film pipeline, which reads
// these clips from out/move-type/clips.
//
//   node src/website/tools/video/film.mjs move-type
import fs from 'node:fs';
import path from 'node:path';
import { ACTIONS, clickOn } from '../../kit/code.mjs';
import { LANGUAGE, awaitSemantics, quickFix, scene } from '../../kit/acts/language.mjs';
import { runCommand } from '../../kit/editor.mjs';
import { shootWalkthrough } from '../../kit/scenes.mjs';
import { MOVETYPE } from '../../kit/set.mjs';
import { PARK, openFile, sleep } from '../../kit/workbench.mjs';

/** Code big enough to read on a phone, without the reference counts between every line. */
const READABLE = { ...LANGUAGE, 'editor.fontSize': 21, 'editor.lineHeight': 32, 'editor.codeLens': false, 'editor.occurrencesHighlight': 'off', 'editor.selectionHighlight': false };

/** Where each type sits in Orders.cs. Shot bottom-up, so no move shifts a later target. */
const SPOT = {
  receipt: { line: 34, word: 'Receipt' },
  lineItem: { line: 28, word: 'LineItem' },
  status: { line: 25, word: 'Status' },
  totals: { line: 18, word: 'Totals' },
};

/** Off camera: notifications silenced, the side bar away, Orders.cs open once Roslyn answers. */
async function prepare({ page }) {
  await runCommand(page, 'Notifications: Toggle Do Not Disturb Mode');
  await runCommand(page, 'View: Toggle Primary Side Bar Visibility');
  await openFile(page, 'Program.cs');
  await awaitSemantics(page, { line: 3, word: 'Order' });
  await openFile(page, 'Orders.cs');
  await sleep(1500);
}

/** Save every buffer the move touched, so the engine sees the new file as a file. */
async function saveAll(page) {
  await runCommand(page, 'File: Save All Files');
  await sleep(1500);
}

/** Leave the pointer parked and any widget closed. */
async function rest(page) {
  await page.mouse.move(PARK.x, PARK.y);
  await page.keyboard.press('Escape');
  await sleep(600);
}

/**
 * Apply the action titled `title` at `spot` in Orders.cs, save, open `file` and
 * click `result` in it: the applied edit leaves its range selected, and the click
 * clears that and points at what changed.
 */
async function moveAndShow(page, cues, spot, title, file, result) {
  await openFile(page, 'Orders.cs');
  await quickFix(page, cues, spot, title);
  await saveAll(page);
  await openFile(page, file);
  await sleep(1200);
  await clickOn(page, result);
  await sleep(3000);
  await rest(page);
}

/** Step 1: Receipt shares Order's file; Roslyn's own move gives it one of its own. */
async function toFile({ page, set }) {
  await moveAndShow(page, set.cues, SPOT.receipt, 'Move type to Receipt.cs', 'Receipt.cs', { line: 3, word: 'Receipt' });
}

/** Step 2: a private nested record moves out: internal now, and `Round` qualified as `Order.Round`. */
async function privateOut({ page, set }) {
  await moveAndShow(page, set.cues, SPOT.lineItem, "Move 'LineItem' out of 'Order' to LineItem.cs", 'LineItem.cs', { line: 4, word: 'internal' });
}

/** Step 3: a public nested enum moves out, and Program.cs loses its `Order.` prefix. */
async function callersFollow({ page, set }) {
  await moveAndShow(page, set.cues, SPOT.status, "Move 'Status' out of 'Order' to Status.cs", 'Program.cs', { line: 5, word: 'Status' });
}

/** Step 4: Totals calls Order's private Tax; the move is not offered at all. */
async function refused({ page }) {
  await openFile(page, 'Orders.cs');
  await clickOn(page, SPOT.totals);
  await page.keyboard.press('Meta+.');
  await page.locator(`${ACTIONS} .monaco-list-row`).first().waitFor({ timeout: 20_000 });
  await sleep(3500);
  const titles = await page.locator(`${ACTIONS} .monaco-list-row`).allInnerTexts();
  if (titles.some((title) => title.includes(' out of '))) throw new Error(`the move was offered for Totals: ${titles.join(' | ')}`);
  await rest(page);
}

const SCENES = [
  { offCamera: prepare },
  scene('file', 1, 'Move a type to its own file', toFile),
  scene('private', 2, 'Move a private nested type out', privateOut),
  scene('callers', 3, 'Callers follow', callersFollow),
  scene('refused', 4, 'Withheld where it would not compile', refused),
];

/** The shot clips, in order: what the reel's factory reads. */
const clipsOf = (out) => SCENES.filter((each) => each.clip).map((each) => path.join(out, 'clips', `${each.clip}.mp4`));

export default {
  name: 'move-type',
  shoot: (out) => shootWalkthrough({ demo: MOVETYPE, out, scenes: SCENES, settings: READABLE }),
  publish: async (out) => {
    const missing = clipsOf(out).filter((clip) => !fs.existsSync(clip));
    if (missing.length) throw new Error(`not shot: ${missing.join(', ')}`);
    return 0;
  },
  preview: async () => 0,
};
