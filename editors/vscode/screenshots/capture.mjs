// Automated screenshot capture for the Forge VS Code extension.
// Launches VS Code as a web server via `code serve-web`, connects
// with Playwright's browser, exercises features, saves screenshots.
//
// Each screenshot has a dedicated capture function that triggers the
// actual feature (completion dropdown, hover tooltip, diagnostics, etc.)
// so the screenshot shows the feature in action — not just plain code.
//
// Usage:
//   node screenshots/capture.mjs [screenshot-name]
//
// Examples:
//   node screenshots/capture.mjs              # capture all screenshots
//   node screenshots/capture.mjs completions  # capture only completions
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

async function saveScreenshot(page, name, description) {
  const filePath = path.join(outputDir, `vscode-${name}.png`);
  await page.screenshot({ path: filePath, type: "png" });
  const stat = fs.statSync(filePath);
  console.log(`  [ok] vscode-${name}.png (${String(Math.round(stat.size / 1024))}KB) - ${description}`);
}

async function openFile(page, filename) {
  const treeItem = page.getByRole("treeitem", { name: filename });
  if (await treeItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await treeItem.dblclick();
  } else {
    // Use quick open as fallback
    await page.keyboard.press("Meta+p");
    await sleep(500);
    await page.keyboard.type(filename, { delay: 30 });
    await sleep(500);
    await page.keyboard.press("Enter");
  }
  await sleep(3000);
}

