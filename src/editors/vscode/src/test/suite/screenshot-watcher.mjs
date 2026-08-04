// Runs alongside the VS Code e2e tests when SHARPLSP_SCREENSHOTS=1.
// Connects to VS Code via CDP, watches for .signal files written by
// takeScreenshot() in test-helpers.ts, takes screenshots, writes the PNGs.

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../../");
const outputDir = path.resolve(repoRoot, "website/src/assets/screenshots");
const CDP_PORT = Number.parseInt(process.env.SHARPLSP_SCREENSHOT_CDP_PORT ?? "9239", 10);
const POLL_MS = 200;
const TIMEOUT_MS = 600_000;

fs.mkdirSync(outputDir, { recursive: true });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      if (await page.locator(".monaco-workbench").isVisible({ timeout: 500 }).catch(() => false)) {
        return page;
      }
    }
  }
  return null;
}

async function main() {
  console.log(`[screenshots] waiting for VS Code CDP on port ${CDP_PORT}...`);
  const cdpDeadline = Date.now() + 120_000;
  while (Date.now() < cdpDeadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) break;
    } catch { /* not ready */ }
    await sleep(500);
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  console.log("[screenshots] connected. watching for signal files...");

  let page = null;
  const pageDeadline = Date.now() + 30_000;
  while (!page && Date.now() < pageDeadline) {
    page = await getPage(browser);
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("VS Code workbench page not found");

  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const signals = fs.readdirSync(outputDir).filter((f) => f.endsWith(".signal"));
    for (const signal of signals) {
      const requestedFilename = fs.readFileSync(path.join(outputDir, signal), "utf8").trim();
      const signalPath = path.join(outputDir, signal);
      // signal filename is `<tempFilename>.signal`, e.g. `foo.png.tmp-1234.png.signal`
      // requested filename is the final PNG name, e.g. `foo.png`
      // test-helpers expects the temp file to appear, then renames it to final
      const tempFilename = signal.replace(/\.signal$/, "");
      const tempPath = path.join(outputDir, tempFilename);

      // Dismiss notifications
      const notification = page.locator(".notifications-toasts");
      if (await notification.isVisible({ timeout: 300 }).catch(() => false)) {
        await page.keyboard.press("Escape");
        await sleep(200);
      }

      await page.screenshot({ path: tempPath, type: "png", fullPage: false });
      fs.unlinkSync(signalPath);
      const kb = Math.round(fs.statSync(tempPath).size / 1024);
      console.log(`[screenshots] ${requestedFilename} (${kb}KB)`);
    }
    await sleep(POLL_MS);
  }

  await browser.close();
}

main().catch((err) => {
  console.error("[screenshots] failed:", err.message);
  process.exit(1);
});
