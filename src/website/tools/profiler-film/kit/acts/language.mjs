// Implements [WEB-DESIGN-MEDIA]. The language films' editor: the workspace
// settings they are shot with, the off-camera step that waits for the
// semantic engines, and the editor's own completion, quick-fix, rename and
// navigation moves, each with the pointer on what it acts on.
import { ACTIONS, HOVER, RENAME, SUGGEST, clickOn, hoverOn } from '../code.mjs';
import { runCommand } from '../editor.mjs';
import { caption, ringClick } from '../overlay.mjs';
import { PARK, clickSharpLspIcon, openFile, sleep } from '../workbench.mjs';

/**
 * Workspace settings for a language film: hover, signature help, CodeLens and
 * the lightbulb on, as a user has them. Completion opens on a trigger character
 * or on request, never mid-word, and nothing commits it but Enter or Tab, so
 * code typed on camera lands exactly as written.
 */
export const LANGUAGE = {
  'editor.hover.enabled': true,
  'editor.hover.delay': 250,
  'editor.codeLens': true,
  'editor.lightbulb.enabled': 'onCode',
  'editor.parameterHints.enabled': true,
  'editor.quickSuggestions': { other: 'off', comments: 'off', strings: 'off' },
  'editor.suggestOnTriggerCharacters': true,
  'editor.acceptSuggestionOnCommitCharacter': false,
  'editor.suggest.preview': false,
  'editor.inlineSuggest.enabled': false,
  'editor.autoClosingBrackets': 'never',
  'editor.autoClosingQuotes': 'never',
  'editor.autoSurround': 'never',
  'editor.autoIndent': 'none',
  'editor.formatOnType': false,
  'files.autoSave': 'off',
};

/** A pane of the SharpLsp view, folded or opened by its header. */
export async function setPane(page, title, open) {
  const header = page.locator('.pane-header', { hasText: title }).first();
  if ((await header.getAttribute('aria-expanded')) !== String(open)) await header.click();
  await sleep(500);
}

/** The Solution Explorer folded down to the solution and its projects. */
export async function foldSolution(page) {
  const header = page.locator('.pane-header', { hasText: 'Solution Explorer' });
  await header.hover();
  await header.getByRole('button', { name: 'Collapse All' }).click();
  await sleep(600);
  await page.getByRole('treeitem', { name: /\.slnx?$/ }).first().click();
  await sleep(1000);
}

/** Hover `spot` until the engine answers: the solution has loaded. Then dismiss the hover. */
export async function awaitSemantics(page, spot) {
  for (let attempt = 0; ; attempt++) {
    try {
      await hoverOn(page, spot);
      break;
    } catch (error) {
      if (attempt >= 12) throw error;
      await page.mouse.move(PARK.x, PARK.y);
      await sleep(5000);
    }
  }
  await page.mouse.move(PARK.x, PARK.y);
  await page.keyboard.press('Escape');
  await page.locator(HOVER).waitFor({ state: 'hidden' }).catch(() => undefined);
}

/**
 * Off camera: notifications silenced, the SharpLsp view showing just the
 * Solution Explorer, folded to its projects, and `file` open once `probe` (a
 * `{ line, word }` in it) answers a hover.
 */
export const prepareCode = (file, probe) => async ({ page }) => {
  await runCommand(page, 'Notifications: Toggle Do Not Disturb Mode');
  await clickSharpLspIcon(page);
  await setPane(page, 'Processes', false);
  await foldSolution(page);
  await openFile(page, file);
  await awaitSemantics(page, probe);
};

/**
 * VS Code's Settings, opened as the modal editor it is (Cmd+,), searched for
 * `query`; `close` dismisses the modal again.
 */
export const settingsEditor = {
  open: async (page, query) => {
    await page.keyboard.press('Meta+Comma');
    await page.locator('.settings-editor').waitFor();
    await sleep(1000);
    await typeText(page, query, 100);
  },
  close: async (page) => {
    await page.locator('.monaco-modal-editor-block').getByRole('button', { name: /^Close/ }).first().click();
    await page.locator('.monaco-modal-editor-block').waitFor({ state: 'detached' });
  },
};

/** The SharpLsp log in the panel, showing only the lines that mention `text`. */
export async function showLog(page, text) {
  await runCommand(page, 'SharpLsp: Show Output Channel');
  await page.locator('.part.panel input[placeholder^="Filter"]').first().click();
  await page.keyboard.press('Meta+A');
  await typeText(page, text, 60);
  await sleep(1200);
}

/** Hide the bottom panel when it is showing. */
export async function hidePanel(page) {
  if (await page.locator('.part.panel').isVisible().catch(() => false)) await runCommand(page, 'View: Toggle Panel Visibility');
}

