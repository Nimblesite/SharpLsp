// Runs alongside the e2e tests. Connects to VS Code via CDP (port 9229),
// watches for .signal files written by takeScreenshot() in test-helpers.ts,
// takes a screenshot of the VS Code window, saves the PNG, removes the signal.

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const outputDir = path.resolve(repoRoot, "website/src/assets/screenshots");
const CDP_PORT = 9229;
const POLL_MS = 200;
const TIMEOUT_MS = 600_000; // 10 min — wait for all tests to finish

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
  console.log(`Waiting for VS Code CDP on port ${CDP_PORT}...`);
  const cdpDeadline = Date.now() + 120_000;
  while (Date.now() < cdpDeadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) break;
    } catch { /* not ready yet */ }
    await sleep(500);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  console.log("Connected. Waiting for workbench...");

  let page = null;
  const deadline = Date.now() + 30_000;
  while (!page && Date.now() < deadline) {
    page = await getPage(browser);
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("VS Code workbench page not found");
  console.log("Workbench found. Watching for signal files...");

  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const signals = fs.readdirSync(outputDir).filter((f) => f.endsWith(".signal"));
    for (const signal of signals) {
      const filename = signal.replace(/\.signal$/, "");
      const signalPath = path.join(outputDir, signal);
      const outPath = path.join(outputDir, filename);
      console.log(`  [signal] taking screenshot → ${filename}`);
      // Close secondary sidebar (Copilot/Chat panel) if visible
      const secondarySidebar = page.locator(".part.auxiliarybar");
      if (await secondarySidebar.isVisible({ timeout: 500 }).catch(() => false)) {
        await page.keyboard.press("Meta+Alt+b");
        await sleep(400);
      }
      // Dismiss any notifications
      const notification = page.locator(".notifications-toasts");
      if (await notification.isVisible({ timeout: 500 }).catch(() => false)) {
        await page.keyboard.press("Escape");
        await sleep(300);
      }
      // For hover screenshot: wait for the hover widget to actually appear in DOM
      if (filename.includes("hover")) {
        const hoverVisible = await page.locator(".monaco-hover").isVisible({ timeout: 5_000 }).catch(() => false);
        if (!hoverVisible) {
          console.log(`  [warn] hover widget not visible for ${filename}`);
        } else {
          console.log(`  [ok] hover widget confirmed visible`);
        }
      }
      await page.screenshot({ path: outPath, type: "png", fullPage: false });
      fs.unlinkSync(signalPath);
      const kb = Math.round(fs.statSync(outPath).size / 1024);
      console.log(`  [ok] ${filename} (${kb}KB)`);
    }
    await sleep(POLL_MS);
  }

  await browser.close();
}

main().catch((err) => {
  console.error("Sidecar failed:", err.message);
  process.exit(1);
});
