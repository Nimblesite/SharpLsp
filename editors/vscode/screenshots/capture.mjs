// Screenshot capture for the Forge VS Code extension.
//
// This launches the real desktop VS Code Electron app with Forge installed in
// an isolated extension directory, then attaches Playwright through Chromium's
// remote debugging endpoint. It intentionally uses the same desktop runtime as
// the VS Code extension tests, not `code serve-web`.

import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extensionPath, "../..");
const workspacePath = path.resolve(extensionPath, "test-fixtures/workspace");
const outputDir = path.resolve(repoRoot, "website/src/assets/screenshots");
const vsixPath = path.resolve(repoRoot, "forge.vsix");
const forgeBinary = path.resolve(repoRoot, "target/release/forge-lsp");

const DEBUG_PORT = Number(process.env.VSCODE_DEBUG_PORT ?? String(49_000 + Math.floor(Math.random() * 1000)));
const LAUNCH_TIMEOUT_MS = 60_000;

fs.mkdirSync(outputDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findCodeCli() {
  if (process.env.VSCODE_CLI && fs.existsSync(process.env.VSCODE_CLI)) {
    return process.env.VSCODE_CLI;
  }
  return "code";
}

function installVsix(codeCli, extensionsDir, userDataDir) {
  if (!fs.existsSync(vsixPath)) {
    throw new Error(`VSIX not found at ${vsixPath}. Run make _build-vsix first.`);
  }

  execFileSync(
    codeCli,
    [
      "--install-extension",
      vsixPath,
      "--force",
      "--extensions-dir",
      extensionsDir,
      "--user-data-dir",
      userDataDir,
    ],
    { stdio: "inherit" },
  );
}

async function waitForDebugEndpoint(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/version`);
      if (response.ok) return;
    } catch {
      // VS Code has not opened the debugging endpoint yet.
    }
    await sleep(500);
  }
  throw new Error("VS Code Electron debugging endpoint did not start");
}

async function waitForWorkbench(browser) {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const workbench = page.locator(".monaco-workbench");
        if (await workbench.isVisible({ timeout: 500 }).catch(() => false)) {
          return page;
        }
      }
    }
    await sleep(500);
  }
  throw new Error("VS Code workbench did not become visible");
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
  const clearButton = page.getByRole("button", { name: /Clear Notification/ });
  while (await clearButton.first().isVisible({ timeout: 500 }).catch(() => false)) {
    await clearButton.first().click();
    await sleep(300);
  }
}

async function setDarkTheme(page) {
  await commandPalette(page, "Preferences: Color Theme");
  const darkModern = page.getByRole("option", { name: /Dark Modern/ });
  if (await darkModern.isVisible({ timeout: 2000 }).catch(() => false)) {
    await darkModern.click();
    await sleep(1000);
  } else {
    await page.keyboard.press("Escape");
  }
}

async function waitForForge(page) {
  await openFile(page, "Calculator.cs");
  const statusItem = page.locator(".statusbar-item", { hasText: "Forge" });
  const visible = await statusItem.isVisible({ timeout: 30_000 }).catch(() => false);
  if (!visible) {
    throw new Error("Forge status bar item did not appear");
  }
  await sleep(10_000);
}

async function saveScreenshot(page, name, description, rawName = false) {
  const filename = rawName ? `${name}.png` : `vscode-${name}.png`;
  const filePath = path.join(outputDir, filename);
  await page.screenshot({ path: filePath, type: "png", fullPage: false });
  const stat = fs.statSync(filePath);
  console.log(`  [ok] ${filename} (${String(Math.round(stat.size / 1024))}KB) - ${description}`);
}

async function captureHomepage(page) {
  console.log("  Capturing homepage...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);
  await saveScreenshot(page, "homepage-page", "C# editing overview");
}

async function captureCompletions(page) {
  console.log("  Capturing completions...");
  await openFile(page, "Calculator.cs");
  await revertActiveFile(page);
  await dismissNotifications(page);

  await goToLine(page, 19);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("            this.", { delay: 40 });
  await sleep(2000);

  const suggestWidget = page.locator(".editor-widget.suggest-widget");
  if (!await suggestWidget.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.keyboard.press("Control+Space");
    await sleep(2000);
  }

  await saveScreenshot(page, "completions-page", "IntelliSense dropdown");
  await page.keyboard.press("Escape");
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Meta+z");
    await sleep(150);
  }
}

async function captureDiagnostics(page) {
  console.log("  Capturing diagnostics...");
  await openFile(page, "Calculator.cs");
  await revertActiveFile(page);
  await dismissNotifications(page);

  await goToLine(page, 19);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("            int x = undefinedVariable + notAMethod();", { delay: 20 });
  await sleep(8000);

  await saveScreenshot(page, "diagnostics-page", "diagnostic squiggles");
  await page.keyboard.press("Escape");
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("Meta+z");
    await sleep(150);
  }
}

async function captureHover(page) {
  console.log("  Capturing hover...");
  await openFile(page, "HoverXmlDoc.cs");
  await dismissNotifications(page);

  await page.keyboard.press("Meta+f");
  await page.keyboard.type("Factorial", { delay: 20 });
  await page.keyboard.press("Escape");
  await sleep(500);
  await commandPalette(page, "Show or Focus Hover");

  await saveScreenshot(page, "hover-page", "hover tooltip");
}

async function captureGoToDefinition(page) {
  console.log("  Capturing go-to-definition...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);

  await page.keyboard.press("Meta+f");
  await page.keyboard.type("DivideByZeroException", { delay: 20 });
  await page.keyboard.press("Escape");
  await sleep(500);
  await commandPalette(page, "Peek Definition");
  await sleep(3000);

  await saveScreenshot(page, "go-to-definition-page", "peek definition");
  await page.keyboard.press("Escape");
}

async function captureProfiler(page) {
  console.log("  Capturing profiler...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);
  await commandPalette(page, "Forge: Refresh Profiler");
  await sleep(3000);
  await saveScreenshot(page, "profiler-page", "profiler view");
}

async function captureSolutionExplorer(page) {
  console.log("  Capturing solution-explorer...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);
  await commandPalette(page, "Forge: Focus on Solution Explorer");
  await sleep(3000);
  await saveScreenshot(page, "solution-explorer", "Solution Explorer tree", true);
}

async function captureEditorOverview(page) {
  console.log("  Capturing editor-overview...");
  await openFile(page, "Calculator.cs");
  await dismissNotifications(page);
  await commandPalette(page, "Focus on Outline View");
  await sleep(2000);
  await saveScreenshot(page, "editor-overview", "Outline with symbols", true);
}

const SCREENSHOTS = {
  homepage: captureHomepage,
  completions: captureCompletions,
  diagnostics: captureDiagnostics,
  hover: captureHover,
  "go-to-definition": captureGoToDefinition,
  profiler: captureProfiler,
  "solution-explorer": captureSolutionExplorer,
  "editor-overview": captureEditorOverview,
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
    "--wait",
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
    throw new Error(`Unknown screenshot "${filter}". Available: ${Object.keys(SCREENSHOTS).join(", ")}`);
  }
  if (!fs.existsSync(forgeBinary)) {
    throw new Error(`Forge binary not found at ${forgeBinary}. Run make _build-rust first.`);
  }

  const codeCli = findCodeCli();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vscode-screens-"));
  const userDataDir = path.join(tempRoot, "user-data");
  const extensionsDir = path.join(tempRoot, "extensions");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });

  console.log(`Extension:  ${extensionPath}`);
  console.log(`Workspace:  ${workspacePath}`);
  console.log(`Output:     ${outputDir}`);
  console.log(`VSIX:       ${vsixPath}`);
  console.log(`Forge LSP:  ${forgeBinary}`);
  console.log(`Code CLI:   ${codeCli}`);
  console.log("");

  installVsix(codeCli, extensionsDir, userDataDir);
  console.log("Launching VS Code Electron...");
  const codeProcess = launchCode(codeCli, userDataDir, extensionsDir);
  let exited = false;
  codeProcess.on("exit", () => {
    exited = true;
  });

  try {
    await waitForDebugEndpoint(LAUNCH_TIMEOUT_MS);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(DEBUG_PORT)}`);
    const page = await waitForWorkbench(browser);
    await page.setViewportSize({ width: 1280, height: 800 });
    await setDarkTheme(page);
    await dismissNotifications(page);
    await waitForForge(page);

    const toCapture = filter
      ? [[filter, SCREENSHOTS[filter]]]
      : Object.entries(SCREENSHOTS);

    console.log("Capturing screenshots...\n");
    for (const [_name, capture] of toCapture) {
      await capture(page);
    }

    await browser.close();
  } finally {
    if (!exited) {
      codeProcess.kill("SIGTERM");
      await sleep(1000);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Screenshot capture failed:", err.message);
  process.exit(1);
});
