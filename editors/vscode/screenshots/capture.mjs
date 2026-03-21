// Automated screenshot capture for the Forge VS Code extension.
// Launches VS Code as a web server via `code serve-web`, connects
// with Playwright's browser, exercises features, saves screenshots.
//
// Usage:
//   node screenshots/capture.mjs
//
// Prerequisites: playwright installed (npm i playwright)

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "..");
const workspacePath = path.resolve(extensionPath, "test-fixtures/workspace");
const outputDir = path.resolve(
  __dirname,
  "../../../website/src/assets/screenshots",
);

const PORT = 9876;
const LAUNCH_TIMEOUT_MS = 30_000;

fs.mkdirSync(outputDir, { recursive: true });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(PORT)}`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await sleep(1000);
  }
  throw new Error("VS Code web server did not start");
}

async function captureScreenshot(page, name, description) {
  const filePath = path.join(outputDir, `${name}.png`);
  await page.screenshot({ path: filePath, type: "png" });
  console.log(`  [ok] ${name}.png - ${description}`);
}

async function main() {
  console.log(`Extension:  ${extensionPath}`);
  console.log(`Workspace:  ${workspacePath}`);
  console.log(`Output:     ${outputDir}`);
  console.log("");

  // Launch VS Code as a web server
  console.log("Starting VS Code web server...");
  const serverProcess = spawn("code", [
    "serve-web",
    "--without-connection-token",
    "--accept-server-license-terms",
    "--host", "127.0.0.1",
    "--port", String(PORT),
  ], { stdio: "pipe" });

  let exited = false;
  serverProcess.on("exit", () => { exited = true; });

  try {
    await waitForServer(LAUNCH_TIMEOUT_MS);
    console.log(`VS Code web running on http://127.0.0.1:${String(PORT)}`);

    // Launch headless browser
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: "dark",
    });
    const page = await context.newPage();

    // Navigate and open workspace
    const wsUrl = `http://127.0.0.1:${String(PORT)}/?folder=${encodeURIComponent(workspacePath)}`;
    console.log("Opening workspace...");
    await page.goto(wsUrl);
    await page.waitForSelector(".monaco-editor", { timeout: 30_000 });
    await sleep(5000);

    // Trust the workspace if prompted
    const trustBtn = page.getByRole("button", { name: "Yes, I trust the authors" });
    if (await trustBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await trustBtn.click();
      await sleep(3000);
    }

    // Dismiss notifications
    const clearBtn = page.getByRole("button", { name: /Clear Notification/ });
    while (await clearBtn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await clearBtn.first().click();
      await sleep(500);
    }

    // Switch to dark theme
    console.log("Setting dark theme...");
    await page.keyboard.press("Meta+Shift+p");
    await sleep(800);
    await page.keyboard.type("Color Theme", { delay: 50 });
    await sleep(800);
    const darkModern = page.getByRole("option", { name: /Dark Modern/ });
    if (await darkModern.isVisible({ timeout: 2000 }).catch(() => false)) {
      await darkModern.click();
      await sleep(1000);
    } else {
      await page.keyboard.press("Escape");
    }

    // Hide secondary sidebar (chat)
    const toggleSecondary = page.getByRole("button", {
      name: /Toggle Secondary Side Bar/,
    });
    if (await toggleSecondary.isVisible({ timeout: 1000 }).catch(() => false)) {
      const pressed = await toggleSecondary.getAttribute("aria-pressed");
      if (pressed === "true") {
        await toggleSecondary.click();
        await sleep(500);
      }
    }

    console.log("Capturing screenshots...\n");

    // 1. Calculator.cs - C# editing
    await page.getByRole("treeitem", { name: "Calculator.cs" }).dblclick();
    await sleep(3000);
    await captureScreenshot(page, "editor-overview", "C# editing with syntax highlighting");

    // 2. Greeter.fs - F# editing
    await page.getByRole("treeitem", { name: "Greeter.fs" }).dblclick();
    await sleep(3000);
    await captureScreenshot(page, "fsharp-editing", "F# editing with syntax highlighting");

    // 3. Nested.cs - nested classes
    await page.getByRole("treeitem", { name: "Nested.cs" }).dblclick();
    await sleep(3000);
    await captureScreenshot(page, "nested-classes", "Nested class hierarchy");

    console.log("\nDone! Screenshots saved to website/src/assets/screenshots/");

    // List results
    const files = fs.readdirSync(outputDir).filter((f) => f.endsWith(".png"));
    console.log(`\nCaptured ${String(files.length)} screenshots:`);
    for (const f of files) {
      const stat = fs.statSync(path.join(outputDir, f));
      console.log(`  ${f} (${String(Math.round(stat.size / 1024))}KB)`);
    }

    await browser.close();
  } finally {
    if (!exited) {
      serverProcess.kill("SIGTERM");
      await sleep(1000);
      if (!exited) serverProcess.kill("SIGKILL");
    }
  }
}

main().catch((err) => {
  console.error("Screenshot capture failed:", err.message);
  process.exit(1);
});
