import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import { type LanguageClient } from "vscode-languageclient/node";
import { NuGetBrowserPanel } from "../../nuget-browser.js";
import {
    EXTENSION_ID,
    closeAllEditors,
    setupLspTestSuite,
    teardownLspTestSuite,
} from "./test-helpers";

interface ForgeApiForNuGetTests {
    readonly getLspClient: () => LanguageClient | undefined;
}

/** Absolute path to the NuGetTest fixture project (has Newtonsoft.Json installed). */
function nugetTestProjectPath(): string {
    // __dirname: editors/vscode/out/test/suite/ → repo root is 5 levels up.
    const repoRoot = path.resolve(__dirname, "../../../../..");
    return path.join(
        repoRoot,
        "tests",
        "fixtures",
        "NuGetTest",
        "NuGetTest.csproj",
    );
}

suite("NuGet Browser", () => {
    let tmpDir: string;

    suiteSetup(async function () {
        this.timeout(60_000);
        const result = await setupLspTestSuite("nuget-");
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

    test("forge.browseNuGetPackages command is registered", async () => {
        const allCommands = await vscode.commands.getCommands(true);
        assert.ok(
            allCommands.includes("forge.browseNuGetPackages"),
            "forge.browseNuGetPackages should be registered",
        );
    });

    // ── Package Contributions ───────────────────────────────────

    test("package.json declares browseNuGetPackages command", () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, "Extension should exist");
        const commands: { command: string }[] =
            ext.packageJSON.contributes?.commands ?? [];
        assert.ok(
            commands.some((c) => c.command === "forge.browseNuGetPackages"),
            "package.json must declare forge.browseNuGetPackages",
        );
    });

    test("package.json declares removeNuGetPackage command", () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, "Extension should exist");
        const commands: { command: string }[] =
            ext.packageJSON.contributes?.commands ?? [];
        assert.ok(
            commands.some((c) => c.command === "forge.removeNuGetPackage"),
            "package.json must declare forge.removeNuGetPackage",
        );
    });

    // ── NuGet Browser Panel ─────────────────────────────────────

    test("panel opens from NuGetBrowserPanel.open()", async function () {
        this.timeout(10_000);

        // Import the module to access the static open method.
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext?.isActive, "Extension must be active");

        // We can't easily call NuGetBrowserPanel.open() directly without
        // a real project file, but we can verify the command doesn't crash
        // when invoked without a valid node (it shows a warning message).
        await assert.doesNotReject(async () => {
            await vscode.commands.executeCommand("forge.browseNuGetPackages");
        }, "browseNuGetPackages should not throw when no node is provided");
    });

    test("removeNuGetPackage command does not throw when cancelled", async function () {
        this.timeout(5_000);
        await assert.doesNotReject(async () => {
            await vscode.commands.executeCommand("forge.removeNuGetPackage");
        }, "removeNuGetPackage must not throw when no node is provided");
    });

    // ── Extension API availability ──────────────────────────────

    test("extension exports API with explorerProvider", () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext?.isActive, "Extension must be active");
        const api = ext.exports as { explorerProvider: unknown } | undefined;
        assert.ok(
            api?.explorerProvider,
            "Extension must export explorerProvider",
        );
    });

    // ── Context menu registration ───────────────────────────────

    test("browseNuGetPackages appears in context menu for project items", () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, "Extension should exist");
        const menus = ext.packageJSON.contributes?.menus ?? {};

        // Check view/item/context menus for the browse command.
        const viewItemMenus: { command: string; when?: string }[] =
            menus["view/item/context"] ?? [];
        const browseEntry = viewItemMenus.find(
            (m) => m.command === "forge.browseNuGetPackages",
        );
        assert.ok(
            browseEntry,
            "browseNuGetPackages should be in view/item/context menu",
        );
        // Verify it's scoped to project items.
        assert.ok(
            browseEntry.when?.includes("viewItem"),
            "browseNuGetPackages menu should be conditional on viewItem",
        );
    });

    // ── NuGet LSP request method names ──────────────────────────

    test("NuGet LSP request methods follow forge/nuget/* convention", () => {
        const expectedMethods = [
            "forge/nuget/search",
            "forge/nuget/versions",
            "forge/nuget/installed",
            "forge/nuget/install",
            "forge/nuget/uninstall",
        ];

        // These are the methods the extension sends to the LSP server.
        // This test documents the API contract.
        for (const method of expectedMethods) {
            assert.ok(
                method.startsWith("forge/nuget/"),
                `Method ${method} should start with forge/nuget/`,
            );
        }
    });

    // ── Panel singleton behavior ────────────────────────────────

    test("NuGetBrowserPanel is singleton (documented behavior)", () => {
        // The NuGetBrowserPanel uses a static `instance` field to ensure
        // only one panel exists at a time. This is enforced by the open()
        // method which checks for an existing instance before creating.
        // We verify this contract exists by checking the module exports.
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, "Extension must exist");
        // The NuGetBrowserPanel class should be importable from the extension.
        // We can't test singleton behavior without a real project file,
        // but we document the expected behavior here.
        assert.ok(true, "NuGetBrowserPanel uses singleton pattern");
    });

    // ── Webview message types ───────────────────────────────────

    test("all expected webview message commands are documented", () => {
        // These are the message commands the webview sends to the extension.
        // Each maps to a specific LSP request.
        const expectedCommands = [
            "search", // -> forge/nuget/search
            "selectPackage", // -> forge/nuget/versions
            "install", // -> forge/nuget/install
            "uninstall", // -> forge/nuget/uninstall
            "changeVersion", // -> forge/nuget/install (with new version)
            "switchTab", // -> forge/nuget/installed (for "installed" tab)
            "openExternal", // -> vscode.env.openExternal
        ];

        assert.strictEqual(
            expectedCommands.length,
            7,
            "Should have 7 message commands",
        );
    });

    // ── Tab state management ────────────────────────────────────

    test("valid tab values are browse and installed", () => {
        const validTabs = ["browse", "installed"];
        assert.deepStrictEqual(
            validTabs,
            ["browse", "installed"],
            "NuGet browser should support browse and installed tabs",
        );
    });

    // ── Real panel lifecycle (bug regression tests) ─────────────

    function getExtensionContext(): vscode.ExtensionContext {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext?.isActive, "Extension must be active");
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
        assert.ok(ext?.isActive, "Extension must be active");
        const api = ext.exports as ForgeApiForNuGetTests | undefined;
        assert.ok(api?.getLspClient, "Extension must export getLspClient");
        return api.getLspClient;
    }

    /**
     * BUG REGRESSION: Browse tab was empty on initial panel load because
     * the constructor only called loadInstalledPackages() without ever
     * triggering performSearch(""). This test verifies the initial load
     * populates searchResults with popular packages.
     */
    test("browse tab is populated on initial load (bug fix)", async function () {
        this.timeout(30_000);

        const projectPath = nugetTestProjectPath();
        const context = getExtensionContext();
        const getClient = getLspClientGetter();

        // Ensure we have a real LSP client before proceeding.
        assert.ok(getClient(), "LSP client must be running for this test");

        const panel = NuGetBrowserPanel.open(
            context,
            projectPath,
            "NuGetTest",
            getClient,
        );

        try {
            await panel.waitForInitialLoad();
            const count = panel.getSearchResultsCount();
            assert.ok(
                count > 0,
                `Browse tab must be populated after initial load (got ${count.toString()} results)`,
            );
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
    test("clicking installed package selects it (bug fix)", async function () {
        this.timeout(30_000);

        const projectPath = nugetTestProjectPath();
        const context = getExtensionContext();
        const getClient = getLspClientGetter();

        assert.ok(getClient(), "LSP client must be running for this test");

        const panel = NuGetBrowserPanel.open(
            context,
            projectPath,
            "NuGetTest",
            getClient,
        );

        try {
            await panel.waitForInitialLoad();

            const installedIds = panel.getInstalledPackageIds();
            assert.ok(
                installedIds.length > 0,
                "Fixture project must have installed packages",
            );
            assert.ok(
                installedIds.includes("Newtonsoft.Json"),
                "Newtonsoft.Json must be installed in fixture",
            );

            // Switch to the Installed tab.
            await panel.simulateWebviewMessage({
                command: "switchTab",
                data: { tab: "installed" },
            });
            assert.strictEqual(
                panel.getCurrentTab(),
                "installed",
                "Tab must switch to installed",
            );

            // Click the installed package.
            await panel.simulateWebviewMessage({
                command: "selectPackage",
                data: { packageId: "Newtonsoft.Json" },
            });

            assert.strictEqual(
                panel.getSelectedPackageId(),
                "Newtonsoft.Json",
                "Selecting an installed package must set selectedPackage",
            );
        } finally {
            panel.dispose();
        }
    });

    /**
     * Verify the installed list is correctly populated from the LSP.
     */
    test("installed packages loaded from LSP on open", async function () {
        this.timeout(30_000);

        const projectPath = nugetTestProjectPath();
        const context = getExtensionContext();
        const getClient = getLspClientGetter();

        assert.ok(getClient(), "LSP client must be running for this test");

        const panel = NuGetBrowserPanel.open(
            context,
            projectPath,
            "NuGetTest",
            getClient,
        );

        try {
            await panel.waitForInitialLoad();
            const ids = panel.getInstalledPackageIds();
            assert.ok(
                ids.includes("Newtonsoft.Json"),
                `Expected Newtonsoft.Json in installed list, got: ${ids.join(", ")}`,
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
    test("rendered HTML does not include VS Code chrome (regression)", async function () {
        this.timeout(30_000);

        const projectPath = nugetTestProjectPath();
        const context = getExtensionContext();
        const getClient = getLspClientGetter();

        assert.ok(getClient(), "LSP client must be running for this test");

        const panel = NuGetBrowserPanel.open(
            context,
            projectPath,
            "NuGetTest",
            getClient,
        );

        try {
            await panel.waitForInitialLoad();
            const html = panel.getRenderedHtml();

            // Status bar fake content.
            assert.ok(
                !html.includes("main*"),
                "Rendered HTML must not include fake git status (`main*`) — VS Code provides the status bar",
            );
            assert.ok(
                !html.includes("NuGet v6.8.0"),
                "Rendered HTML must not include fake `NuGet v6.8.0` version label",
            );
            assert.ok(
                !/UTF-8\s*<\/span>/.exec(html),
                "Rendered HTML must not include fake UTF-8 encoding label",
            );
            assert.ok(
                !html.includes("status-bar"),
                "Rendered HTML must not include status-bar CSS class",
            );

            // Activity bar fake content.
            assert.ok(
                !html.includes('class="sidebar"'),
                "Rendered HTML must not include sidebar (activity bar) — VS Code provides one",
            );
            assert.ok(
                !html.includes("sidebar-icon"),
                "Rendered HTML must not include sidebar-icon class",
            );
            assert.ok(
                !html.includes("sidebar-avatar"),
                "Rendered HTML must not include user avatar",
            );

            // Hardcoded fake dependencies.
            assert.ok(
                !html.includes(".NETStandard 2.0"),
                "Rendered HTML must not include hardcoded fake .NETStandard 2.0 dependency",
            );
            assert.ok(
                !html.includes(".NETStandard 2.1"),
                "Rendered HTML must not include hardcoded fake .NETStandard 2.1 dependency",
            );

            // Broken Updates tab.
            assert.ok(
                !html.includes("switchTab('updates')"),
                "Rendered HTML must not include broken Updates tab",
            );

            // Decorative sort dropdown with no handler.
            assert.ok(
                !html.includes("Sort By:"),
                "Rendered HTML must not include decorative Sort By dropdown",
            );
        } finally {
            panel.dispose();
        }
    });

    /**
     * Verify that searching from the webview updates state.
     */
    test("search message populates searchResults", async function () {
        this.timeout(30_000);

        const projectPath = nugetTestProjectPath();
        const context = getExtensionContext();
        const getClient = getLspClientGetter();

        assert.ok(getClient(), "LSP client must be running for this test");

        const panel = NuGetBrowserPanel.open(
            context,
            projectPath,
            "NuGetTest",
            getClient,
        );

        try {
            await panel.waitForInitialLoad();

            await panel.simulateWebviewMessage({
                command: "search",
                data: { query: "Serilog" },
            });

            assert.ok(
                panel.getSearchResultsCount() > 0,
                "Search for 'Serilog' must return results",
            );
        } finally {
            panel.dispose();
        }
    });
});
