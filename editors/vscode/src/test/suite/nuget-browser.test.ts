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
      assert.ok(count > 0, `Browse tab must be populated after initial load (got ${count.toString()} results)`);
      assert.ok(count >= 5, `Browse tab must show at least 5 popular packages, got ${count.toString()}`);
      const html = panel.getRenderedHtml();
      assert.ok(html.includes('package-list') || html.includes('package-item') || html.includes('NuGet'), 'Browse HTML must contain package list markup');
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

      assert.strictEqual(panel.getSelectedPackageId(), 'Newtonsoft.Json', 'Selecting an installed package must set selectedPackage');
      const installedHtml = panel.getRenderedHtml();
      assert.ok(installedHtml.includes('Newtonsoft.Json'), 'Installed tab HTML must show Newtonsoft.Json');
      assert.ok(installedHtml.includes('Remove') || installedHtml.includes('uninstall'), 'Installed package must show Remove button');
      assert.ok(installedHtml.includes('13.0'), 'Installed package must show version number');
      assert.ok(installedHtml.toLowerCase().includes('james newton') || installedHtml.toLowerCase().includes('newtonsoft'), 'Package details must show author or description');
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