/** Off camera: open `file` until `probe` answers a hover, so its language's engine is warm before it is filmed. */
export const warm = (file, probe) => async ({ page }) => {
  await openFile(page, file);
  await awaitSemantics(page, probe);
};

/** Off camera: every editor closed without saving, `file` open. Fails if an edited editor survives. */
export const reopen = (file) => async ({ page }) => {
  await runCommand(page, 'View: Close All Editors');
  const edited = page.locator('.tabs-container .tab.dirty');
  // The save prompt opens a moment after the close: answer it until no edited editor is left.
  for (let attempt = 0; attempt < 10 && (await edited.count()) > 0; attempt++) {
    const dontSave = page.getByRole('dialog').getByRole('button', { name: "Don't Save" });
    if (await dontSave.isVisible().catch(() => false)) await dontSave.click();
    await sleep(500);
  }
  if ((await edited.count()) > 0) throw new Error('an edited editor stayed open');
  await openFile(page, file);
};

/** Scroll the active editor by `pixels`, so what a film types sits clear of the caption. */
export async function scrollEditor(page, pixels) {
  await page.mouse.move(1000, 450);
  await page.mouse.wheel(0, pixels);
  await sleep(700);
  await page.mouse.move(PARK.x, PARK.y);
}

/** Type `text` key by key where the cursor is, as a person does. */
export const typeText = (page, text, delay = 45) => page.keyboard.type(text, { delay });

/** Wait for the completion list, narrow it with `filter`, and accept the top match. */
export async function complete(page, filter) {
  await page.locator(SUGGEST).waitFor({ timeout: 15_000 });
  await sleep(1400);
  await typeText(page, filter, 110);
  await sleep(1200);
  await page.keyboard.press('Tab');
  await sleep(600);
}

/** Open the quick fixes at `spot` (Cmd+.) and apply the one titled `title`. */
export async function quickFix(page, cues, spot, title) {
  await clickOn(page, spot);
  await page.keyboard.press('Meta+.');
  const action = page.locator(`${ACTIONS} .monaco-list-row`, { hasText: title }).first();
  await action.waitFor({ timeout: 20_000 });
  await sleep(1500);
  await ringClick(page, cues, action, title);
  await sleep(1500);
}

/** Rename the symbol at `spot` to `name` (F2), as typed into the rename box. */
export async function renameTo(page, spot, name) {
  await clickOn(page, spot);
  await page.keyboard.press('F2');
  const box = page.locator(RENAME);
  await box.waitFor({ timeout: 20_000 });
  await sleep(900);
  await page.keyboard.press('Meta+A');
  await typeText(page, name, 80);
  await sleep(700);
  await page.keyboard.press('Enter');
  await sleep(1500);
}

/**
 * Press `key` with the cursor on `spot`: F12 to its definition, Shift+F12 to its
 * references. An editor that answers "No definition found" fails the take.
 */
export async function navigate(page, spot, key) {
  await clickOn(page, spot);
  await sleep(400);
  await page.keyboard.press(key);
  await sleep(1500);
  const message = page.locator('.monaco-editor-overlaymessage', { hasText: /^No / });
  if (await message.isVisible().catch(() => false)) throw new Error(`${key} on ${spot.word}: ${await message.innerText()}`);
}

/** Peek every reference to `spot` (Shift+F12), hold on the list for `hold` ms, and close it. */
export async function peekReferences(page, spot, hold = 4500) {
  await navigate(page, spot, 'Shift+F12');
  await page.locator('.peekview-widget').first().waitFor({ timeout: 20_000 });
  await sleep(hold);
  await page.keyboard.press('Escape');
}

/**
 * Hover `spots` one after another, `{ line, word }` each, holding on each hover.
 * The editor first scrolls `scroll` pixels, so the hovers clear the caption.
 */
export async function hoverEach(page, spots, { scroll = 0, hold = 2600 } = {}) {
  if (scroll) await scrollEditor(page, scroll);
  for (const spot of spots) {
    await hoverOn(page, spot);
    await sleep(hold);
  }
}

/**
 * Clip `clip`: step `number`'s caption while `act(shot)` runs. A `speed` above 1
 * plays it fast-forwarded, and the caption says so; `retries` shoots a failed
 * take again.
 */
export const scene = (clip, number, text, act, { speed = 1, retries = 1 } = {}) => ({
  clip,
  speed,
  retries,
  act: async (shot) => {
    await caption(shot.page, number, text, speed > 1 ? `${speed}×` : '');
    await sleep(900);
    await act(shot);
    await sleep(1200);
  },
});
