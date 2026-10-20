// Implements [WEB-DESIGN-MEDIA]. Moves in the SharpLsp Solution Explorer: a
// row by its label, its context menu opened with the pointer on it, an item
// picked from that menu, and a folded row opened.
import { centre, pointAt, ringClick } from '../overlay.mjs';
import { sleep } from '../workbench.mjs';

/** The Solution Explorer row whose label matches `name` (a RegExp). */
export const row = (page, name) => page.getByRole('treeitem', { name }).first();

/** Right-click `name`'s row with the pointer on its label, and hold on the menu it opens. */
export async function openMenu(page, name) {
  const target = row(page, name);
  const box = await target.boundingBox();
  if (!box) throw new Error(`no Solution Explorer row ${name}`);
  const at = centre(box, 120);
  await pointAt(page, at);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.locator('.monaco-menu').first().waitFor();
  await sleep(1600);
}

/** Pick the item labelled exactly `label` from the open context menu. */
export const pickMenu = (page, cues, label) =>
  ringClick(page, cues, page.locator('.monaco-menu .action-label').filter({ hasText: new RegExp(`^${label}$`) }).first(), label);

/** Open `name`'s row when it is folded. */
export async function unfold(page, name) {
  const target = row(page, name);
  if ((await target.getAttribute('aria-expanded')) === 'false') {
    await target.locator('.monaco-tl-twistie').click();
    await sleep(900);
  }
}
