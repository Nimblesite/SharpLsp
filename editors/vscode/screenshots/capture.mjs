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

async function closeBrowser(browser) {
  if (!browser) return;
  await Promise.race([
    browser.close(),
    sleep(3000),
  ]).catch(() => undefined);
}

async function stopProcess(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await sleep(1000);
  if (processHandle.exitCode === null) {
    processHandle.kill("SIGKILL");
  }
}

async function commandPalette(page, command) {
  await page.keyboard.press("Meta+Shift+p");
  await sleep(500);
  await page.keyboard.type(command, { delay: 20 });
  await sleep(500);
  await page.keyboard.press("Enter");
  await sleep(1500);
}

async function goToLine(page, line) {
  await page.keyboard.press("Control+g");
  await sleep(300);
  await page.keyboard.type(String(line), { delay: 20 });
  await page.keyboard.press("Enter");
  await sleep(500);
}

async function openFile(page, filename) {
  await page.keyboard.press("Meta+p");
  await sleep(500);
  await page.keyboard.type(filename, { delay: 20 });
  await sleep(500);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 30_000 });
  await sleep(2000);
}

async function revertActiveFile(page) {
  await commandPalette(page, "File: Revert File");
  await sleep(500);
  await page.keyboard.press("Escape");
}

async function dismissNotifications(page) {
  await commandPalette(page, "Notifications: Clear All Notifications");
  const clearButton = page.getByRole("button", { name: /Clear Notification/ });
  while (await clearButton.first().isVisible({ timeout: 500 }).catch(() => false)) {
    await clearButton.first().click();
    await sleep(300);
  }
  const closeButton = page.getByRole("button", { name: /Close Notification/ });
  while (await closeButton.first().isVisible({ timeout: 500 }).catch(() => false)) {
    await closeButton.first().click();
    await sleep(300);
  }
}

async function closePanelIfOpen(page) {
  const panel = page.locator(".part.panel");
  if (await panel.isVisible({ timeout: 500 }).catch(() => false)) {
    await commandPalette(page, "View: Toggle Panel Visibility");
  }
}

async function closeSecondarySidebarIfOpen(page) {
  const secondarySidebar = page.locator(".part.auxiliarybar");
  if (await secondarySidebar.isVisible({ timeout: 500 }).catch(() => false)) {
    await commandPalette(page, "View: Toggle Secondary Side Bar Visibility");
    return;
  }

  const closeButton = page.getByRole("button", { name: /Close Secondary Side Bar/i });
  if (await closeButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await closeButton.click();
    await sleep(500);
  }
}

async function cleanWorkbench(page) {
  await dismissNotifications(page);
  await closePanelIfOpen(page);
  await closeSecondarySidebarIfOpen(page);
}

async function resetWorkbench(page) {
  await commandPalette(page, "View: Single Column Editor Layout");
  await commandPalette(page, "View: Reset View Locations");
  await commandPalette(page, "File: Close All Editors");
  await cleanWorkbench(page);
}

async function openTerminalWithCommand(page, command) {
  await commandPalette(page, "Terminal: Create New Terminal");
  await sleep(1500);
  await page.keyboard.type(command, { delay: 5 });
  await page.keyboard.press("Enter");
  await sleep(2000);
}

