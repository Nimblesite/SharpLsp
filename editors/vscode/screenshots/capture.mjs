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
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extensionPath, "../..");
const workspacePath = path.resolve(extensionPath, "test-fixtures/workspace");
const outputDir = path.resolve(
  __dirname,
  "../../../website/src/assets/screenshots",
);
const vsixPath = path.resolve(extensionPath, "forge-0.1.0.vsix");
const forgeBinary = path.resolve(repoRoot, "target/release/forge-lsp");

const PORT = 9876;
const LAUNCH_TIMEOUT_MS = 60_000;

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

async function saveScreenshot(page, name, description, rawName = false) {
  const filename = rawName ? `${name}.png` : `vscode-${name}.png`;
  const filePath = path.join(outputDir, filename);
  await page.screenshot({ path: filePath, type: "png" });
  const stat = fs.statSync(filePath);
  console.log(`  [ok] ${filename} (${String(Math.round(stat.size / 1024))}KB) - ${description}`);
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

  // Find the text "Calculator" in the editor view and hover over it
  // Try multiple approaches to trigger hover tooltip

  // Approach 1: Find a visible code token and mouse hover over it
  const viewLines = page.locator(".view-lines");
  const lineElements = viewLines.locator(".view-line");
  const lineCount = await lineElements.count();
  console.log(`    Found ${String(lineCount)} visible lines`);

  // Find line containing "public class Calculator"
  let targetLine = null;
  for (let i = 0; i < lineCount; i++) {
    const text = await lineElements.nth(i).textContent().catch(() => "");
    if (text.includes("Calculator") && text.includes("class")) {
      targetLine = lineElements.nth(i);
      console.log(`    Found "class Calculator" at visible line ${String(i)}`);
      break;
    }
  }

  if (targetLine) {
    // Find the "Calculator" span within this line
    const calcSpan = targetLine.locator("span", { hasText: "Calculator" }).first();
    if (await calcSpan.isVisible({ timeout: 2000 }).catch(() => false)) {
      const box = await calcSpan.boundingBox();
      if (box) {
        console.log(`    Hovering over Calculator at (${String(Math.round(box.x + box.width / 2))}, ${String(Math.round(box.y + box.height / 2))})`);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(5000);
      }
    }
  }

  // Check if hover widget appeared
  const hoverWidget = page.locator(".monaco-hover");
  const hoverVisible = await hoverWidget.isVisible({ timeout: 2000 }).catch(() => false);
  console.log(`    Hover widget visible: ${String(hoverVisible)}`);

  if (!hoverVisible) {
    // Fallback: try command palette "Show or Focus Hover"
    console.log("    Trying command palette fallback...");
    await page.keyboard.press("Meta+Shift+p");
    await sleep(500);
    await page.keyboard.type("Show or Focus Hover", { delay: 30 });
    await sleep(500);
    await page.keyboard.press("Enter");
    await sleep(3000);
  }

  await saveScreenshot(page, "hover-page", "Hover tooltip with type info visible");
}

