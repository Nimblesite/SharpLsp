// Captures website screenshots from the real desktop VS Code Electron app.
// This does not use `code serve-web`.

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
const debugPort = Number(process.env.VSCODE_DEBUG_PORT ?? String(49_000 + Math.floor(Math.random() * 1000)));
const launchTimeoutMs = 60_000;

fs.mkdirSync(outputDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codeCli() {
  return process.env.VSCODE_CLI && fs.existsSync(process.env.VSCODE_CLI)
    ? process.env.VSCODE_CLI
    : "code";
}

function installVsix(cli, extensionsDir, userDataDir) {
  execFileSync(
    cli,
    ["--install-extension", vsixPath, "--force", "--extensions-dir", extensionsDir, "--user-data-dir", userDataDir],
    { stdio: "inherit" },
  );
}

async function waitForDebugEndpoint() {
  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(debugPort)}/json/version`);
      if (response.ok) return;
    } catch {
      // not ready
    }
    await sleep(500);
  }
  throw new Error("VS Code debugging endpoint did not start");
}

async function waitForWorkbench(browser) {
  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (await page.locator(".monaco-workbench").isVisible({ timeout: 500 }).catch(() => false)) {
          return page;
        }
      }
    }
    await sleep(500);
  }
  throw new Error("VS Code workbench did not appear");
}

async function commandPalette(page, command) {
  await page.keyboard.press("Meta+Shift+p");
  await sleep(400);
  await page.keyboard.type(command, { delay: 15 });
  await sleep(400);
  await page.keyboard.press("Enter");
  await sleep(1200);
}

async function openFile(page, filename) {
  await page.keyboard.press("Meta+p");
  await sleep(400);
  await page.keyboard.type(filename, { delay: 15 });
  await sleep(400);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 30_000 });
  await sleep(1200);
}

async function goToLine(page, line) {
  await page.keyboard.press("Control+g");
  await sleep(250);
  await page.keyboard.type(String(line), { delay: 15 });
  await page.keyboard.press("Enter");
  await sleep(500);
}

async function clearNotifications(page) {
  await commandPalette(page, "Notifications: Clear All Notifications");
  await page.keyboard.press("Escape");
}

async function closePanel(page) {
  if (await page.locator(".part.panel").isVisible({ timeout: 500 }).catch(() => false)) {
    await commandPalette(page, "View: Toggle Panel Visibility");
  }
}

async function closeSecondarySidebar(page) {
  if (await page.locator(".part.auxiliarybar").isVisible({ timeout: 500 }).catch(() => false)) {
    await commandPalette(page, "View: Toggle Secondary Side Bar Visibility");
  }
}

async function resetWorkbench(page) {
  await commandPalette(page, "View: Single Column Editor Layout");
  await commandPalette(page, "File: Close All Editors");
  await closePanel(page);
  await closeSecondarySidebar(page);
  await clearNotifications(page);
}

async function setDarkTheme(page) {
  await commandPalette(page, "Preferences: Color Theme");
  const darkModern = page.getByRole("option", { name: /Dark Modern/ });
  if (await darkModern.isVisible({ timeout: 2000 }).catch(() => false)) {
    await darkModern.click();
    await sleep(800);
  } else {
    await page.keyboard.press("Escape");
  }
}

async function waitForForge(page) {
  await openFile(page, "Calculator.cs");
  const visible = await page.locator(".statusbar-item", { hasText: "Forge" }).isVisible({ timeout: 30_000 }).catch(() => false);
  if (!visible) throw new Error("Forge status bar item did not appear");
  await sleep(6000);
}

async function saveScreenshot(page, filename, description) {
  const filePath = path.join(outputDir, filename);
  await page.screenshot({ path: filePath, type: "png", fullPage: false });
  const kb = Math.round(fs.statSync(filePath).size / 1024);
  console.log(`  [ok] ${filename} (${String(kb)}KB) - ${description}`);
}

async function captureHomepage(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await saveScreenshot(page, "vscode-homepage-page.png", "C# editing overview");
}

async function captureGettingStarted(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await commandPalette(page, "Terminal: Create New Terminal");
  await page.keyboard.type(`"${forgeBinary}" --version`, { delay: 5 });
  await page.keyboard.press("Enter");
  await sleep(2000);
  await saveScreenshot(page, "vscode-getting-started-page.png", "terminal version check");
}

async function captureArchitecture(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await commandPalette(page, "Forge: Show Output Channel");
  await sleep(1200);
  await saveScreenshot(page, "vscode-architecture-page.png", "Forge output channel");
}

async function captureEditors(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await commandPalette(page, "View: Split Editor Right");
  await openFile(page, "Greeter.fs");
  await saveScreenshot(page, "vscode-editors-page.png", "C# and F# split editor");
}

async function captureConfiguration(page) {
  await resetWorkbench(page);
  await commandPalette(page, "Preferences: Open Settings (UI)");
  await page.keyboard.type("forge", { delay: 15 });
  await sleep(1500);
  await saveScreenshot(page, "vscode-configuration-page.png", "Forge settings UI");
}

async function captureCompletions(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await goToLine(page, 19);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("            this.", { delay: 25 });
  await sleep(2000);
  if (!await page.locator(".editor-widget.suggest-widget").isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.keyboard.press("Control+Space");
    await sleep(1500);
  }
  await saveScreenshot(page, "vscode-completions-page.png", "completion dropdown");
}

async function captureDiagnostics(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await goToLine(page, 19);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("            int x = undefinedVariable + notAMethod();", { delay: 15 });
  await sleep(7000);
  await saveScreenshot(page, "vscode-diagnostics-page.png", "diagnostic squiggles");
}

async function captureHover(page) {
  await resetWorkbench(page);
  await openFile(page, "HoverXmlDoc.cs");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("Factorial", { delay: 15 });
  await page.keyboard.press("Escape");
  await commandPalette(page, "Show or Focus Hover");
  await saveScreenshot(page, "vscode-hover-page.png", "hover tooltip");
}

async function captureGoToDefinition(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("DivideByZeroException", { delay: 15 });
  await page.keyboard.press("Escape");
  await commandPalette(page, "Peek Definition");
  await sleep(2500);
  await saveScreenshot(page, "vscode-go-to-definition-page.png", "peek definition");
}

async function captureProfiler(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await commandPalette(page, "Forge: Refresh Profiler");
  await sleep(2500);
  await saveScreenshot(page, "vscode-profiler-page.png", "profiler view");
}

async function captureSolutionExplorer(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await commandPalette(page, "Forge: Focus on Solution Explorer");
  await sleep(2500);
  await saveScreenshot(page, "solution-explorer.png", "solution explorer");
}

async function captureSplitEditor(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await commandPalette(page, "View: Split Editor Right");
  await openFile(page, "Greeter.fs");
  await saveScreenshot(page, "split-editor.png", "C# and F# split editor");
}

async function captureEditorOverview(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await commandPalette(page, "Focus on Outline View");
  await sleep(1800);
  await saveScreenshot(page, "editor-overview.png", "outline symbols");
}

async function captureCodeFolding(page) {
  await resetWorkbench(page);
  await openFile(page, "Calculator.cs");
  await commandPalette(page, "Fold All Regions");
  await sleep(1000);
  await saveScreenshot(page, "code-folding.png", "folded regions");
}

async function captureNestedClasses(page) {
  await resetWorkbench(page);
  await openFile(page, "Nested.cs");
  await commandPalette(page, "Focus on Outline View");
  await sleep(1800);
  await saveScreenshot(page, "nested-classes.png", "nested class outline");
}

const captures = {
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
  "solution-explorer": captureSolutionExplorer,
  "split-editor": captureSplitEditor,
  "editor-overview": captureEditorOverview,
  "code-folding": captureCodeFolding,
  "nested-classes": captureNestedClasses,
};

function launchCode(cli, userDataDir, extensionsDir) {
  return spawn(
    cli,
    [
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
      `--remote-debugging-port=${String(debugPort)}`,
      "--disable-restore-windows",
    ],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        FORGE_EXECUTABLE_PATH: forgeBinary,
        PATH: `${path.dirname(forgeBinary)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
}

async function stopProcess(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await sleep(1000);
  if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
}

async function removeTempRoot(tempRoot) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
}

