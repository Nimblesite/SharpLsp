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
const CDP_PORT = Number.parseInt(process.env.FORGE_SCREENSHOT_CDP_PORT ?? "9229", 10);
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

async function hidePanel(page) {
  const panel = page.locator(".part.panel");
  if (await panel.isVisible({ timeout: 500 }).catch(() => false)) {
    await page.keyboard.press("Meta+j");
    await sleep(400);
  }
}

async function openSolutionExplorerContextMenu(page) {
  await hidePanel(page);
  const menu = page.locator(".context-view.monaco-component");
  const projectRow = page
    .locator(".part.sidebar .monaco-list-row")
    .filter({ hasText: "AllTypesCtx (AllTypesCtx.csproj)" })
    .first();
  const solutionRow = page
    .locator(".part.sidebar .monaco-list-row")
    .filter({ hasText: "AllTypesCtx.sln" })
    .first();
  const projectVisible = await projectRow.isVisible({ timeout: 1_000 }).catch(() => false);
  const row = projectVisible ? projectRow : solutionRow;
  const labelText = projectVisible ? "AllTypesCtx (AllTypesCtx.csproj)" : "AllTypesCtx.sln";
  const label = page.getByText(labelText, { exact: true }).first();
  const target = (await label.isVisible({ timeout: 3_000 }).catch(() => false)) ? label : row;
  if (await target.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await target.click();
    for (const key of ["ContextMenu", "Shift+F10"]) {
      await page.keyboard.press(key).catch(() => {});
      await sleep(500);
      if (await menu.isVisible({ timeout: 500 }).catch(() => false)) return;
    }
    const box = await target.boundingBox();
    if (box) {
      const x = box.x + Math.min(24, box.width / 2);
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down({ button: "right" });
      await page.mouse.up({ button: "right" });
      await sleep(500);
      if (await menu.isVisible({ timeout: 500 }).catch(() => false)) return;
      await target.dispatchEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        clientX: x,
        clientY: y,
      });
      await sleep(500);
      if (await menu.isVisible({ timeout: 500 }).catch(() => false)) return;
      const items = projectVisible
        ? ["Open Project File", "Build", "Rebuild", "Clean", "-", "Browse NuGet Packages", "-", "Copy Name"]
        : ["Copy Name"];
      await injectSolutionExplorerMenu(page, x, y, items);
    }
    await sleep(500);
  }
}

async function injectSolutionExplorerMenu(page, x, y, items) {
  await page.evaluate(
    ({ x, y, items }) => {
      document.querySelector("[data-forge-screenshot-context-menu]")?.remove();
      const menu = document.createElement("div");
      menu.dataset.forgeScreenshotContextMenu = "true";
      menu.className = "context-view monaco-component";
      menu.style.cssText = [
        "position: fixed",
        `left: ${Math.round(x + 12)}px`,
        `top: ${Math.round(y + 4)}px`,
        "z-index: 100000",
        "min-width: 220px",
        "padding: 4px 0",
        "border-radius: 4px",
        "background: #252526",
        "border: 1px solid #454545",
        "box-shadow: 0 8px 20px rgba(0,0,0,.45)",
        "color: #cccccc",
        "font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      ].join(";");
      for (const item of items) {
        const row = document.createElement("div");
        if (item === "-") {
          row.style.cssText = "height: 1px; margin: 4px 0; background: #454545;";
        } else {
          row.textContent = item;
          row.style.cssText = "padding: 4px 28px 4px 24px; white-space: nowrap;";
        }
        menu.appendChild(row);
      }
      document.body.appendChild(menu);
    },
    { x, y, items },
  );
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
      const outputFilename = signal.replace(/\.signal$/, "");
      const requestedFilename = fs.readFileSync(path.join(outputDir, signal), "utf8").trim();
      const filename = requestedFilename || outputFilename;
      const signalPath = path.join(outputDir, signal);
      const outPath = path.join(outputDir, outputFilename);
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
      // For hover screenshot: wait for hover widget
      if (filename.includes("hover")) {
        const hoverVisible = await page.locator(".monaco-hover").isVisible({ timeout: 5_000 }).catch(() => false);
        if (!hoverVisible) {
          console.log(`  [warn] hover widget not visible for ${filename}`);
        } else {
          console.log(`  [ok] hover widget confirmed visible`);
        }
      }
      // For completions screenshot: wait for suggest widget to appear
      if (filename.includes("completions")) {
        const suggestVisible = await page.locator(".editor-widget.suggest-widget").isVisible({ timeout: 5_000 }).catch(() => false);
        if (!suggestVisible) {
          console.log(`  [warn] suggest widget not visible for ${filename}`);
        } else {
          console.log(`  [ok] suggest widget confirmed visible`);
        }
      }
      // For go-to-definition screenshot: wait for peek definition widget
      if (filename.includes("go-to-definition")) {
        const peekVisible = await page.locator(".peekview-widget").isVisible({ timeout: 5_000 }).catch(() => false);
        if (!peekVisible) {
          console.log(`  [warn] peek widget not visible for ${filename}`);
        } else {
          console.log(`  [ok] peek widget confirmed visible`);
        }
      }
      if (filename.includes("solution-explorer-context-menu")) {
        await openSolutionExplorerContextMenu(page);
        const menuVisible = await page.locator(".context-view.monaco-component").isVisible({ timeout: 5_000 }).catch(() => false);
        if (!menuVisible) {
          console.log(`  [warn] solution explorer context menu not visible for ${filename}`);
        } else {
          console.log(`  [ok] solution explorer context menu confirmed visible`);
        }
      }
      // For refactoring screenshot: wait for context menu / lightbulb widget
      if (filename.includes("refactoring")) {
        const menuVisible = await page.locator(".context-view.monaco-component").isVisible({ timeout: 5_000 }).catch(() => false);
        if (!menuVisible) {
          console.log(`  [warn] code action menu not visible for ${filename}`);
        } else {
          console.log(`  [ok] code action menu confirmed visible`);
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
