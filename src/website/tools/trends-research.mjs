// Google Trends research v2: drive the real explore UI, capture widgetdata JSON responses.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const EXPLORES = [
  { label: 'rivals-compare', q: 'OmniSharp,C# Dev Kit,F# vscode' },
  { label: 'needs-compare', q: 'c# language server,F# language server,dotnet lsp' },
  { label: 'omnisharp', q: 'OmniSharp' },
  { label: 'fsharp-vscode', q: 'F# vscode' },
  { label: 'neovim-csharp', q: 'neovim c#' },
  { label: 'rider', q: 'jetbrains rider' },
  { label: 'csharp-devkit', q: 'C# Dev Kit' },
  { label: 'fsharp-language-server', q: 'F# language server' },
];

const out = { runs: {}, errors: [] };
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  locale: 'en-US',
  viewport: { width: 1600, height: 1000 },
});
const page = await ctx.newPage();

// Accept consent if it appears.
await page.goto('https://trends.google.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
for (const name of ['Accept all', 'Accept All', 'I agree', 'Alle akzeptieren']) {
  const btn = page.getByRole('button', { name, exact: false }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(2000);
    break;
  }
}

for (const { label, q } of EXPLORES) {
  const captured = [];
  const onRes = async (res) => {
    const u = res.url();
    if (!u.includes('/trends/api/widgetdata/') && !u.includes('/trends/api/explore')) return;
    try {
      const t = await res.text();
      const json = JSON.parse(t.replace(/^\)\]\}',?\n/, ''));
      captured.push({ url: u.slice(0, 80), json });
    } catch {
      /* non-JSON */
    }
  };
  page.on('response', onRes);
  const url = `https://trends.google.com/trends/explore?date=today%2012-m&q=${encodeURIComponent(q)}&hl=en-US`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
    // Fallback: scrape visible related-queries text from the DOM.
    const domText = await page
      .locator('body')
      .innerText()
      .catch(() => '');
    out.runs[label] = { query: q, captured, domText: domText.slice(0, 6000) };
  } catch (e) {
    out.errors.push(`${label}: ${String(e).slice(0, 150)}`);
  }
  page.off('response', onRes);
  await page.waitForTimeout(1200 + Math.random() * 800);
}

writeFileSync(new URL('./trends-results.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('DONE errors:', out.errors.length, 'runs:', Object.keys(out.runs).length);
await browser.close();