async function main() {
  const filter = process.argv[2] ?? null;
  if (filter && !captures[filter]) {
    throw new Error(`Unknown screenshot "${filter}". Available: ${Object.keys(captures).join(", ")}`);
  }
  if (!fs.existsSync(vsixPath)) throw new Error(`VSIX not found: ${vsixPath}`);
  if (!fs.existsSync(forgeBinary)) throw new Error(`Forge binary not found: ${forgeBinary}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vscode-screens-"));
  const userDataDir = path.join(tempRoot, "user-data");
  const extensionsDir = path.join(tempRoot, "extensions");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });

  const cli = codeCli();
  console.log(`Output: ${outputDir}`);
  installVsix(cli, extensionsDir, userDataDir);
  const codeProcess = launchCode(cli, userDataDir, extensionsDir);
  let browser;

  try {
    await waitForDebugEndpoint();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(debugPort)}`);
    const page = await waitForWorkbench(browser);
    await page.setViewportSize({ width: 1280, height: 800 });
    await setDarkTheme(page);
    await waitForForge(page);

    const entries = filter ? [[filter, captures[filter]]] : Object.entries(captures);
    for (const [name, capture] of entries) {
      console.log(`  Capturing ${name}...`);
      await capture(page);
    }
  } finally {
    if (browser) await Promise.race([browser.close(), sleep(3000)]).catch(() => undefined);
    await stopProcess(codeProcess);
    await removeTempRoot(tempRoot);
  }
}

main().catch((err) => {
  console.error("Screenshot capture failed:", err.message);
  process.exit(1);
});
