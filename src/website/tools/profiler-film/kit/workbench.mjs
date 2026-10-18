// Implements [WEB-DESIGN-MEDIA]. Moves in the isolated VS Code a film is shot
// in: the SharpLsp Processes view and its demo row, editor groups, panels and
// typing. Nothing here is staged; every move is a real click or keystroke.
import { runCommand } from './editor.mjs';
import { demoPid } from './set.mjs';

/** Where the mouse rests between actions: empty title bar, hovering nothing. */
export const PARK = { x: 1450, y: 22 };

export const DASHBOARD = 'SharpLsp Memory Dashboard';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The frame inside a webview panel (the memory dashboard, the CPU results). */
export const panel = (page) => page.frameLocator('iframe.webview').first().frameLocator('#active-frame');

const processesHeader = (page) => page.locator('.pane-header', { hasText: 'Processes' });

export const demoRow = (page) => page.getByRole('treeitem').filter({ hasText: new RegExp(`PID ${demoPid()}(?!\\d)`) }).first();

export async function headerButton(page, name) {
  await processesHeader(page).hover();
  return processesHeader(page).getByRole('button', { name: new RegExp(`^${name}`) });
}

export async function rowButton(page, name) {
  await demoRow(page).hover();
  await sleep(250);
  return demoRow(page).getByRole('button', { name: new RegExp(`^${name}`) });
}

/** Wait until the Processes view lists the live demo's row. */
export async function waitForDemoRow(page) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await demoRow(page).isVisible().catch(() => false)) return;
    await (await headerButton(page, 'Refresh Processes')).click();
    await sleep(1000);
  }
  throw new Error(`PID ${demoPid()} never appeared in the Processes view`);
}

/**
 * Click the SharpLsp activity-bar icon. It opens the SharpLsp view; on the view
 * already open it folds the side bar away. That is how a memory act hides it:
 * the dashboard webview refreshes on every auto-snapshot and would close a
 * palette, and the native menu owns Cmd+B, so a synthetic key never reaches it.
 */
export async function clickSharpLspIcon(page) {
  await page.locator('.activitybar a[aria-label^="SharpLsp"]').first().click({ force: true });
  await sleep(900);
}

export async function openFile(page, name) {
  await page.keyboard.press('Meta+P');
  await page.locator('.quick-input-widget input').fill(name);
  await sleep(700);
  await page.keyboard.press('Enter');
  await sleep(1200);
}

/** Scroll the panel on the right of the editor (the dashboard or the results). */
export async function scrollDashboard(page, pixels) {
  await page.mouse.move(1300, 600);
  await page.mouse.wheel(0, pixels);
  await sleep(1200);
}

/**
 * Start memory tracking on the demo's row and fold the side bar once the
 * dashboard opens. `click(locator, label)` is the act's own way of clicking.
 */
export async function trackMemory(page, click) {
  await click(await rowButton(page, 'Track Memory'), 'Track Memory');
  await awaitDashboard(page);
}

/** Wait for the memory dashboard to open, then fold the side bar away from it. */
export async function awaitDashboard(page) {
  await page.locator('.tab', { hasText: DASHBOARD }).waitFor({ timeout: 60_000 });
  await sleep(1500);
  await clickSharpLspIcon(page);
  await page.mouse.move(PARK.x, PARK.y);
}

/** Wait for the CPU results panel that a stop opens. */
export const awaitResults = (page) => page.locator('.tab', { hasText: 'SharpLsp Profiler' }).waitFor({ timeout: 60_000 });

/** How many editor groups are on screen: one while a group is maximised. */
const shownGroups = (page) =>
  page.locator('.part.editor .editor-group-container').evaluateAll((groups) => groups.filter((group) => group.offsetWidth > 0).length);

/**
 * Toggle `title`'s editor group maximised by double-clicking its tab — no
 * palette, which a refreshing webview would close by stealing focus. A webview
 * can swallow the double-click, so the toggle is checked and tried again.
 */
export async function toggleMaximised(page, title) {
  const before = await shownGroups(page);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator('.tab', { hasText: title }).first().dblclick();
    await sleep(1200);
    if ((await shownGroups(page)) !== before) return;
  }
  throw new Error(`${title}'s editor group never toggled`);
}

export async function toggleSideBar(page) {
  await runCommand(page, 'View: Toggle Primary Side Bar Visibility');
  await sleep(800);
}

/** Go to `line` and type `text` over it, or after its end when the edit appends; key by key, as a person types. */
export async function typeAt(page, { line, text, append = false }) {
  await page.keyboard.press('Control+G');
  await page.locator('.quick-input-widget input').fill(`:${line}`);
  await page.keyboard.press('Enter');
  await page.keyboard.press(append ? 'End' : 'Shift+End');
  for (const [index, part] of text.split('\n').entries()) {
    // Escape first: an editor widget left open would take the Enter instead of the line break.
    if (index > 0) for (const key of ['Escape', 'Enter']) await page.keyboard.press(key);
    await page.keyboard.type(part, { delay: 28 });
  }
}
