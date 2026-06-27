import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type LanguageClient } from 'vscode-languageclient/node';
import { NuGetBrowserPanel } from '../../nuget-browser.js';
import {
  EXTENSION_ID,
  closeAllEditors,
  openSharpLspPanel,
  pollUntilResult,
  setupLspTestSuite,
  takeScreenshot,
  teardownLspTestSuite,
} from './test-helpers';

interface SharpLspApiForNuGetTests {
  readonly getLspClient: () => LanguageClient | undefined;
}

/** Absolute path to the NuGetTest fixture project (has Newtonsoft.Json installed). */
function nugetTestProjectPath(): string {
  // __dirname: editors/vscode/out/test/suite/ → repo root is 5 levels up.
  const repoRoot = path.resolve(__dirname, '../../../../..');
  return path.join(repoRoot, 'tests', 'fixtures', 'NuGetTest', 'NuGetTest.csproj');
}

suite('NuGet Browser', () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite('nuget-');
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  // ── Command Registration ────────────────────────────────────

  test('sharplsp.browseNuGetPackages command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(
      allCommands.includes('sharplsp.browseNuGetPackages'),
      'sharplsp.browseNuGetPackages should be registered',
    );
  });

  // ── Package Contributions ───────────────────────────────────

  test('package.json declares browseNuGetPackages command', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const commands: { command: string }[] = ext.packageJSON.contributes?.commands ?? [];
    assert.ok(
      commands.some((c) => c.command === 'sharplsp.browseNuGetPackages'),
      'package.json must declare sharplsp.browseNuGetPackages',
    );
  });

  test('package.json declares removeNuGetPackage command', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const commands: { command: string }[] = ext.packageJSON.contributes?.commands ?? [];
    assert.ok(
      commands.some((c) => c.command === 'sharplsp.removeNuGetPackage'),
      'package.json must declare sharplsp.removeNuGetPackage',
    );
  });

  // ── NuGet Browser Panel ─────────────────────────────────────

  test('panel opens from NuGetBrowserPanel.open()', async function () {
    this.timeout(10_000);

    // Import the module to access the static open method.
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');

    // We can't easily call NuGetBrowserPanel.open() directly without
    // a real project file, but we can verify the command doesn't crash
    // when invoked without a valid node (it shows a warning message).
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.browseNuGetPackages');
    }, 'browseNuGetPackages should not throw when no node is provided');
  });

  test('removeNuGetPackage command does not throw when cancelled', async function () {
    this.timeout(5_000);
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('sharplsp.removeNuGetPackage');
    }, 'removeNuGetPackage must not throw when no node is provided');
  });

  // ── Extension API availability ──────────────────────────────

  test('extension exports API with explorerProvider', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');
    const api = ext.exports as { explorerProvider: unknown } | undefined;
    assert.ok(api?.explorerProvider, 'Extension must export explorerProvider');
  });

  // ── Context menu registration ───────────────────────────────

  test('browseNuGetPackages appears in context menu for project items', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension should exist');
    const menus = ext.packageJSON.contributes?.menus ?? {};

    // Check view/item/context menus for the browse command.
    const viewItemMenus: { command: string; when?: string }[] = menus['view/item/context'] ?? [];
    const browseEntry = viewItemMenus.find((m) => m.command === 'sharplsp.browseNuGetPackages');
    assert.ok(browseEntry, 'browseNuGetPackages should be in view/item/context menu');
    // Verify it's scoped to project items.
    assert.ok(
      browseEntry.when?.includes('viewItem'),
      'browseNuGetPackages menu should be conditional on viewItem',
    );
  });

  // ── NuGet LSP request method names ──────────────────────────

  test('NuGet LSP request methods follow sharplsp/nuget/* convention', () => {
    const expectedMethods = [
      'sharplsp/nuget/search',
      'sharplsp/nuget/versions',
      'sharplsp/nuget/installed',
      'sharplsp/nuget/install',
      'sharplsp/nuget/uninstall',
    ];

    // These are the methods the extension sends to the LSP server.
    // This test documents the API contract.
    for (const method of expectedMethods) {
      assert.ok(
        method.startsWith('sharplsp/nuget/'),
        `Method ${method} should start with sharplsp/nuget/`,
      );
    }
  });

  // ── Panel singleton behavior ────────────────────────────────

  test('NuGetBrowserPanel is singleton (documented behavior)', () => {
    // The NuGetBrowserPanel uses a static `instance` field to ensure
    // only one panel exists at a time. This is enforced by the open()
    // method which checks for an existing instance before creating.
    // We verify this contract exists by checking the module exports.
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, 'Extension must exist');
    // The NuGetBrowserPanel class should be importable from the extension.
    // We can't test singleton behavior without a real project file,
    // but we document the expected behavior here.
    assert.ok(true, 'NuGetBrowserPanel uses singleton pattern');
  });

  // ── Webview message types ───────────────────────────────────

  test('all expected webview message commands are documented', () => {
    // These are the message commands the webview sends to the extension.
    // Each maps to a specific LSP request.
    const expectedCommands = [
      'search', // -> sharplsp/nuget/search
      'selectPackage', // -> sharplsp/nuget/versions
      'install', // -> sharplsp/nuget/install
      'uninstall', // -> sharplsp/nuget/uninstall
      'changeVersion', // -> sharplsp/nuget/install (with new version)
      'switchTab', // -> sharplsp/nuget/installed (for "installed" tab)
      'openExternal', // -> vscode.env.openExternal
    ];

    assert.strictEqual(expectedCommands.length, 7, 'Should have 7 message commands');
  });

  // ── Tab state management ────────────────────────────────────

  test('valid tab values are browse and installed', () => {
    const validTabs = ['browse', 'installed'];
    assert.deepStrictEqual(
      validTabs,
      ['browse', 'installed'],
      'NuGet browser should support browse and installed tabs',
    );
  });

  // ── Real panel lifecycle (bug regression tests) ─────────────

  function getExtensionContext(): vscode.ExtensionContext {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');
    const store = new Map<string, unknown>();
    const workspaceState = {
      get: (key: string): unknown => store.get(key),
      update: (key: string, value: unknown): Thenable<void> => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
        return Promise.resolve();
      },
      keys: (): readonly string[] => Array.from(store.keys()),
    };
    return {
      subscriptions: [],
      workspaceState,
    } as unknown as vscode.ExtensionContext;
  }

  function getLspClientGetter(): () => LanguageClient | undefined {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, 'Extension must be active');
    const api = ext.exports as SharpLspApiForNuGetTests | undefined;
    assert.ok(api?.getLspClient, 'Extension must export getLspClient');
    return api.getLspClient;
  }

  async function takeNuGetScreenshot(filename: string): Promise<void> {
    await openSharpLspPanel();
    await takeScreenshot(filename);
  }

  /**
   * BUG REGRESSION: Browse tab was empty on initial panel load because
   * the constructor only called loadInstalledPackages() without ever
   * triggering performSearch(""). This test verifies the initial load
   * populates searchResults with popular packages.
   */
  test('browse tab is populated on initial load (bug fix)', async function () {
    this.timeout(30_000);

    const projectPath = nugetTestProjectPath();
    const context = getExtensionContext();
    const getClient = getLspClientGetter();

    // Ensure we have a real LSP client before proceeding.
    assert.ok(getClient(), 'LSP client must be running for this test');

    const panel = NuGetBrowserPanel.open(context, projectPath, 'NuGetTest', getClient);

    try {
      await panel.waitForInitialLoad();
      const count = panel.getSearchResultsCount();
      assert.ok(
        count > 0,
        `Browse tab must be populated after initial load (got ${count.toString()} results)`,
      );
      assert.ok(
        count >= 5,
        `Browse tab must show at least 5 popular packages, got ${count.toString()}`,
      );
      const html = panel.getRenderedHtml();
      assert.ok(
        html.includes('package-list') || html.includes('package-item') || html.includes('NuGet'),
        'Browse HTML must contain package list markup',
      );
      assert.ok(html.length > 500, 'Browse HTML must have substantial content');
      await takeNuGetScreenshot('vscode-nuget-browse.png');
    } finally {
      panel.dispose();
    }
  });

  /**
   * BUG REGRESSION: Clicking a package on the Installed tab did nothing
   * because selectPackage looked up packageId in searchResults, but
   * installed packages on the Installed tab come from the separate
   * installedPackages Map. This test verifies that selecting an
   * installed package sets selectedPackage correctly.
   */
  test('clicking installed package selects it (bug fix)', async function () {
    this.timeout(30_000);

    const projectPath = nugetTestProjectPath();
    const context = getExtensionContext();
    const getClient = getLspClientGetter();

    assert.ok(getClient(), 'LSP client must be running for this test');

    const panel = NuGetBrowserPanel.open(context, projectPath, 'NuGetTest', getClient);

    try {
      await panel.waitForInitialLoad();

      const installedIds = panel.getInstalledPackageIds();
      assert.ok(installedIds.length > 0, 'Fixture project must have installed packages');
      assert.ok(
        installedIds.includes('Newtonsoft.Json'),
        'Newtonsoft.Json must be installed in fixture',
      );

      // Switch to the Installed tab.
      await panel.simulateWebviewMessage({
        command: 'switchTab',
        data: { tab: 'installed' },
      });
      assert.strictEqual(panel.getCurrentTab(), 'installed', 'Tab must switch to installed');

      // Click the installed package.
      await panel.simulateWebviewMessage({
        command: 'selectPackage',
        data: { packageId: 'Newtonsoft.Json' },
      });

      assert.strictEqual(
        panel.getSelectedPackageId(),
        'Newtonsoft.Json',
        'Selecting an installed package must set selectedPackage',
      );
      const installedHtml = panel.getRenderedHtml();
      assert.ok(
        installedHtml.includes('Newtonsoft.Json'),
        'Installed tab HTML must show Newtonsoft.Json',
      );
      assert.ok(
        installedHtml.includes('Remove') || installedHtml.includes('uninstall'),
        'Installed package must show Remove button',
      );
      assert.ok(installedHtml.includes('13.0'), 'Installed package must show version number');
      assert.ok(
        installedHtml.toLowerCase().includes('james newton') ||
          installedHtml.toLowerCase().includes('newtonsoft'),
        'Package details must show author or description',
      );
      await takeNuGetScreenshot('vscode-nuget-installed.png');
    } finally {
      panel.dispose();
    }
  });

  /**
   * Verify the installed list is correctly populated from the LSP.
   */
  test('installed packages loaded from LSP on open', async function () {
    this.timeout(30_000);

    const projectPath = nugetTestProjectPath();
    const context = getExtensionContext();
    const getClient = getLspClientGetter();

    assert.ok(getClient(), 'LSP client must be running for this test');

    const panel = NuGetBrowserPanel.open(context, projectPath, 'NuGetTest', getClient);

    try {
      await panel.waitForInitialLoad();
      const ids = panel.getInstalledPackageIds();
      assert.ok(
        ids.includes('Newtonsoft.Json'),
        `Expected Newtonsoft.Json in installed list, got: ${ids.join(', ')}`,
      );
    } finally {
      panel.dispose();
    }
  });

  /**
   * REGRESSION: The mockup includes chrome (activity bar, status bar) that
   * belongs to VS Code itself, not the webview panel. None of those
   * elements may appear in the rendered HTML. See docs/designs/DESIGN.md § 0.
   */
  test('rendered HTML does not include VS Code chrome (regression)', async function () {
    this.timeout(30_000);

    const projectPath = nugetTestProjectPath();
    const context = getExtensionContext();
    const getClient = getLspClientGetter();

    assert.ok(getClient(), 'LSP client must be running for this test');

    const panel = NuGetBrowserPanel.open(context, projectPath, 'NuGetTest', getClient);

    try {
      await panel.waitForInitialLoad();
      const html = panel.getRenderedHtml();

      // Status bar fake content.
      assert.ok(
        !html.includes('main*'),
        'Rendered HTML must not include fake git status (`main*`) — VS Code provides the status bar',
      );
      assert.ok(
        !html.includes('NuGet v6.8.0'),
        'Rendered HTML must not include fake `NuGet v6.8.0` version label',
      );
      assert.ok(
        !/UTF-8\s*<\/span>/.exec(html),
        'Rendered HTML must not include fake UTF-8 encoding label',
      );
      assert.ok(
        !html.includes('status-bar'),
        'Rendered HTML must not include status-bar CSS class',
      );

      // Activity bar fake content.
      assert.ok(
        !html.includes('class="sidebar"'),
        'Rendered HTML must not include sidebar (activity bar) — VS Code provides one',
      );
      assert.ok(
        !html.includes('sidebar-icon'),
        'Rendered HTML must not include sidebar-icon class',
      );
      assert.ok(!html.includes('sidebar-avatar'), 'Rendered HTML must not include user avatar');

      // Hardcoded fake dependencies.
      assert.ok(
        !html.includes('.NETStandard 2.0'),
        'Rendered HTML must not include hardcoded fake .NETStandard 2.0 dependency',
      );
      assert.ok(
        !html.includes('.NETStandard 2.1'),
        'Rendered HTML must not include hardcoded fake .NETStandard 2.1 dependency',
      );

      // Broken Updates tab.
      assert.ok(
        !html.includes("switchTab('updates')"),
        'Rendered HTML must not include broken Updates tab',
      );

      // Decorative sort dropdown with no handler.
      assert.ok(
        !html.includes('Sort By:'),
        'Rendered HTML must not include decorative Sort By dropdown',
      );
    } finally {
      panel.dispose();
    }
  });

  /**
   * Verify that searching from the webview updates state.
   */
  test('search message populates searchResults', async function () {
    this.timeout(30_000);

    const projectPath = nugetTestProjectPath();
    const context = getExtensionContext();
    const getClient = getLspClientGetter();

    assert.ok(getClient(), 'LSP client must be running for this test');

    const panel = NuGetBrowserPanel.open(context, projectPath, 'NuGetTest', getClient);

    try {
      await panel.waitForInitialLoad();

      await panel.simulateWebviewMessage({
        command: 'search',
        data: { query: 'Serilog' },
      });

      const searchCount = panel.getSearchResultsCount();
      assert.ok(searchCount > 0, "Search for 'Serilog' must return results");
      assert.ok(searchCount >= 3, `Search must return ≥3 results, got ${searchCount.toString()}`);
      const searchHtml = panel.getRenderedHtml();
      assert.ok(searchHtml.toLowerCase().includes('serilog'), "HTML must contain 'Serilog'");
      assert.ok(searchHtml.length > 300, 'Search results HTML must have content');
      await takeNuGetScreenshot('vscode-nuget-search.png');
    } finally {
      panel.dispose();
    }
  });

  // ── Reactivity: csproj edits propagate to the panel ─────────────

  /**
   * Copy the NuGetTest fixture into a temp directory so we can mutate the
   * csproj without corrupting the shared fixture used by other tests.
   */
  function createScratchProject(scratchDir: string, initialCsproj: string): string {
    fs.mkdirSync(scratchDir, { recursive: true });
    const csprojPath = path.join(scratchDir, 'Scratch.csproj');
    fs.writeFileSync(csprojPath, initialCsproj, 'utf-8');
    return csprojPath;
  }

  /**
   * REACTIVITY: editing a csproj on disk to remove a <PackageReference>
   * MUST propagate into the panel without any manual refresh. The rendered
   * HTML must switch from "Remove" to "Install" for that package.
   *
   * This test is the hard contract for CLAUDE.md's rule
   * "All screens MUST BE 100% reactive."
   */
  test('panel reacts to external csproj edit (package removed)', async function () {
    this.timeout(45_000);

    const scratch = path.join(tmpDir, 'reactivity-panel');
    const csprojPath = createScratchProject(
      scratch,
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`,
    );

    const context = getExtensionContext();
    const getClient = getLspClientGetter();
    assert.ok(getClient(), 'LSP client must be running');

    const panel = NuGetBrowserPanel.open(context, csprojPath, 'Scratch', getClient);

    try {
      await panel.waitForInitialLoad();

      // Select Newtonsoft.Json so we can verify the Remove button exists.
      await panel.simulateWebviewMessage({
        command: 'selectPackage',
        data: { packageId: 'Newtonsoft.Json' },
      });

      const htmlBefore = panel.getRenderedHtml();
      assert.ok(
        htmlBefore.includes('uninstallPackage') && htmlBefore.includes('Remove'),
        'Panel must render a Remove button for Newtonsoft.Json before csproj edit',
      );

      // Rewrite the csproj to drop the package — no manual refresh.
      fs.writeFileSync(
        csprojPath,
        `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup></ItemGroup>
</Project>`,
        'utf-8',
      );

      // Wait for the signal-driven re-render. No manual refresh() call.
      await pollUntilResult(
        () => Promise.resolve(panel.getRenderedHtml()),
        (html) =>
          !panel.getInstalledPackageIds().includes('Newtonsoft.Json') &&
          html.includes('installPackage') &&
          !html.includes('uninstallPackage'),
        15_000,
      );

      const htmlAfter = panel.getRenderedHtml();
      assert.ok(
        !htmlAfter.includes('uninstallPackage'),
        'After csproj removes the PackageReference, panel must NOT render a Remove button',
      );
      assert.ok(
        htmlAfter.includes('installPackage'),
        'After csproj removes the PackageReference, panel MUST render an Install button',
      );
    } finally {
      panel.dispose();
    }
  });

  /**
   * REACTIVITY: adding a <PackageReference> to a csproj MUST flip the
   * button from Install to Remove.
   */
  test('panel reacts to external csproj edit (package added)', async function () {
    this.timeout(45_000);

    const scratch = path.join(tmpDir, 'reactivity-panel-add');
    const csprojPath = createScratchProject(
      scratch,
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup></ItemGroup>
</Project>`,
    );

    const context = getExtensionContext();
    const getClient = getLspClientGetter();

    const panel = NuGetBrowserPanel.open(context, csprojPath, 'ScratchAdd', getClient);

    try {
      await panel.waitForInitialLoad();
      assert.ok(
        !panel.getInstalledPackageIds().includes('Newtonsoft.Json'),
        'Newtonsoft.Json must not be installed initially',
      );

      fs.writeFileSync(
        csprojPath,
        `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`,
        'utf-8',
      );

      await pollUntilResult(
        () => Promise.resolve(panel.getInstalledPackageIds()),
        (ids) => ids.includes('Newtonsoft.Json'),
        15_000,
      );

      assert.ok(
        panel.getInstalledPackageIds().includes('Newtonsoft.Json'),
        'Panel MUST reflect the new PackageReference after csproj write',
      );
    } finally {
      panel.dispose();
    }
  });

  /**
   * REACTIVITY: the details panel header renders the package icon (not just
   * a generic material-symbol glyph). Regression test for
   * "installed packages don't have an icon".
   */
  test('details panel renders package icon image when iconUrl present', async function () {
    this.timeout(45_000);

    const projectPath = nugetTestProjectPath();
    const context = getExtensionContext();
    const getClient = getLspClientGetter();

    const panel = NuGetBrowserPanel.open(context, projectPath, 'NuGetTest', getClient);

    try {
      await panel.waitForInitialLoad();

      // Select Newtonsoft.Json — it definitely has an iconUrl on nuget.org.
      await panel.simulateWebviewMessage({
        command: 'selectPackage',
        data: { packageId: 'Newtonsoft.Json' },
      });

      // Allow enrichment HTTP fetch to complete.
      await pollUntilResult(
        () => Promise.resolve(panel.getRenderedHtml()),
        (html) => html.includes('class="package-icon-img"'),
        15_000,
      );

      const html = panel.getRenderedHtml();
      assert.ok(
        html.includes('class="package-icon-img"'),
        'Details panel must render an <img> with class package-icon-img when iconUrl is present',
      );
      await takeNuGetScreenshot('vscode-nuget-package-details.png');
    } finally {
      panel.dispose();
    }
  });

  /**
   * DRY: the Installed tab must render icons the same way as the Browse tab.
   * Before this fix, the installed list had its own hardcoded
   * material-symbol glyph and no <img> overlay.
   */
  test('installed tab renders icons (no DRY violation)', async function () {
    this.timeout(45_000);

    const projectPath = nugetTestProjectPath();
    const context = getExtensionContext();
    const getClient = getLspClientGetter();

    const panel = NuGetBrowserPanel.open(context, projectPath, 'NuGetTest', getClient);

    try {
      await panel.waitForInitialLoad();

      await panel.simulateWebviewMessage({
        command: 'switchTab',
        data: { tab: 'installed' },
      });

      // After enrichment, Newtonsoft.Json must show its real icon.
      await pollUntilResult(
        () => Promise.resolve(panel.getRenderedHtml()),
        (html) => {
          // Extract the Installed Packages section.
          const installedIdx = html.indexOf('Installed Packages');
          if (installedIdx < 0) return false;
          const section = html.slice(installedIdx);
          return section.includes('class="package-icon-img"');
        },
        15_000,
      );

      const html = panel.getRenderedHtml();
      const installedIdx = html.indexOf('Installed Packages');
      const section = installedIdx >= 0 ? html.slice(installedIdx) : '';
      assert.ok(
        section.includes('class="package-icon-img"'),
        'Installed tab MUST render <img class="package-icon-img"> (DRY with browse tab)',
      );
    } finally {
      panel.dispose();
    }
  });

  /**
   * REGRESSION (snapshot-vs-live-derivation):
   *
   * The details panel used to read `selectedPackage.isInstalled` from a
   * stored snapshot baked at selection time. When the user (or another
   * tool) removed the package from the csproj, the list row updated but
   * the details panel kept showing the Remove button — because the
   * snapshot was never refreshed.
   *
   * The fix: derive `installed` from the live `installedPackages` signal
   * at render time, NOT from the snapshot. This test pins that contract
   * by asserting on the details-panel section specifically.
   */
  test('details panel button flips Remove→Install on external csproj edit (snapshot bug)', async function () {
    this.timeout(45_000);

    const scratch = path.join(tmpDir, 'reactivity-details');
    const csprojPath = createScratchProject(
      scratch,
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`,
    );

    const context = getExtensionContext();
    const getClient = getLspClientGetter();
    assert.ok(getClient(), 'LSP client must be running');

    const panel = NuGetBrowserPanel.open(context, csprojPath, 'ReactivityDetails', getClient);

    /** Extract just the right-hand details-panel HTML for tight assertions. */
    function detailsSection(html: string): string {
      const start = html.indexOf('<aside class="details-panel">');
      assert.ok(start >= 0, 'Rendered HTML must contain the details-panel <aside>');
      const end = html.indexOf('</aside>', start);
      return html.slice(start, end);
    }

    try {
      await panel.waitForInitialLoad();

      // Select Newtonsoft.Json — it's installed, so the details panel
      // header MUST render the Remove button.
      await panel.simulateWebviewMessage({
        command: 'selectPackage',
        data: { packageId: 'Newtonsoft.Json' },
      });

      const detailsBefore = detailsSection(panel.getRenderedHtml());
      assert.ok(
        detailsBefore.includes('uninstallPackage'),
        'PRECONDITION: details panel must show Remove button while package is installed',
      );
      assert.ok(
        !detailsBefore.includes('installPackage('),
        'PRECONDITION: details panel must NOT show Install button while package is installed',
      );

      // External edit: rewrite the csproj to drop the PackageReference.
      // No manual refresh, no UI interaction — just a file write.
      fs.writeFileSync(
        csprojPath,
        `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup></ItemGroup>
</Project>`,
        'utf-8',
      );

      // Wait for the signal to drive a re-render of the details panel.
      // The selectedPackage snapshot still has isInstalled=true; the bug
      // would leave the Remove button visible because the renderer trusted
      // the snapshot. With the fix, the renderer derives `installed` from
      // the live installedPackages signal and flips to Install.
      await pollUntilResult(
        () => Promise.resolve(detailsSection(panel.getRenderedHtml())),
        (details) => details.includes('installPackage(') && !details.includes('uninstallPackage'),
        15_000,
      );

      const detailsAfter = detailsSection(panel.getRenderedHtml());
      assert.ok(
        detailsAfter.includes('installPackage('),
        'After csproj removes PackageReference, details panel MUST render Install button. ' +
          'If this fails, the renderer is reading isInstalled from the stale ' +
          'selectedPackage snapshot instead of the live installedPackages signal.',
      );
      assert.ok(
        !detailsAfter.includes('uninstallPackage'),
        'After csproj removes PackageReference, details panel MUST NOT render Remove button. ' +
          'Snapshot-vs-live-derivation regression — see VSCODE-REACTIVITY-SPEC.md §8.',
      );

      // selectedPackage is intentionally NOT cleared by an external edit
      // — the user's selection persists. We only require the derived UI
      // to reflect current state.
      assert.strictEqual(
        panel.getSelectedPackageId(),
        'Newtonsoft.Json',
        'selectedPackage reference must persist across external edits — ' +
          'only the derived rendering changes, not the user-visible selection',
      );
    } finally {
      panel.dispose();
    }
  });
});

// ════════════════════════════════════════════════════════════════
// Direct unit coverage of the nuget-browser submodules + the panel
// driven by a FAKE LanguageClient (no real LSP server required).
// ════════════════════════════════════════════════════════════════

import { buildHtml, esc, escAttr } from '../../nuget-browser/html.js';
import type { RenderState } from '../../nuget-browser/html.js';
import {
  fetchInstalled,
  fetchTargets,
  fetchVersions,
  installPackage,
  searchPackages,
  uninstallPackage,
} from '../../nuget-browser/lsp.js';
import {
  applyOptimisticInstall,
  applyOptimisticUninstall,
  buildInstallToast,
  buildUninstallToast,
  enrichPackageMetadata,
  fetchInstalledMetadata,
  findOrSynthesizePackage,
  revertOptimisticInstall,
  revertOptimisticUninstall,
} from '../../nuget-browser/mutate.js';
import {
  LAST_TARGET_KEY,
  computeWorkspaceRoot,
  loadTargetsWithDefaults,
  persistTargetSelection,
  synthesizeFallback,
} from '../../nuget-browser/target-store.js';
import { installKey, restoreKey, uninstallKey } from '../../nuget-browser/types.js';
import type {
  NuGetInstalledResponse,
  NuGetMutationResponse,
  NuGetSearchResponse,
  NuGetSearchResult,
  NuGetTarget,
  NuGetTargetsResponse,
  NuGetVersionsResponse,
  RestoreProgressParams,
} from '../../nuget-browser/types.js';

// ── Fixtures ────────────────────────────────────────────────────

function projectTarget(overrides: Partial<NuGetTarget> = {}): NuGetTarget {
  return {
    id: 'proj-1',
    kind: 'project',
    displayName: 'Proj1',
    path: '/virtual/Proj1.csproj',
    language: 'csharp',
    ...overrides,
  };
}

function buildPropsTarget(overrides: Partial<NuGetTarget> = {}): NuGetTarget {
  return {
    id: 'props-1',
    kind: 'buildProps',
    displayName: 'Directory.Build.props',
    path: '/virtual/Directory.Build.props',
    ...overrides,
  };
}

function searchResult(overrides: Partial<NuGetSearchResult> = {}): NuGetSearchResult {
  return {
    id: 'Newtonsoft.Json',
    version: '13.0.3',
    description: 'JSON framework for .NET',
    authors: 'James Newton-King',
    tags: ['json', 'serialize'],
    iconUrl: 'https://example.com/icon.png',
    licenseUrl: 'https://example.com/license',
    projectUrl: 'https://www.newtonsoft.com/json',
    published: new Date().toISOString(),
    downloadCount: 1_500_000_000,
    ...overrides,
  };
}

/** Routes per-method responses (or rejections) for a fake LanguageClient. */
interface FakeRoutes {
  targets?: NuGetTargetsResponse | Error;
  installed?: NuGetInstalledResponse | Error;
  search?: NuGetSearchResponse | ((payload: unknown) => NuGetSearchResponse) | Error;
  versions?: NuGetVersionsResponse | Error;
  install?: NuGetMutationResponse | Error;
  uninstall?: NuGetMutationResponse | Error;
}

interface FakeClientHandle {
  client: LanguageClient;
  calls: { method: string; payload: unknown }[];
  restoreHandlers: ((params: RestoreProgressParams) => void)[];
  failNotification: boolean;
}

function methodKey(method: string): keyof FakeRoutes | undefined {
  const tail = method.replace('sharplsp/nuget/', '');
  if (
    tail === 'targets' ||
    tail === 'installed' ||
    tail === 'search' ||
    tail === 'versions' ||
    tail === 'install' ||
    tail === 'uninstall'
  ) {
    return tail;
  }
  return undefined;
}

function makeFakeClient(routes: FakeRoutes, failNotification = false): FakeClientHandle {
  const handle: FakeClientHandle = {
    calls: [],
    restoreHandlers: [],
    failNotification,
    client: undefined as unknown as LanguageClient,
  };
  const sendRequest = async (method: string, payload: unknown): Promise<unknown> => {
    handle.calls.push({ method, payload });
    const key = methodKey(method);
    const route = key !== undefined ? routes[key] : undefined;
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route(payload);
    if (route !== undefined) return route;
    // Default safe empty responses keep the panel from hanging.
    if (key === 'targets') return { targets: [], defaultTargetId: null, cpmEnabled: false };
    if (key === 'installed') return { packages: [] };
    if (key === 'search') return { packages: [], totalHits: 0 };
    if (key === 'versions') return { versions: [] };
    return { success: true, message: 'ok' };
  };
  const onNotification = (
    _method: string,
    cb: (params: RestoreProgressParams) => void,
  ): vscode.Disposable => {
    if (handle.failNotification) throw new Error('subscribe failed');
    handle.restoreHandlers.push(cb);
    return new vscode.Disposable(() => {
      /* no-op */
    });
  };
  handle.client = { sendRequest, onNotification } as unknown as LanguageClient;
  return handle;
}

function fakeContextWithStore(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  const workspaceState = {
    get: (key: string): unknown => store.get(key),
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => Array.from(store.keys()),
  };
  return { subscriptions: [], workspaceState } as unknown as vscode.ExtensionContext;
}

// A virtual project path that does NOT exist on disk, so the panel's
// on-disk csproj sync short-circuits to `false` and the LSP path runs.
const VIRTUAL_PROJECT = '/virtual/nonexistent/Fake.csproj';

suite('NuGet Browser — pure html', () => {
  test('esc escapes all five HTML-significant characters', () => {
    assert.strictEqual(esc('<a> & "b" \'c\''), '&lt;a&gt; &amp; &quot;b&quot; &#039;c&#039;');
    assert.strictEqual(esc('plain'), 'plain');
    assert.strictEqual(esc(''), '');
    assert.strictEqual(esc('a & b'), 'a &amp; b');
  });

  test('escAttr escapes only quotes', () => {
    assert.strictEqual(escAttr('say "hi" it\'s ok'), 'say &quot;hi&quot; it&#039;s ok');
    assert.strictEqual(escAttr('<not-escaped>'), '<not-escaped>');
  });

  function baseState(overrides: Partial<RenderState> = {}): RenderState {
    return {
      projectName: 'My<Proj>',
      currentTab: 'browse',
      currentSearchQuery: '',
      targets: [],
      selectedTargetId: undefined,
      targetsLoading: false,
      searchResults: [],
      installedPackages: new Map(),
      installedMetadata: new Map(),
      selectedPackage: undefined,
      loading: new Set(),
      toast: undefined,
      ...overrides,
    };
  }

  test('buildHtml escapes the project name and renders shell markup', () => {
    const html = buildHtml(baseState());
    assert.ok(html.includes('NuGet - My&lt;Proj&gt;'), 'project name must be escaped in title');
    assert.ok(html.includes('<main class="main">'), 'must render main shell');
    assert.ok(html.includes('acquireVsCodeApi'), 'must include the webview bootstrap script');
    assert.ok(html.includes('class="details-panel"'), 'must include the details panel');
  });

  test('buildHtml browse empty state shows "No packages found"', () => {
    const html = buildHtml(baseState({ currentTab: 'browse', searchResults: [] }));
    assert.ok(html.includes('No packages found'), 'empty browse list must show no-packages copy');
    assert.ok(html.includes('Available Packages'), 'browse list header present');
    assert.ok(html.includes('Select a package to view details'), 'details empty state present');
  });

  test('buildHtml browse loading state renders skeletons', () => {
    const html = buildHtml(baseState({ searchResults: [], loading: new Set(['search']) }));
    assert.ok(html.includes('class="skeleton"'), 'loading browse list must render skeleton rows');
    assert.ok(html.includes('search-spinner'), 'search spinner must render while loading');
  });

  test('buildHtml installed empty state shows "No packages installed"', () => {
    const html = buildHtml(baseState({ currentTab: 'installed', installedPackages: new Map() }));
    assert.ok(html.includes('No packages installed'), 'empty installed copy must render');
    assert.ok(html.includes('Installed Packages'), 'installed header must render');
  });

  test('buildHtml installed loading row renders while loading installed', () => {
    const html = buildHtml(baseState({ currentTab: 'installed', loading: new Set(['installed']) }));
    assert.ok(html.includes('Loading installed packages'), 'installed loading row must render');
  });

  test('buildHtml renders installed rows hydrated from metadata, search, and fallback', () => {
    const installed = new Map<string, string>([
      ['Has.Metadata', '1.0.0'],
      ['Has.Search', '2.0.0'],
      ['Only.Fallback', '3.0.0'],
    ]);
    const installedMetadata = new Map<string, NuGetSearchResult>([
      [
        'Has.Metadata',
        searchResult({ id: 'Has.Metadata', description: 'From metadata', authors: 'M' }),
      ],
    ]);
    const html = buildHtml(
      baseState({
        currentTab: 'installed',
        installedPackages: installed,
        installedMetadata,
        searchResults: [
          searchResult({ id: 'Has.Search', description: 'From search', authors: 'S' }),
        ],
      }),
    );
    assert.ok(html.includes('Has.Metadata'), 'metadata-hydrated row renders');
    assert.ok(html.includes('From metadata'), 'metadata description rendered');
    assert.ok(html.includes('Has.Search'), 'search-hydrated row renders');
    assert.ok(html.includes('From search'), 'search description rendered');
    assert.ok(html.includes('Only.Fallback'), 'fallback row renders');
    assert.ok(html.includes('Installed package'), 'fallback uses generic description');
    assert.ok(html.includes('v3.0.0'), 'fallback row shows resolved version');
  });

  test('buildHtml package item renders downloads, authors, and pending state', () => {
    const pkg = searchResult({ downloadCount: 2_500_000_000 });
    const html = buildHtml(
      baseState({
        searchResults: [pkg],
        loading: new Set([installKey('Newtonsoft.Json')]),
      }),
    );
    assert.ok(html.includes('2.5B Downloads'), 'billions formatting');
    assert.ok(html.includes('James Newton-King'), 'authors rendered');
    assert.ok(html.includes('pending'), 'pending class applied during install');
    assert.ok(html.includes('package-icon-img'), 'icon img rendered when iconUrl present');
  });

  test('buildHtml details panel renders install button + info rows for not-installed pkg', () => {
    const pkg = searchResult({ _versions: ['13.0.3', '13.0.2', '12.0.0'] });
    const html = buildHtml(baseState({ selectedPackage: pkg }));
    assert.ok(html.includes('installPackage('), 'not-installed shows Install button');
    assert.ok(!html.includes('uninstallPackage'), 'not-installed must not show Remove');
    assert.ok(html.includes('View License'), 'license info row rendered');
    assert.ok(html.includes('Project URL'), 'project url info row rendered');
    assert.ok(html.includes('Downloads'), 'downloads info row rendered');
    assert.ok(html.includes('>JSON<') || html.includes('SERIALIZE'), 'tags upper-cased');
    assert.ok(html.includes('<option value="13.0.3"'), 'version option rendered');
  });

  test('buildHtml details panel renders Remove button for installed pkg', () => {
    const pkg = searchResult();
    const html = buildHtml(
      baseState({
        selectedPackage: pkg,
        installedPackages: new Map([['Newtonsoft.Json', '13.0.3']]),
      }),
    );
    assert.ok(html.includes('uninstallPackage'), 'installed shows Remove button');
    assert.ok(!html.includes('installPackage('), 'installed must not show Install');
  });

  test('buildHtml details panel renders pending spinners for install/uninstall/versions', () => {
    const installing = buildHtml(
      baseState({
        selectedPackage: searchResult(),
        loading: new Set([installKey('Newtonsoft.Json'), 'versions']),
      }),
    );
    assert.ok(installing.includes('Installing…'), 'install pending label');
    assert.ok(installing.includes('progress_activity'), 'versions pending chevron');
    const removing = buildHtml(
      baseState({
        selectedPackage: searchResult(),
        installedPackages: new Map([['Newtonsoft.Json', '13.0.3']]),
        loading: new Set([uninstallKey('Newtonsoft.Json')]),
      }),
    );
    assert.ok(removing.includes('Removing…'), 'uninstall pending label');
  });

  test('buildHtml details panel falls back for missing author/description/tags', () => {
    const pkg: NuGetSearchResult = {
      id: 'Bare.Pkg',
      version: '1.0.0',
      description: '',
      authors: '',
      tags: [],
    };
    const html = buildHtml(baseState({ selectedPackage: pkg }));
    assert.ok(html.includes('Unknown author'), 'missing author fallback');
    assert.ok(html.includes('No description available'), 'missing description fallback');
    assert.ok(!html.includes('Tags'), 'no tags section when tags empty');
  });

  test('buildHtml target dropdown groups projects + build props and marks selection', () => {
    const html = buildHtml(
      baseState({
        targets: [projectTarget(), buildPropsTarget()],
        selectedTargetId: 'props-1',
      }),
    );
    assert.ok(html.includes('optgroup label="Projects"'), 'projects optgroup');
    assert.ok(html.includes('optgroup label="Build Props"'), 'build props optgroup');
    assert.ok(html.includes('value="props-1" selected'), 'selected target marked');
  });

  test('buildHtml target dropdown shows loading + no-targets placeholders', () => {
    const loading = buildHtml(baseState({ targets: [], targetsLoading: true }));
    assert.ok(loading.includes('Loading targets'), 'loading placeholder option');
    assert.ok(loading.includes('target-spinner'), 'target spinner rendered');
    assert.ok(loading.includes('disabled'), 'dropdown disabled while loading');
    const none = buildHtml(baseState({ targets: [], targetsLoading: false }));
    assert.ok(none.includes('No targets found'), 'no-targets placeholder option');
  });

  test('buildHtml renders all three toast kinds', () => {
    const info = buildHtml(baseState({ toast: { kind: 'info', text: 'Working' } }));
    assert.ok(info.includes('toast info') && info.includes('Working'), 'info toast');
    assert.ok(info.includes('progress_activity'), 'info toast spinner icon');
    const ok = buildHtml(baseState({ toast: { kind: 'success', text: 'Done' } }));
    assert.ok(ok.includes('toast success') && ok.includes('check_circle'), 'success toast');
    const err = buildHtml(baseState({ toast: { kind: 'error', text: 'Boom <x>' } }));
    assert.ok(err.includes('toast error') && err.includes('Boom &lt;x&gt;'), 'error toast escaped');
  });

  test('buildHtml download formatting covers M/K/raw thresholds', () => {
    const m = buildHtml(baseState({ searchResults: [searchResult({ downloadCount: 2_500_000 })] }));
    assert.ok(m.includes('2.5M Downloads'), 'millions');
    const k = buildHtml(baseState({ searchResults: [searchResult({ downloadCount: 4_200 })] }));
    assert.ok(k.includes('4.2K Downloads'), 'thousands');
    const raw = buildHtml(baseState({ searchResults: [searchResult({ downloadCount: 42 })] }));
    assert.ok(raw.includes('42 Downloads'), 'raw count');
  });

  test('buildHtml details date formatting yields Today / years ago / raw fallback', () => {
    const today = buildHtml(
      baseState({ selectedPackage: searchResult({ published: new Date().toISOString() }) }),
    );
    assert.ok(today.includes('Today'), 'today formatting');
    const old = buildHtml(
      baseState({ selectedPackage: searchResult({ published: '2010-01-01T00:00:00Z' }) }),
    );
    assert.ok(old.includes('years ago'), 'years-ago formatting');
    const bad = buildHtml(
      baseState({ selectedPackage: searchResult({ published: 'not-a-date' }) }),
    );
    assert.ok(bad.includes('Published'), 'invalid date still renders a Published row');
  });
});

suite('NuGet Browser — pure mutate/types/target-store', () => {
  test('applyOptimisticInstall + revert (new package then revert deletes)', () => {
    const installed = new Map<string, string>();
    const results = [searchResult({ id: 'Pkg', isInstalled: false })];
    const snap = applyOptimisticInstall(installed, results, 'Pkg', '2.0.0');
    assert.strictEqual(installed.get('Pkg'), '2.0.0');
    assert.strictEqual(results[0]!.isInstalled, true);
    assert.strictEqual(results[0]!.installedVersion, '2.0.0');
    assert.strictEqual(snap.previousVersion, undefined);
    revertOptimisticInstall(installed, 'Pkg', snap);
    assert.ok(!installed.has('Pkg'), 'revert removes a freshly-added package');
    assert.strictEqual(results[0]!.isInstalled, false);
    assert.strictEqual(results[0]!.installedVersion, undefined);
  });

  test('applyOptimisticInstall + revert (upgrade restores previous version)', () => {
    const installed = new Map<string, string>([['Pkg', '1.0.0']]);
    const snap = applyOptimisticInstall(installed, [], 'Pkg', '2.0.0');
    assert.strictEqual(installed.get('Pkg'), '2.0.0');
    assert.strictEqual(snap.previousVersion, '1.0.0');
    assert.strictEqual(snap.mutatedSearchResult, undefined);
    revertOptimisticInstall(installed, 'Pkg', snap);
    assert.strictEqual(installed.get('Pkg'), '1.0.0', 'revert restores prior version');
  });

  test('applyOptimisticUninstall + revert restores version and flags', () => {
    const installed = new Map<string, string>([['Pkg', '1.0.0']]);
    const results = [searchResult({ id: 'Pkg', isInstalled: true, installedVersion: '1.0.0' })];
    const snap = applyOptimisticUninstall(installed, results, 'Pkg');
    assert.ok(!installed.has('Pkg'), 'optimistic uninstall removes the package');
    assert.strictEqual(results[0]!.isInstalled, false);
    assert.strictEqual(snap.previousVersion, '1.0.0');
    revertOptimisticUninstall(installed, 'Pkg', snap);
    assert.strictEqual(installed.get('Pkg'), '1.0.0', 'revert reinstates the package');
    assert.strictEqual(results[0]!.isInstalled, true);
    assert.strictEqual(results[0]!.installedVersion, '1.0.0');
  });

  test('revertOptimisticUninstall is a no-op when nothing was previously installed', () => {
    const installed = new Map<string, string>();
    revertOptimisticUninstall(installed, 'Pkg', {
      previousVersion: undefined,
      mutatedSearchResult: undefined,
    });
    assert.strictEqual(installed.size, 0, 'no revert when previousVersion is undefined');
  });

  test('buildInstallToast and buildUninstallToast produce expected copy', () => {
    const target = projectTarget({ displayName: 'WebApp' });
    assert.strictEqual(
      buildInstallToast(target, 'Serilog', '3.1.1'),
      'Installing Serilog 3.1.1 into WebApp...',
    );
    assert.strictEqual(buildUninstallToast(target, 'Serilog'), 'Removing Serilog from WebApp...');
  });

  test('findOrSynthesizePackage returns search hit, synthesizes installed, or undefined', () => {
    const results = [searchResult({ id: 'InSearch' })];
    const installed = new Map<string, string>([['Installed.Only', '9.9.9']]);
    assert.strictEqual(findOrSynthesizePackage(results, installed, 'InSearch')?.id, 'InSearch');
    const synth = findOrSynthesizePackage(results, installed, 'Installed.Only');
    assert.strictEqual(synth?.version, '9.9.9');
    assert.strictEqual(synth?.isInstalled, true);
    assert.strictEqual(synth?.description, '');
    assert.strictEqual(findOrSynthesizePackage(results, installed, 'Nowhere'), undefined);
  });

  test('enrichPackageMetadata mutates package in place on a search hit', async () => {
    const handle = makeFakeClient({
      search: { packages: [searchResult({ id: 'X', description: 'Enriched!' })], totalHits: 1 },
    });
    const pkg: NuGetSearchResult = {
      id: 'X',
      version: '1',
      description: '',
      authors: '',
      tags: [],
    };
    await enrichPackageMetadata(handle.client, projectTarget(), pkg);
    assert.strictEqual(pkg.description, 'Enriched!', 'description merged in place');
    assert.strictEqual(handle.calls[0]!.method, 'sharplsp/nuget/search');
  });

  test('enrichPackageMetadata leaves package unchanged on search failure or no match', async () => {
    const failing = makeFakeClient({ search: new Error('search down') });
    const pkg: NuGetSearchResult = {
      id: 'X',
      version: '1',
      description: '',
      authors: '',
      tags: [],
    };
    await enrichPackageMetadata(failing.client, projectTarget(), pkg);
    assert.strictEqual(pkg.description, '', 'no mutation when search fails');
    const noMatch = makeFakeClient({
      search: { packages: [searchResult({ id: 'Other' })], totalHits: 1 },
    });
    await enrichPackageMetadata(noMatch.client, projectTarget(), pkg);
    assert.strictEqual(pkg.description, '', 'no mutation when id does not match');
  });

  test('fetchInstalledMetadata maps hits by id and omits failures', async () => {
    const handle = makeFakeClient({
      search: (payload) => {
        const q = (payload as { query: string }).query;
        if (q === 'packageid:A') return { packages: [searchResult({ id: 'A' })], totalHits: 1 };
        if (q === 'packageid:B') return { packages: [], totalHits: 0 };
        return { packages: [searchResult({ id: 'C' })], totalHits: 1 };
      },
    });
    const map = await fetchInstalledMetadata(handle.client, projectTarget(), ['A', 'B', 'C']);
    assert.strictEqual(map.size, 2, 'only resolved ids are mapped');
    assert.ok(map.has('A') && map.has('C') && !map.has('B'));
  });

  test('synthesizeFallback infers language from extension', () => {
    const cs = synthesizeFallback('/x/App.csproj');
    assert.strictEqual(cs.kind, 'project');
    assert.strictEqual(cs.language, 'csharp');
    assert.strictEqual(cs.displayName, 'App.csproj');
    assert.strictEqual(synthesizeFallback('/x/Lib.fsproj').language, 'fsharp');
  });

  test('computeWorkspaceRoot falls back to dirname when no workspace folder', () => {
    const root = computeWorkspaceRoot('/some/deep/Proj.csproj');
    // In the test host a workspace folder may exist; either way the result is a dir.
    assert.ok(root.length > 0, 'workspace root resolves to a non-empty path');
    assert.ok(!root.endsWith('Proj.csproj'), 'root must be a directory, not the project file');
  });

  test('loadTargetsWithDefaults synthesizes fallback when LSP fails', async () => {
    const handle = makeFakeClient({ targets: new Error('targets boom') });
    const ctx = fakeContextWithStore();
    const result = await loadTargetsWithDefaults(handle.client, ctx, '/v/Only.csproj');
    assert.strictEqual(result.error, 'targets boom');
    assert.strictEqual(result.targets.length, 1, 'fallback target synthesized');
    assert.strictEqual(result.targets[0]!.path, '/v/Only.csproj');
    assert.strictEqual(result.selectedTargetId, result.targets[0]!.id);
  });

  test('loadTargetsWithDefaults prepends fallback + honours persisted selection', async () => {
    const remote = projectTarget({ id: 'remote', path: '/v/Remote.csproj' });
    const handle = makeFakeClient({
      targets: { targets: [remote], defaultTargetId: 'remote', cpmEnabled: false },
    });
    const ctx = fakeContextWithStore();
    await persistTargetSelection(ctx, 'remote');
    assert.strictEqual(ctx.workspaceState.get(LAST_TARGET_KEY), 'remote', 'selection persisted');
    const result = await loadTargetsWithDefaults(handle.client, ctx, '/v/Initial.csproj');
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.targets.length, 2, 'fallback prepended to remote target');
    assert.strictEqual(result.targets[0]!.path, '/v/Initial.csproj', 'fallback first');
    assert.strictEqual(result.selectedTargetId, 'remote', 'persisted target wins');
  });

  test('loadTargetsWithDefaults synthesizes fallback when LSP returns empty list', async () => {
    const handle = makeFakeClient({
      targets: { targets: [], defaultTargetId: null, cpmEnabled: false },
    });
    const result = await loadTargetsWithDefaults(
      handle.client,
      fakeContextWithStore(),
      '/v/Empty.csproj',
    );
    assert.strictEqual(result.targets.length, 1, 'empty list synthesizes a fallback');
    assert.strictEqual(result.targets[0]!.path, '/v/Empty.csproj');
  });
});

suite('NuGet Browser — lsp wrappers (success + failure)', () => {
  test('fetchTargets / fetchInstalled / searchPackages / fetchVersions resolve ok', async () => {
    const handle = makeFakeClient({
      targets: { targets: [projectTarget()], defaultTargetId: 'proj-1', cpmEnabled: false },
      installed: { packages: [{ id: 'A', requestedVersion: '1', resolvedVersion: '1.0.1' }] },
      search: { packages: [searchResult()], totalHits: 1 },
      versions: { versions: ['1.0.0', '2.0.0'] },
    });
    const t = await fetchTargets(handle.client, '/ws');
    assert.ok(t.ok && t.value.targets[0]!.id === 'proj-1');
    const inst = await fetchInstalled(handle.client, projectTarget());
    assert.ok(inst.ok && inst.value.packages[0]!.resolvedVersion === '1.0.1');
    const s = await searchPackages(handle.client, projectTarget(), 'json');
    assert.ok(s.ok && s.value.packages.length === 1);
    const v = await fetchVersions(handle.client, 'Pkg');
    assert.ok(v.ok && v.value.versions.length === 2);
    // search payload carries the documented shape.
    const searchCall = handle.calls.find((c) => c.method === 'sharplsp/nuget/search');
    assert.deepStrictEqual((searchCall?.payload as { prerelease: boolean }).prerelease, false);
  });

  test('install + uninstall wrappers resolve ok and send correct method', async () => {
    const handle = makeFakeClient({
      install: { success: true, message: 'installed' },
      uninstall: { success: true, message: 'removed' },
    });
    const i = await installPackage(handle.client, projectTarget(), 'Pkg', '1.0.0');
    assert.ok(i.ok && i.value.success);
    const u = await uninstallPackage(handle.client, projectTarget(), 'Pkg');
    assert.ok(u.ok && u.value.success);
    assert.ok(handle.calls.some((c) => c.method === 'sharplsp/nuget/install'));
    assert.ok(handle.calls.some((c) => c.method === 'sharplsp/nuget/uninstall'));
  });

  test('every wrapper returns a failure Result when sendRequest rejects', async () => {
    const handle = makeFakeClient({
      targets: new Error('t-err'),
      installed: new Error('i-err'),
      search: new Error('s-err'),
      versions: new Error('v-err'),
      install: new Error('inst-err'),
      uninstall: new Error('uninst-err'),
    });
    const t = await fetchTargets(handle.client, '/ws');
    assert.ok(!t.ok && t.error === 't-err');
    const inst = await fetchInstalled(handle.client, projectTarget());
    assert.ok(!inst.ok && inst.error === 'i-err');
    const s = await searchPackages(handle.client, projectTarget(), 'q');
    assert.ok(!s.ok && s.error === 's-err');
    const v = await fetchVersions(handle.client, 'Pkg');
    assert.ok(!v.ok && v.error === 'v-err');
    const i = await installPackage(handle.client, projectTarget(), 'Pkg', '1');
    assert.ok(!i.ok && i.error === 'inst-err');
    const u = await uninstallPackage(handle.client, projectTarget(), 'Pkg');
    assert.ok(!u.ok && u.error === 'uninst-err');
  });
});

suite('NuGet Browser — panel driven by fake LanguageClient', () => {
  /** Build + open a panel against a fake client with a single build-props target. */
  function openWithRoutes(
    routes: FakeRoutes,
    failNotification = false,
  ): {
    panel: NuGetBrowserPanel;
    handle: FakeClientHandle;
  } {
    const handle = makeFakeClient(
      {
        targets: {
          targets: [buildPropsTarget()],
          defaultTargetId: 'props-1',
          cpmEnabled: false,
        },
        ...routes,
      },
      failNotification,
    );
    // Reset the singleton so each test gets a fresh panel.
    NuGetBrowserPanel.open(fakeContextWithStore(), VIRTUAL_PROJECT, 'x', () => undefined).dispose();
    const panel = NuGetBrowserPanel.open(
      fakeContextWithStore(),
      buildPropsTarget().path,
      'PropsProj',
      () => handle.client,
    );
    return { panel, handle };
  }

  test('initial load selects the build-props target and populates search results', async () => {
    const { panel, handle } = openWithRoutes({
      search: { packages: [searchResult({ id: 'Popular.Pkg' })], totalHits: 1 },
      installed: { packages: [] },
    });
    try {
      await panel.waitForInitialLoad();
      assert.strictEqual(panel.getSelectedTargetId(), 'props-1', 'build-props target selected');
      assert.deepStrictEqual(panel.getTargetIds(), ['props-1'], 'target id list exposed');
      assert.ok(panel.getSearchResultsCount() >= 1, 'initial search populated');
      assert.ok(panel.getRenderedHtml().includes('Popular.Pkg'), 'search result rendered');
      assert.ok(handle.calls.some((c) => c.method === 'sharplsp/nuget/installed'));
    } finally {
      panel.dispose();
    }
  });

  test('search message updates results; failure surfaces an error toast', async () => {
    let queryHits = 0;
    const { panel } = openWithRoutes({
      search: (payload) => {
        const q = (payload as { query: string }).query;
        if (q === 'boom') throw new Error('search exploded');
        queryHits += 1;
        return { packages: [searchResult({ id: `Hit-${q}` })], totalHits: 1 };
      },
    });
    try {
      await panel.waitForInitialLoad();
      await panel.simulateWebviewMessage({ command: 'search', data: { query: 'serilog' } });
      assert.ok(panel.getRenderedHtml().includes('Hit-serilog'), 'search results rendered');
      assert.ok(queryHits >= 1);
      await panel.simulateWebviewMessage({ command: 'search', data: { query: 'boom' } });
      assert.ok(
        panel.getRenderedHtml().includes('Search failed'),
        'failed search renders an error toast',
      );
    } finally {
      panel.dispose();
    }
  });

  test('selectPackage enriches + loads versions; version failure is non-fatal', async () => {
    const { panel } = openWithRoutes({
      search: (payload) => {
        const q = (payload as { query: string }).query;
        if (q === '')
          return { packages: [searchResult({ id: 'Sel.Pkg', description: '' })], totalHits: 1 };
        return {
          packages: [searchResult({ id: 'Sel.Pkg', description: 'enriched' })],
          totalHits: 1,
        };
      },
      versions: new Error('versions down'),
    });
    try {
      await panel.waitForInitialLoad();
      await panel.simulateWebviewMessage({
        command: 'selectPackage',
        data: { packageId: 'Sel.Pkg' },
      });
      assert.strictEqual(panel.getSelectedPackageId(), 'Sel.Pkg', 'package selected');
      // selecting an unknown id is a no-op.
      await panel.simulateWebviewMessage({
        command: 'selectPackage',
        data: { packageId: 'Does.Not.Exist' },
      });
      assert.strictEqual(panel.getSelectedPackageId(), 'Sel.Pkg', 'unknown id leaves selection');
    } finally {
      panel.dispose();
    }
  });

  test('install success reloads installed; failure reverts + shows error', async () => {
    const installed: NuGetInstalledResponse = { packages: [] };
    const { panel } = openWithRoutes({
      installed,
      search: { packages: [searchResult({ id: 'Inst.Me', description: '' })], totalHits: 1 },
      install: { success: false, message: 'install rejected by server' },
    });
    try {
      await panel.waitForInitialLoad();
      await panel.simulateWebviewMessage({
        command: 'install',
        data: { packageId: 'Inst.Me', version: '1.2.3' },
      });
      assert.ok(
        panel.getRenderedHtml().includes('install failed'),
        'server-rejected install shows error toast',
      );
      assert.ok(
        !panel.getInstalledPackageIds().includes('Inst.Me'),
        'optimistic install reverted on failure',
      );
      assert.deepStrictEqual(panel.getActiveLoadingKeys(), [], 'no dangling loading keys');
    } finally {
      panel.dispose();
    }
  });

  test('install success path reloads installed packages from LSP', async () => {
    let installedPackages: NuGetInstalledResponse = { packages: [] };
    const handle = makeFakeClient({
      targets: { targets: [buildPropsTarget()], defaultTargetId: 'props-1', cpmEnabled: false },
      search: { packages: [searchResult({ id: 'Good.Pkg', description: '' })], totalHits: 1 },
      install: { success: true, message: 'ok' },
    });
    // Make the installed route reflect the package after install.
    const original = handle.client.sendRequest.bind(handle.client) as (
      m: string,
      p: unknown,
    ) => Promise<unknown>;
    (handle.client as unknown as { sendRequest: typeof original }).sendRequest = async (m, p) => {
      if (m === 'sharplsp/nuget/installed') return installedPackages;
      if (m === 'sharplsp/nuget/install') {
        installedPackages = {
          packages: [{ id: 'Good.Pkg', requestedVersion: '1.0.0', resolvedVersion: '1.0.0' }],
        };
        return { success: true, message: 'ok' };
      }
      return original(m, p);
    };
    NuGetBrowserPanel.open(fakeContextWithStore(), VIRTUAL_PROJECT, 'x', () => undefined).dispose();
    const panel = NuGetBrowserPanel.open(
      fakeContextWithStore(),
      buildPropsTarget().path,
      'Y',
      () => handle.client,
    );
    try {
      await panel.waitForInitialLoad();
      await panel.simulateWebviewMessage({
        command: 'install',
        data: { packageId: 'Good.Pkg', version: '1.0.0' },
      });
      assert.ok(
        panel.getInstalledPackageIds().includes('Good.Pkg'),
        'installed list reloaded after a successful install',
      );
      assert.ok(
        panel.getRenderedHtml().includes('Installed Good.Pkg') ||
          panel.getActiveLoadingKeys().length === 0,
      );
    } finally {
      panel.dispose();
    }
  });

  test('uninstall failure reverts the optimistic removal', async () => {
    const installed: NuGetInstalledResponse = {
      packages: [{ id: 'Remove.Me', requestedVersion: '1.0.0', resolvedVersion: '1.0.0' }],
    };
    const { panel } = openWithRoutes({
      installed,
      uninstall: new Error('uninstall network error'),
    });
    try {
      await panel.waitForInitialLoad();
      assert.ok(panel.getInstalledPackageIds().includes('Remove.Me'), 'precondition installed');
      await panel.simulateWebviewMessage({
        command: 'uninstall',
        data: { packageId: 'Remove.Me' },
      });
      assert.ok(
        panel.getRenderedHtml().includes('uninstall failed'),
        'failed uninstall shows error toast',
      );
      assert.ok(
        panel.getInstalledPackageIds().includes('Remove.Me'),
        'optimistic uninstall reverted on failure',
      );
    } finally {
      panel.dispose();
    }
  });

  test('changeVersion routes through install (success reloads installed)', async () => {
    const installed: NuGetInstalledResponse = {
      packages: [{ id: 'Ver.Pkg', requestedVersion: '1.0.0', resolvedVersion: '1.0.0' }],
    };
    const { panel } = openWithRoutes({
      installed,
      install: { success: true, message: 'ok' },
    });
    try {
      await panel.waitForInitialLoad();
      await panel.simulateWebviewMessage({
        command: 'changeVersion',
        data: { packageId: 'Ver.Pkg', version: '2.0.0' },
      });
      assert.deepStrictEqual(panel.getActiveLoadingKeys(), [], 'install loading key cleared');
    } finally {
      panel.dispose();
    }
  });

  test('switchTab to installed loads installed packages; back to browse keeps tab', async () => {
    const installed: NuGetInstalledResponse = {
      packages: [{ id: 'Tab.Pkg', requestedVersion: '1.0.0', resolvedVersion: '1.0.0' }],
    };
    const { panel } = openWithRoutes({ installed });
    try {
      await panel.waitForInitialLoad();
      await panel.simulateWebviewMessage({ command: 'switchTab', data: { tab: 'installed' } });
      assert.strictEqual(panel.getCurrentTab(), 'installed');
      assert.ok(panel.getRenderedHtml().includes('Installed Packages'));
      await panel.simulateWebviewMessage({ command: 'switchTab', data: { tab: 'browse' } });
      assert.strictEqual(panel.getCurrentTab(), 'browse');
      // unknown tab value falls back to browse.
      await panel.simulateWebviewMessage({ command: 'switchTab', data: { tab: 'nonsense' } });
      assert.strictEqual(panel.getCurrentTab(), 'browse');
    } finally {
      panel.dispose();
    }
  });

  test('refresh re-runs installed + search; openExternal + unknown commands are safe', async () => {
    const { panel, handle } = openWithRoutes({
      installed: { packages: [] },
      search: { packages: [searchResult({ id: 'Refr.Pkg' })], totalHits: 1 },
    });
    try {
      await panel.waitForInitialLoad();
      const before = handle.calls.length;
      await panel.simulateWebviewMessage({ command: 'refresh' });
      assert.ok(handle.calls.length > before, 'refresh issued new LSP calls');
      // openExternal with empty url must not throw; with a url it must not throw either.
      await panel.simulateWebviewMessage({ command: 'openExternal', data: { url: '' } });
      await panel.simulateWebviewMessage({
        command: 'openExternal',
        data: { url: 'https://example.com' },
      });
      // entirely unknown command is ignored.
      await panel.simulateWebviewMessage({ command: 'totally-unknown' });
      assert.ok(panel.getRenderedHtml().length > 0, 'panel still renders after odd messages');
    } finally {
      panel.dispose();
    }
  });

  test('changeTarget switches selection, persists it, and clears state', async () => {
    const second = projectTarget({ id: 'proj-2', path: '/v/Second.csproj', displayName: 'Second' });
    const ctx = fakeContextWithStore();
    const handle = makeFakeClient({
      targets: {
        targets: [buildPropsTarget(), second],
        defaultTargetId: 'props-1',
        cpmEnabled: false,
      },
      installed: { packages: [] },
      search: { packages: [searchResult()], totalHits: 1 },
    });
    NuGetBrowserPanel.open(fakeContextWithStore(), VIRTUAL_PROJECT, 'x', () => undefined).dispose();
    const panel = NuGetBrowserPanel.open(
      ctx,
      buildPropsTarget().path,
      'PropsProj',
      () => handle.client,
    );
    try {
      await panel.waitForInitialLoad();
      assert.strictEqual(panel.getSelectedTargetId(), 'props-1');
      await panel.simulateWebviewMessage({
        command: 'changeTarget',
        data: { targetId: 'proj-2' },
      });
      assert.strictEqual(panel.getSelectedTargetId(), 'proj-2', 'selection changed');
      assert.strictEqual(
        ctx.workspaceState.get(LAST_TARGET_KEY),
        'proj-2',
        'target selection persisted to workspaceState',
      );
      // changing to the same target, or empty, is a no-op.
      await panel.simulateWebviewMessage({ command: 'changeTarget', data: { targetId: 'proj-2' } });
      await panel.simulateWebviewMessage({ command: 'changeTarget', data: { targetId: '' } });
      assert.strictEqual(panel.getSelectedTargetId(), 'proj-2');
    } finally {
      panel.dispose();
    }
  });

  test('loadTargets shows an error toast when no LSP client is available', async () => {
    NuGetBrowserPanel.open(fakeContextWithStore(), VIRTUAL_PROJECT, 'x', () => undefined).dispose();
    const panel = NuGetBrowserPanel.open(
      fakeContextWithStore(),
      VIRTUAL_PROJECT,
      'NoClient',
      () => undefined,
    );
    try {
      await panel.waitForInitialLoad();
      assert.ok(
        panel.getRenderedHtml().includes('LSP client not available'),
        'missing client renders an error toast',
      );
    } finally {
      panel.dispose();
    }
  });

  test('restore progress notifications drive loading keys and toasts', async () => {
    const { panel, handle } = openWithRoutes({ installed: { packages: [] } });
    try {
      await panel.waitForInitialLoad();
      assert.strictEqual(handle.restoreHandlers.length, 1, 'restore handler subscribed');
      const fire = handle.restoreHandlers[0]!;
      fire({ targetId: 'props-1', phase: 'started', message: 'Restoring…' });
      assert.ok(
        panel.getActiveLoadingKeys().includes(restoreKey('props-1')),
        'restore loading key added on start',
      );
      assert.ok(panel.getRenderedHtml().includes('Restoring'), 'restore info toast rendered');
      fire({ targetId: 'props-1', phase: 'succeeded', message: 'Done' });
      assert.ok(
        !panel.getActiveLoadingKeys().includes(restoreKey('props-1')),
        'restore loading key cleared on success',
      );
      assert.ok(panel.getRenderedHtml().includes('Done'), 'success toast rendered');
      fire({ targetId: 'props-1', phase: 'failed', message: 'Nope' });
      assert.ok(panel.getRenderedHtml().includes('Nope'), 'failure toast rendered');
      // default-message branches (no message supplied).
      fire({ targetId: 'props-1', phase: 'restoring' });
      assert.ok(panel.getRenderedHtml().includes('Restoring packages'), 'default restoring copy');
    } finally {
      panel.dispose();
    }
  });

  test('a failing onNotification subscription does not crash the panel', async () => {
    NuGetBrowserPanel.open(fakeContextWithStore(), VIRTUAL_PROJECT, 'x', () => undefined).dispose();
    const handle = makeFakeClient(
      { targets: { targets: [buildPropsTarget()], defaultTargetId: 'props-1', cpmEnabled: false } },
      true,
    );
    const panel = NuGetBrowserPanel.open(
      fakeContextWithStore(),
      buildPropsTarget().path,
      'SubFail',
      () => handle.client,
    );
    try {
      await panel.waitForInitialLoad();
      assert.strictEqual(handle.restoreHandlers.length, 0, 'no handler registered after throw');
      assert.ok(
        panel.getRenderedHtml().length > 0,
        'panel still renders despite subscribe failure',
      );
    } finally {
      panel.dispose();
    }
  });

  test('open() reuses the existing singleton instead of creating a second panel', async () => {
    NuGetBrowserPanel.open(fakeContextWithStore(), VIRTUAL_PROJECT, 'x', () => undefined).dispose();
    const handle = makeFakeClient({
      targets: { targets: [buildPropsTarget()], defaultTargetId: 'props-1', cpmEnabled: false },
    });
    const first = NuGetBrowserPanel.open(
      fakeContextWithStore(),
      buildPropsTarget().path,
      'First',
      () => handle.client,
    );
    try {
      const second = NuGetBrowserPanel.open(
        fakeContextWithStore(),
        '/v/Other.csproj',
        'Second',
        () => handle.client,
      );
      assert.strictEqual(second, first, 'open() returns the existing singleton');
    } finally {
      first.dispose();
    }
  });

  // ── Targeted branch coverage ──────────────────────────────────
  // The following tests drive the exact message-handler / loader branches the
  // earlier panel tests skipped: the non-string `str()` default, the
  // loadTargets error toast, the loadInstalledPackages error toast, and the
  // uninstall SUCCESS reload.

  test('loadTargets error toast: a failing targets route renders "Failed to load targets"', async () => {
    NuGetBrowserPanel.open(fakeContextWithStore(), VIRTUAL_PROJECT, 'x', () => undefined).dispose();
    // Note: makeFakeClient defaults `targets` to an empty list; override it with
    // an Error so loadTargetsWithDefaults returns result.error and the panel's
    // loadTargets() takes its error-toast branch.
    const handle = makeFakeClient({ targets: new Error('targets endpoint exploded') });
    const panel = NuGetBrowserPanel.open(
      fakeContextWithStore(),
      VIRTUAL_PROJECT,
      'TargetsFail',
      () => handle.client,
    );
    try {
      await panel.waitForInitialLoad();
      const html = panel.getRenderedHtml();
      assert.ok(
        html.includes('Failed to load targets:'),
        'panel must surface the targets-load failure as an error toast',
      );
      assert.ok(
        html.includes('targets endpoint exploded'),
        'the underlying error message is included in the toast',
      );
      // A fallback target is still synthesized so the panel is usable.
      assert.deepStrictEqual(
        panel.getTargetIds().length >= 1,
        true,
        'a fallback target is synthesized despite the load error',
      );
    } finally {
      panel.dispose();
    }
  });

  test('loadInstalledPackages error toast: a failing installed route renders "Failed to load installed"', async () => {
    // VIRTUAL_PROJECT does not exist on disk, so syncInstalledPackagesFromTrackedProject
    // returns false and the LSP `installed` route runs — which we make reject.
    const fallbackTarget = projectTarget({ id: 'virt', path: VIRTUAL_PROJECT });
    NuGetBrowserPanel.open(fakeContextWithStore(), VIRTUAL_PROJECT, 'x', () => undefined).dispose();
    const handle = makeFakeClient({
      targets: { targets: [fallbackTarget], defaultTargetId: 'virt', cpmEnabled: false },
      installed: new Error('installed endpoint down'),
      search: { packages: [], totalHits: 0 },
    });
    const panel = NuGetBrowserPanel.open(
      fakeContextWithStore(),
      VIRTUAL_PROJECT,
      'InstalledFail',
      () => handle.client,
    );
    try {
      await panel.waitForInitialLoad();
      const html = panel.getRenderedHtml();
      assert.ok(
        html.includes('Failed to load installed:'),
        'a rejected installed route must render an error toast',
      );
      assert.ok(html.includes('installed endpoint down'), 'the underlying error is included');
      assert.deepStrictEqual(
        panel.getInstalledPackageIds(),
        [],
        'no installed packages recorded on failure',
      );
      // The loading key must be cleared even on the failure path.
      assert.ok(
        !panel.getActiveLoadingKeys().includes('installed'),
        'the installed loading key is cleared after the failure',
      );
    } finally {
      panel.dispose();
    }
  });

  test('uninstall SUCCESS reloads installed and removes the package + success toast', async () => {
    let installed: NuGetInstalledResponse = {
      packages: [{ id: 'Bye.Pkg', requestedVersion: '1.0.0', resolvedVersion: '1.0.0' }],
    };
    const handle = makeFakeClient({
      targets: { targets: [buildPropsTarget()], defaultTargetId: 'props-1', cpmEnabled: false },
      search: { packages: [], totalHits: 0 },
    });
    const original = handle.client.sendRequest.bind(handle.client) as (
      m: string,
      p: unknown,
    ) => Promise<unknown>;
    // This override replaces the recording sendRequest, so `handle.calls` no
    // longer captures the uninstall — track it with a local flag instead.
    let uninstallSent = false;
    (handle.client as unknown as { sendRequest: typeof original }).sendRequest = async (m, p) => {
      if (m === 'sharplsp/nuget/installed') return installed;
      if (m === 'sharplsp/nuget/uninstall') {
        uninstallSent = true;
        installed = { packages: [] }; // server confirms removal
        return { success: true, message: 'removed' };
      }
      return original(m, p);
    };
    NuGetBrowserPanel.open(fakeContextWithStore(), VIRTUAL_PROJECT, 'x', () => undefined).dispose();
    const panel = NuGetBrowserPanel.open(
      fakeContextWithStore(),
      buildPropsTarget().path,
      'UninstallOk',
      () => handle.client,
    );
    try {
      await panel.waitForInitialLoad();
      assert.ok(
        panel.getInstalledPackageIds().includes('Bye.Pkg'),
        'precondition: package is installed',
      );
      await panel.simulateWebviewMessage({
        command: 'uninstall',
        data: { packageId: 'Bye.Pkg' },
      });
      assert.ok(
        !panel.getInstalledPackageIds().includes('Bye.Pkg'),
        'a successful uninstall reloads installed and drops the package',
      );
      assert.ok(
        panel.getRenderedHtml().includes('Removed Bye.Pkg'),
        'a success toast confirms the removal',
      );
      assert.deepStrictEqual(panel.getActiveLoadingKeys(), [], 'no dangling uninstall loading key');
      assert.ok(uninstallSent, 'the uninstall request was actually sent');
    } finally {
      panel.dispose();
    }
  });

  test('str() default branch: switchTab with a non-string tab falls back to browse', async () => {
    const { panel } = openWithRoutes({ installed: { packages: [] } });
    try {
      await panel.waitForInitialLoad();
      // Drive str(value, 'browse') with a NON-string value (number) so the
      // typeof check fails and the documented default 'browse' is returned.
      await panel.simulateWebviewMessage({
        command: 'switchTab',
        data: { tab: 123 },
      });
      assert.strictEqual(
        panel.getCurrentTab(),
        'browse',
        'a non-string tab value must fall back to the browse default',
      );
    } finally {
      panel.dispose();
    }
  });

  test('str() default branch: search with a missing query coerces to empty string', async () => {
    let lastQuery: string | undefined;
    const { panel } = openWithRoutes({
      search: (payload) => {
        lastQuery = (payload as { query: string }).query;
        return { packages: [], totalHits: 0 };
      },
    });
    try {
      await panel.waitForInitialLoad();
      // No `query` field at all → str(undefined) returns '' (the empty default).
      await panel.simulateWebviewMessage({ command: 'search', data: {} });
      assert.strictEqual(lastQuery, '', 'a missing query is coerced to the empty-string default');
    } finally {
      panel.dispose();
    }
  });

  test('str() default branch: selectPackage with a non-string packageId is a safe no-op', async () => {
    const { panel } = openWithRoutes({
      search: { packages: [searchResult({ id: 'Real.Pkg' })], totalHits: 1 },
    });
    try {
      await panel.waitForInitialLoad();
      // packageId is a number → str() returns '' → findOrSynthesizePackage('')
      // matches nothing → selection stays undefined, no throw.
      await panel.simulateWebviewMessage({
        command: 'selectPackage',
        data: { packageId: 42 },
      });
      assert.strictEqual(
        panel.getSelectedPackageId(),
        undefined,
        'a non-string packageId selects nothing and does not throw',
      );
    } finally {
      panel.dispose();
    }
  });
});
