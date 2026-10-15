// Shoots the interactive flame graph SharpLsp writes on every CPU stop (the
// inferno SVG the results panel's "Open Interactive Flame Graph" opens): the
// whole profile, then zoomed into the JSON parsing subtree with one real click.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const ZOOM_FRAME = 'ParseCatalog';

function newestFlameGraph(profiles) {
  const svg = fs
    .readdirSync(profiles)
    .filter((name) => name.endsWith('.flamegraph.svg'))
    .map((name) => path.join(profiles, name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .at(-1);
  if (!svg) throw new Error(`no flame graph under ${profiles}`);
  return svg;
}

/** Screenshot the flame graph whole and zoomed; `out/stills/profiler-flamegraph*.png`. */
export async function captureFlameGraph(profiles, out) {
  const svg = newestFlameGraph(profiles);
  fs.copyFileSync(svg, path.join(out, 'profiler.flamegraph.svg'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    await page.goto(`file://${svg}`);
    await page.waitForTimeout(800);
    const graph = page.locator('svg').first();
    await graph.screenshot({ path: path.join(out, 'stills/profiler-flamegraph.png') });
    const frame = page.locator('#frames > g', { has: page.locator(`title:text-matches("${ZOOM_FRAME}")`) });
    await frame.first().click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(800);
    await graph.screenshot({ path: path.join(out, 'stills/profiler-flamegraph-zoom.png') });
  } finally {
    await browser.close();
  }
}