async function captureGoToDefinition(page) {
  console.log("  Capturing go-to-definition (peek definition view)...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);

  // Go to line 31: "throw new System.DivideByZeroException()"
  await page.keyboard.press("Meta+g");
  await sleep(500);
  await page.keyboard.type("31", { delay: 50 });
  await page.keyboard.press("Enter");
  await sleep(1000);

  // Find "DivideByZeroException" and position cursor on it
  await page.keyboard.press("Meta+f");
  await sleep(500);
  await page.keyboard.type("DivideByZeroException", { delay: 20 });
  await sleep(500);
  await page.keyboard.press("Escape"); // Close find, cursor on match
  await sleep(500);

  // Trigger Peek Definition via command palette
  await page.keyboard.press("Meta+Shift+p");
  await sleep(800);
  await page.keyboard.type("Peek Definition", { delay: 30 });
  await sleep(800);
  await page.keyboard.press("Enter");
  await sleep(5000); // Wait for LSP to resolve and render peek

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
// Homepage showcase capture functions
// These produce the images for the main website homepage grid.
// ---------------------------------------------------------------------------


async function captureSolutionExplorer(page) {
  console.log("  Capturing solution-explorer (Forge Solution Explorer tree)...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);

  // Click the Forge icon in the activity bar to open Solution Explorer
  const forgeTab = page.getByRole("tab", { name: "Forge" });
  if (await forgeTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await forgeTab.click();
    await sleep(2000);
  } else {
    console.log("    Forge tab not found, trying command palette...");
    await page.keyboard.press("Meta+Shift+p");
    await sleep(500);
    await page.keyboard.type("Forge: Focus on Solution Explorer", { delay: 30 });
    await sleep(500);
    await page.keyboard.press("Enter");
    await sleep(2000);
  }

  await saveScreenshot(page, "solution-explorer", "Forge Solution Explorer tree view", true);
}

async function captureEditorOverview(page) {
  console.log("  Capturing editor-overview (outline + symbols)...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);

  // Open the Outline panel in the sidebar to show document symbols
  await page.keyboard.press("Meta+Shift+p");
  await sleep(500);
  await page.keyboard.type("Focus on Outline View", { delay: 30 });
  await sleep(500);
  await page.keyboard.press("Enter");
  await sleep(2000);

  await saveScreenshot(page, "editor-overview", "Editor with Outline showing symbols", true);
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
  "solution-explorer": captureSolutionExplorer,
  "editor-overview": captureEditorOverview,
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
  console.log(`VSIX:       ${vsixPath}`);
  console.log(`Forge LSP:  ${forgeBinary}`);
  console.log("");

  // Install the Forge VSIX into the serve-web extensions directory
  const serverExtDir = path.join(
    process.env.HOME ?? "",
    ".vscode-server",
    "extensions",
  );
  if (fs.existsSync(vsixPath)) {
    console.log("Installing Forge VSIX extension...");
    try {
      // Install to desktop VS Code (shared extensions)
      execSync(`code --install-extension "${vsixPath}" --force 2>&1`, { encoding: "utf8" });
      console.log("  Installed to desktop VS Code.");
      // Also install to the serve-web extensions directory
      execSync(
        `code --install-extension "${vsixPath}" --force --extensions-dir "${serverExtDir}" 2>&1`,
        { encoding: "utf8" },
      );
      console.log(`  Installed to serve-web: ${serverExtDir}`);
    } catch (err) {
      console.warn(`  Extension install warning: ${err.message}`);
    }
  } else {
    console.warn("  VSIX not found — feature screenshots may not show LSP features.");
  }

  // Write workspace settings to point to the forge-lsp binary
  const settingsDir = path.join(workspacePath, ".vscode");
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, "settings.json");
  const settings = {
    "forge.server.path": forgeBinary,
    "forge.trace.server": "off",
    "workbench.colorTheme": "Default Dark Modern",
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`  Workspace settings written: forge.server.path = ${forgeBinary}`);

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
    // Wait for the workbench to fully load (not just chat widget monaco-editor)
    await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
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

    // Open a C# file first to trigger Forge extension activation,
    // then wait for the LSP sidecar to load the workspace
    console.log("Activating Forge extension...");
    await openFile(page, "Calculator.cs");
    await sleep(3000);
    await dismissNotifications(page);

    // Check if Forge extension loaded by looking for status bar item
    const forgeStatus = page.locator(".statusbar-item", { hasText: "Forge" });
    const forgeActive = await forgeStatus.isVisible({ timeout: 5000 }).catch(() => false);
    console.log(`  Forge extension active: ${String(forgeActive)}`);

    // Wait for Forge LSP sidecar to load the workspace
    console.log("  Waiting for LSP sidecar to initialize (30s)...");
    await sleep(30000);
    await dismissNotifications(page);

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
