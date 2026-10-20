// Implements [WEB-DESIGN-MEDIA]. Moves in the code editor a language film is
// shot with: go to a line, find a word on screen, hover it, and trigger the
// editor's own completion, navigation, quick fixes and rename. Every result on
// camera comes from SharpLsp; nothing is drawn but the pointer.
import { centre, pointAt } from './overlay.mjs';
import { goTo, sleep } from './workbench.mjs';

/** The active editor's widgets: a hover, the suggest list, the code-action menu, the rename box. */
export const HOVER = '.monaco-hover:not(.hidden)';
export const SUGGEST = '.editor-widget.suggest-widget.visible';
export const ACTIONS = '.action-widget';
export const RENAME = '.rename-box input';

/**
 * The box, in page pixels, of the `nth` whole-word `word` on `line` of the
 * active editor; null while that line is off screen.
 */
export const wordOn = (page, line, word, nth = 0) =>
  page.evaluate(
    ({ line, word, nth }) => {
      const editor = document.querySelector('.editor-group-container.active .monaco-editor');
      const number = [...editor.querySelectorAll('.margin-view-overlays .line-numbers')].find((node) => node.textContent.trim() === String(line));
      const row = number && [...editor.querySelectorAll('.view-lines .view-line')].find((view) => view.style.top === number.parentElement.style.top);
      if (!row) return null;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const nodes = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      const text = nodes.map((node) => node.textContent).join('').replaceAll(' ', ' ');
      const identifier = /[\p{L}\p{N}_']/u;
      const starts = [];
      for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
        if (!identifier.test(text[at - 1] ?? ' ') && !identifier.test(text[at + word.length] ?? ' ')) starts.push(at);
      }
      const start = starts[nth];
      if (start === undefined) return null;
      const range = document.createRange();
      const locate = (offset) => {
        for (const node of nodes) {
          if (offset <= node.textContent.length) return [node, offset];
          offset -= node.textContent.length;
        }
        return [nodes.at(-1), nodes.at(-1).textContent.length];
      };
      range.setStart(...locate(start));
      range.setEnd(...locate(start + word.length));
      const box = range.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    },
    { line, word, nth },
  );


/** The centre of `word` on `line`, scrolled into view first. */
export async function findWord(page, { line, word, nth = 0 }) {
  if (!(await wordOn(page, line, word, nth))) await goTo(page, line);
  const box = await wordOn(page, line, word, nth);
  if (!box) throw new Error(`"${word}" is not on line ${line}`);
  return centre(box);
}

/** Point at `word` on `line` and hover it until the editor's hover shows. */
export async function hoverOn(page, spot) {
  const at = await findWord(page, spot);
  await pointAt(page, at);
  await page.mouse.move(at.x, at.y, { steps: 8 });
  await page.locator(HOVER).first().waitFor({ timeout: 20_000 });
}

/** Click `word` on `line`, putting the cursor in it. */
export async function clickOn(page, spot) {
  const at = await findWord(page, spot);
  await pointAt(page, at);
  await page.mouse.click(at.x, at.y);
  await sleep(300);
}