async function setDarkTheme(page) {
  await commandPalette(page, "Preferences: Color Theme");
  const darkModern = page.getByRole("option", { name: /Dark Modern/ });
  if (await darkModern.isVisible({ timeout: 2000 }).catch(() => false)) {
    await darkModern.click();
    await sleep(1000);
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

async function captureGettingStarted(page) {
  console.log("  Capturing getting-started...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);
  await openTerminalWithCommand(page, `"${forgeBinary}" --version`);
  await saveScreenshot(page, "vscode-getting-started-page", "Forge active in VS Code", true);
}

async function captureHomepage(page) {
  console.log("  Capturing homepage...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);
  await saveScreenshot(page, "homepage-page", "C# editing overview");
}

async function captureArchitecture(page) {
  console.log("  Capturing architecture...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);
  await commandPalette(page, "Forge: Show Output");
  await sleep(1500);
  await saveScreenshot(page, "vscode-architecture-page", "Forge output and editor", true);
}

async function captureEditors(page) {
  console.log("  Capturing editors...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);
  await commandPalette(page, "View: Split Editor Right");
  await openFile(page, "Greeter.fs");
  await saveScreenshot(page, "vscode-editors-page", "C# and F# editor support", true);
}

async function captureConfiguration(page) {
  console.log("  Capturing configuration...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);
  await commandPalette(page, "Preferences: Open Settings (UI)");
  await sleep(1500);
  await page.keyboard.type("forge", { delay: 20 });
  await sleep(1500);
  await saveScreenshot(page, "vscode-configuration-page", "Forge settings UI", true);
}

async function captureCompletions(page) {
  console.log("  Capturing completions...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await revertActiveFile(page);
  await cleanWorkbench(page);

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
  console.log("  Capturing diagnostics...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await revertActiveFile(page);
  await cleanWorkbench(page);

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
  console.log("  Capturing hover...");
  await resetWorkbench(page);
  await openFile(page, "HoverXmlDoc.cs");
  await cleanWorkbench(page);

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
  console.log("  Capturing go-to-definition...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);

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
  console.log("  Capturing profiler...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);
  await commandPalette(page, "Forge: Refresh Profiler");
  await sleep(3000);
  await saveScreenshot(page, "profiler-page", "profiler view");
}

async function captureSplitEditor(page) {
  console.log("  Capturing split-editor...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);
  await commandPalette(page, "View: Split Editor Right");
  await openFile(page, "Greeter.fs");
  await saveScreenshot(page, "split-editor", "C# and F# split editor", true);
}

async function captureSolutionExplorer(page) {
  console.log("  Capturing solution-explorer...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);
  await commandPalette(page, "Forge: Focus on Solution Explorer");
  await sleep(3000);
  await saveScreenshot(page, "solution-explorer", "Solution Explorer tree", true);
}

async function captureEditorOverview(page) {
  console.log("  Capturing editor-overview...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);
  await commandPalette(page, "Focus on Outline View");
  await sleep(2000);

  await saveScreenshot(page, "editor-overview", "Editor with Outline showing symbols", true);
}

async function captureCodeFolding(page) {
  console.log("  Capturing code-folding...");
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await cleanWorkbench(page);
  await commandPalette(page, "Fold All Regions");
  await sleep(1000);
  await saveScreenshot(page, "code-folding", "Folded C# regions", true);
}

async function captureNestedClasses(page) {
  console.log("  Capturing nested-classes...");
  await resetWorkbench(page);
  await openFile(page, "Nested.cs");
  await cleanWorkbench(page);
  await commandPalette(page, "Focus on Outline View");
  await sleep(2000);
  await saveScreenshot(page, "nested-classes", "Nested class hierarchy", true);
}

const SCREENSHOTS = {
  homepage: captureHomepage,
  "getting-started": captureGettingStarted,
  architecture: captureArchitecture,
  editors: captureEditors,
  configuration: captureConfiguration,
  completions: captureCompletions,
  diagnostics: captureDiagnostics,
  hover: captureHover,
  "go-to-definition": captureGoToDefinition,
  profiler: captureProfiler,
  "split-editor": captureSplitEditor,
  "solution-explorer": captureSolutionExplorer,
  "editor-overview": captureEditorOverview,
  "code-folding": captureCodeFolding,
  "nested-classes": captureNestedClasses,
};

function launchCode(codeCli, userDataDir, extensionsDir) {
  const args = [
    workspacePath,
    "--new-window",
    "--reuse-window=false",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-telemetry",
    "--disable-updates",
    "--extensions-dir",
    extensionsDir,
    "--user-data-dir",
    userDataDir,
    `--remote-debugging-port=${String(DEBUG_PORT)}`,
    "--disable-restore-windows",
  ];

  return spawn(codeCli, args, {
    stdio: "pipe",
    env: {
      ...process.env,
      FORGE_EXECUTABLE_PATH: forgeBinary,
      PATH: `${path.dirname(forgeBinary)}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

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

  installVsix(codeCli, extensionsDir, userDataDir);
  console.log("Launching VS Code Electron...");
  const codeProcess = launchCode(codeCli, userDataDir, extensionsDir);
  let browser;

  try {
    await waitForDebugEndpoint(LAUNCH_TIMEOUT_MS);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(DEBUG_PORT)}`);
    const page = await waitForWorkbench(browser);
    await page.setViewportSize({ width: 1280, height: 800 });
    await setDarkTheme(page);
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

  } finally {
    await closeBrowser(browser);
    await stopProcess(codeProcess);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Screenshot capture failed:", err.message);
  process.exit(1);
});
