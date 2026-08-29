// End-to-end coverage for the repository's Mermaid diagrams. Diagrams replaced the
// hand-drawn ASCII box art that used to sit in untagged code fences, so two things have to
// hold: every `mermaid` fence anywhere in the repository must parse, and a fence on a docs
// page must reach the browser as a rendered SVG rather than a code block.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const MERMAID_MODULE = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SEARCH_ROOTS = ['docs', join('src', 'website', 'src')];
const IGNORED_DIRECTORIES = new Set(['node_modules', '_site', 'target', '.git']);

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORED_DIRECTORIES.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

// Fences carry an indent when they sit inside a list item, and the indent is not part of
// the diagram source, so it is stripped back off exactly as a Markdown renderer would.
function mermaidDiagrams(path) {
  const diagrams = [];
  let open = null;
  readFileSync(path, 'utf-8').split('\n').forEach((line, index) => {
    const fence = line.match(/^(\s*)```(.*)$/);
    if (!fence) {
      open?.source?.push(line.slice(open.indent.length));
      return;
    }
    if (open) {
      if (open.source) diagrams.push({ ...open, source: open.source.join('\n') });
      open = null;
      return;
    }
    const isMermaid = fence[2].trim().split(/\s+/)[0] === 'mermaid';
    open = { id: `${relative(REPO_ROOT, path)}:${index + 1}`, indent: fence[1], source: isMermaid ? [] : null };
  });
  return diagrams;
}

const DIAGRAMS = SEARCH_ROOTS.flatMap((root) => markdownFiles(join(REPO_ROOT, root))).flatMap(mermaidDiagrams);

test.describe('Mermaid diagrams', () => {
  test('every Mermaid diagram in the repository parses', async ({ page }) => {
    expect(DIAGRAMS.length, 'the specs and docs should carry Mermaid diagrams').toBeGreaterThan(10);

    await page.goto('/docs/contributing/');
    const failures = await page.evaluate(async ({ moduleUrl, diagrams }) => {
      const { default: mermaid } = await import(moduleUrl);
      mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true });
      const broken = [];
      for (const diagram of diagrams) {
        try {
          await mermaid.parse(diagram.source);
        } catch (error) {
          broken.push(`${diagram.id} — ${error.message}`);
        }
      }
      return broken;
    }, { moduleUrl: MERMAID_MODULE, diagrams: DIAGRAMS.map(({ id, source }) => ({ id, source })) });

    expect(failures, 'every Mermaid diagram must parse').toEqual([]);
  });

  for (const [route, label] of [
    ['docs/contributing/', 'vscode/'],
    ['ja/docs/contributing/', 'Zed 連携のソース'],
    ['zh/docs/contributing/', 'Zed 集成源码'],
  ]) {
    test(`the repository layout on /${route} renders as an SVG, not a code block`, async ({ page }) => {
      await page.goto(`/${route}`);

      const diagram = page.locator('main pre.mermaid');
      await expect(diagram).toHaveCount(1);
      await expect(diagram.locator('svg')).toBeVisible();
      await expect(diagram.locator('.error-icon')).toHaveCount(0);
      await expect(diagram).toContainText(label);
      await expect(page.locator('main code.language-mermaid')).toHaveCount(0);
    });
  }
});