async function dismissNotifications(page) {
  const clearBtn = page.getByRole("button", { name: /Clear Notification/ });
  while (await clearBtn.first().isVisible({ timeout: 1000 }).catch(() => false)) {
    await clearBtn.first().click();
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// Per-screenshot capture functions
// Each function triggers the actual feature so it's visible in the screenshot.
// ---------------------------------------------------------------------------

async function captureHomepage(page) {
  console.log("  Capturing homepage...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);
  await saveScreenshot(page, "homepage-page", "C# editing overview");
}

async function captureCompletions(page) {
  console.log("  Capturing completions (triggering IntelliSense dropdown)...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);

  // Click at the end of line inside the Add method body to position cursor
  // Find "return a + b;" and click after it, then type on a new line
  await page.keyboard.press("Meta+g");
  await sleep(500);
  await page.keyboard.type("19", { delay: 50 });
  await page.keyboard.press("Enter");
  await sleep(500);

  // Go to end of the line "return a + b;"
  await page.keyboard.press("End");
  await sleep(300);

  // Press Enter to create a new line, type "this." to trigger completions
  await page.keyboard.press("Enter");
  await sleep(300);
  await page.keyboard.type("this.", { delay: 80 });

  // Wait for the completion dropdown to appear
  await sleep(2000);

  // Check if suggest widget is visible
  const suggestWidget = page.locator(".editor-widget.suggest-widget");
  const visible = await suggestWidget.isVisible({ timeout: 5000 }).catch(() => false);
  if (!visible) {
    // Try triggering completions manually with Ctrl+Space
    await page.keyboard.press("Control+Space");
    await sleep(2000);
  }

  await saveScreenshot(page, "completions-page", "IntelliSense completion dropdown visible");

  // Undo all changes to leave the file clean
  await page.keyboard.press("Escape");
  await sleep(200);
  await page.keyboard.press("Meta+z");
  await sleep(200);
  await page.keyboard.press("Meta+z");
  await sleep(200);
  await page.keyboard.press("Meta+z");
  await sleep(200);
}

async function captureDiagnostics(page) {
  console.log("  Capturing diagnostics (introducing an error for squiggles)...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);

  // Go to a line and introduce a type error so Roslyn shows a red squiggle
  await page.keyboard.press("Meta+g");
  await sleep(500);
  await page.keyboard.type("19", { delay: 50 });
  await page.keyboard.press("Enter");
  await sleep(500);
  await page.keyboard.press("End");
  await sleep(300);

  // Add a line with an error: undefined variable reference
  await page.keyboard.press("Enter");
  await sleep(300);
  await page.keyboard.type("            int x = undefinedVariable + notAMethod();", { delay: 30 });
  await sleep(5000); // Wait for diagnostics to appear

  await saveScreenshot(page, "diagnostics-page", "Red squiggly error underlines visible");

  // Undo changes
  await page.keyboard.press("Escape");
  await sleep(200);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Meta+z");
    await sleep(200);
  }
}

async function captureHover(page) {
  console.log("  Capturing hover (showing type tooltip)...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);

  // Hover over a symbol — the Calculator class name or a method
  // Find "public int Add" and hover over "Add"
  await page.keyboard.press("Meta+g");
  await sleep(500);
  await page.keyboard.type("17", { delay: 50 });
  await page.keyboard.press("Enter");
  await sleep(500);

  // Use the editor to find the method name and hover it
  // Position cursor on "Add" in "public int Add(int a, int b)"
  await page.keyboard.press("Home");
  await sleep(200);

  // Find the "Add" text on this line and hover over it
  // Use Ctrl+D or manual positioning to select "Add"
  await page.keyboard.press("Meta+d"); // Select word at cursor
  await sleep(300);

  // Get the editor area and hover over the selection
  const editor = page.locator(".monaco-editor .view-lines");
  const editorBox = await editor.boundingBox();
  if (editorBox) {
    // Hover near line 17 — approximate position
    const lineHeight = editorBox.height / 30; // rough estimate
    const hoverY = editorBox.y + (17 * lineHeight);
    const hoverX = editorBox.x + 250; // roughly where "Add" would be

    // First click to deselect, then hover
    await page.keyboard.press("Escape");
    await sleep(200);
    await page.mouse.move(hoverX, hoverY);
    await sleep(3000); // Wait for hover tooltip to appear
  }

  await saveScreenshot(page, "hover-page", "Hover tooltip with type info visible");
}

async function captureGoToDefinition(page) {
  console.log("  Capturing go-to-definition (peek definition view)...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);

  // Go to a symbol usage and trigger peek definition
  // Go to line with "throw new System.DivideByZeroException()"
  await page.keyboard.press("Meta+g");
  await sleep(500);
  await page.keyboard.type("31", { delay: 50 });
  await page.keyboard.press("Enter");
  await sleep(500);

  // Position cursor on "DivideByZeroException"
  await page.keyboard.press("Home");
  await sleep(200);

  // Find and click on the exception name
  const editor = page.locator(".monaco-editor .view-lines");
  const editorBox = await editor.boundingBox();
  if (editorBox) {
    const lineHeight = editorBox.height / 30;
    const clickY = editorBox.y + (31 * lineHeight);
    const clickX = editorBox.x + 350;
    await page.mouse.click(clickX, clickY);
    await sleep(500);
  }

  // Trigger Peek Definition (Alt+F12)
  await page.keyboard.press("Alt+F12");
  await sleep(3000);

  await saveScreenshot(page, "go-to-definition-page", "Peek definition overlay visible");

  // Close peek
  await page.keyboard.press("Escape");
  await sleep(500);
}

async function captureProfiler(page) {
  console.log("  Capturing profiler (Forge sidebar panel)...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);

  // Switch to the Forge sidebar to show the Profiler panel
  const forgeTab = page.getByRole("tab", { name: "Forge" });
  if (await forgeTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await forgeTab.click();
    await sleep(1000);
  }
  const profilerSection = page.getByRole("treeitem", { name: /Profiler/i });
  if (await profilerSection.isVisible({ timeout: 3000 }).catch(() => false)) {
    await profilerSection.click();
    await sleep(2000);
  }

  await saveScreenshot(page, "profiler-page", "Profiler tree view with .NET processes");
}

// ---------------------------------------------------------------------------
// Screenshot registry — maps names to capture functions
// ---------------------------------------------------------------------------

const SCREENSHOTS = {
  "homepage":        captureHomepage,
  "completions":     captureCompletions,
  "diagnostics":     captureDiagnostics,
  "hover":           captureHover,
  "go-to-definition": captureGoToDefinition,
  "profiler":        captureProfiler,
};

async function main() {
  const filter = process.argv[2] ?? null;

  if (filter && !SCREENSHOTS[filter]) {
    console.error(`Unknown screenshot: "${filter}"`);
    console.error(`Available: ${Object.keys(SCREENSHOTS).join(", ")}`);
    process.exit(1);
  }

  console.log(`Extension:  ${extensionPath}`);
  console.log(`Workspace:  ${workspacePath}`);
  console.log(`Output:     ${outputDir}`);
  console.log("");

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

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: "dark",
    });
    const page = await context.newPage();

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

    await dismissNotifications(page);

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

    // Run selected or all capture functions
    const toCapture = filter
      ? [[filter, SCREENSHOTS[filter]]]
      : Object.entries(SCREENSHOTS);

    for (const [name, captureFn] of toCapture) {
      try {
        await captureFn(page);
      } catch (err) {
        console.error(`  [FAIL] ${name}: ${err.message}`);
      }
    }

    console.log("\nDone! Screenshots saved to website/src/assets/screenshots/");

    const files = fs.readdirSync(outputDir)
      .filter((f) => f.startsWith("vscode-") && f.endsWith(".png"));
    console.log(`\nVS Code screenshots (${String(files.length)}):`);
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
