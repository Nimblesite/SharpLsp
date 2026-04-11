import * as vscode from "vscode";
import { type LanguageClient } from "vscode-languageclient/node";
import * as log from "./log.js";
import {
    buildHtml,
    type RenderState,
    type ToastState,
} from "./nuget-browser/html.js";
import {
    fetchInstalled,
    fetchVersions,
    installPackage,
    type LspResult,
    searchPackages,
    uninstallPackage,
} from "./nuget-browser/lsp.js";
import {
    applyOptimisticInstall,
    applyOptimisticUninstall,
    buildInstallToast,
    buildUninstallToast,
    enrichPackageMetadata,
    findOrSynthesizePackage,
    revertOptimisticInstall,
    revertOptimisticUninstall,
} from "./nuget-browser/mutate.js";
import {
    loadTargetsWithDefaults,
    persistTargetSelection,
} from "./nuget-browser/target-store.js";
import {
    installKey,
    type LoadingKey,
    type NuGetSearchResult,
    type NuGetTarget,
    type RestoreProgressParams,
    restoreKey,
    uninstallKey,
    type WebviewMessage,
} from "./nuget-browser/types.js";

// Re-export types so existing call sites and tests keep working.
export type {
    NuGetSearchResult,
    WebviewMessage,
} from "./nuget-browser/types.js";

// ── Panel ───────────────────────────────────────────────────────

export class NuGetBrowserPanel {
    private static instance: NuGetBrowserPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private readonly initialProjectPath: string;
    private readonly projectName: string;
    private readonly getClient: () => LanguageClient | undefined;
    private restoreProgressDisposable: vscode.Disposable | undefined;

    // ── Reactive state ──
    private targets: NuGetTarget[] = [];
    private targetsLoading = false;
    private selectedTargetId: string | undefined;
    private currentTab: "browse" | "installed" = "browse";
    private currentSearchQuery = "";
    private searchResults: NuGetSearchResult[] = [];
    private readonly installedPackages = new Map<string, string>();
    private selectedPackage: NuGetSearchResult | undefined;
    private readonly loading = new Set<LoadingKey>();
    private toast: ToastState | undefined;

    /** Resolves when the constructor's async initial load completes. */
    private readonly initialLoadDone: Promise<void>;

    private constructor(
        context: vscode.ExtensionContext,
        projectPath: string,
        projectName: string,
        getClient: () => LanguageClient | undefined,
    ) {
        this.context = context;
        this.initialProjectPath = projectPath;
        this.projectName = projectName;
        this.getClient = getClient;

        log.info(`NuGetBrowserPanel: creating panel for ${projectName}`);
        this.panel = vscode.window.createWebviewPanel(
            "nugetBrowser",
            `NuGet: ${projectName}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [],
            },
        );

        this.panel.onDidDispose(
            () => {
                log.info("NuGetBrowserPanel: panel disposed");
                this.restoreProgressDisposable?.dispose();
                NuGetBrowserPanel.instance = undefined;
            },
            null,
            this.context.subscriptions,
        );

        this.panel.webview.onDidReceiveMessage(
            (message: WebviewMessage) => {
                void this.handleMessage(message);
            },
            null,
            this.context.subscriptions,
        );

        this.subscribeToRestoreProgress();
        this.initialLoadDone = this.initialLoad();
    }

    public static open(
        context: vscode.ExtensionContext,
        projectPath: string,
        projectName: string,
        getClient: () => LanguageClient | undefined,
    ): NuGetBrowserPanel {
        if (NuGetBrowserPanel.instance !== undefined) {
            log.info("NuGetBrowserPanel: reusing existing panel, revealing");
            NuGetBrowserPanel.instance.panel.reveal(vscode.ViewColumn.One);
            return NuGetBrowserPanel.instance;
        }
        log.info(`NuGetBrowserPanel: creating new instance for ${projectName}`);
        NuGetBrowserPanel.instance = new NuGetBrowserPanel(
            context,
            projectPath,
            projectName,
            getClient,
        );
        return NuGetBrowserPanel.instance;
    }

    public dispose(): void {
        this.panel.dispose();
    }

    // ── Initial load ────────────────────────────────────────────

    private async initialLoad(): Promise<void> {
        await this.loadTargets();
        if (this.selectedTargetId !== undefined) {
            await this.loadInstalledPackages();
            await this.performSearch("");
        }
        this.updateContent();
        log.info("NuGetBrowserPanel: initial load complete");
    }

    // ── Test accessors ──────────────────────────────────────────
    public async waitForInitialLoad(): Promise<void> {
        await this.initialLoadDone;
    }
    public getSearchResultsCount(): number {
        return this.searchResults.length;
    }
    public getInstalledPackageIds(): string[] {
        return Array.from(this.installedPackages.keys());
    }
    public getSelectedPackageId(): string | undefined {
        return this.selectedPackage?.id;
    }
    public getCurrentTab(): "browse" | "installed" {
        return this.currentTab;
    }
    public getRenderedHtml(): string {
        return this.panel.webview.html;
    }
    public getSelectedTargetId(): string | undefined {
        return this.selectedTargetId;
    }
    public getTargetIds(): string[] {
        return this.targets.map((t) => t.id);
    }
    public getActiveLoadingKeys(): string[] {
        return Array.from(this.loading);
    }
    public async simulateWebviewMessage(m: WebviewMessage): Promise<void> {
        await this.handleMessage(m);
    }

    // ── Restore progress subscription ───────────────────────────

    private subscribeToRestoreProgress(): void {
        const lsp = this.getClient();
        if (lsp === undefined) return;
        try {
            this.restoreProgressDisposable = lsp.onNotification(
                "forge/nuget/restoreProgress",
                (params: RestoreProgressParams) => {
                    this.handleRestoreProgress(params);
                },
            );
        } catch (err: unknown) {
            log.error(
                `NuGetBrowserPanel: failed to subscribe to restoreProgress: ${String(err)}`,
            );
        }
    }

    private handleRestoreProgress(params: RestoreProgressParams): void {
        const key = restoreKey(params.targetId);
        switch (params.phase) {
            case "started":
            case "restoring":
                this.loading.add(key);
                this.toast = {
                    kind: "info",
                    text: params.message ?? "Restoring packages…",
                };
                break;
            case "succeeded":
                this.loading.delete(key);
                this.toast = {
                    kind: "success",
                    text: params.message ?? "Restore succeeded",
                };
                this.scheduleToastClear(2000);
                break;
            case "failed":
                this.loading.delete(key);
                this.toast = {
                    kind: "error",
                    text: params.message ?? "Restore failed",
                };
                this.scheduleToastClear(5000);
                break;
        }
        this.updateContent();
    }

    private scheduleToastClear(ms: number): void {
        setTimeout(() => {
            this.toast = undefined;
            this.updateContent();
        }, ms);
    }

    // ── Message handling ────────────────────────────────────────

    private async handleMessage(message: WebviewMessage): Promise<void> {
        log.info(
            `NuGetBrowserPanel: received message command=${message.command}`,
        );
        switch (message.command) {
            case "search":
                await this.performSearch(this.str(message.data?.query));
                break;
            case "selectPackage":
                await this.handleSelectPackage(
                    this.str(message.data?.packageId),
                );
                break;
            case "install":
                await this.handleInstall(
                    this.str(message.data?.packageId),
                    this.str(message.data?.version),
                );
                break;
            case "uninstall":
                await this.handleUninstall(this.str(message.data?.packageId));
                break;
            case "changeVersion":
                await this.handleChangeVersion(
                    this.str(message.data?.packageId),
                    this.str(message.data?.version),
                );
                break;
            case "switchTab":
                await this.handleSwitchTab(
                    this.str(message.data?.tab, "browse"),
                );
                break;
            case "changeTarget":
                await this.handleChangeTarget(this.str(message.data?.targetId));
                break;
            case "refresh":
                await this.refresh();
                break;
            case "openExternal": {
                const url = this.str(message.data?.url);
                if (url.length > 0)
                    void vscode.env.openExternal(vscode.Uri.parse(url));
                break;
            }
        }
    }

    private str(value: unknown, defaultValue = ""): string {
        if (typeof value === "string") return value;
        return defaultValue;
    }

    // ── Targets ─────────────────────────────────────────────────

    private async loadTargets(): Promise<void> {
        this.targetsLoading = true;
        this.updateContent();
        const lsp = this.getClient();
        if (lsp === undefined) {
            this.targetsLoading = false;
            this.toast = { kind: "error", text: "LSP client not available" };
            this.updateContent();
            return;
        }
        const result = await loadTargetsWithDefaults(
            lsp,
            this.context,
            this.initialProjectPath,
        );
        this.targetsLoading = false;
        this.targets = result.targets;
        this.selectedTargetId = result.selectedTargetId;
        if (result.error !== undefined) {
            this.toast = {
                kind: "error",
                text: `Failed to load targets: ${result.error}`,
            };
        }
        this.updateContent();
    }

    private currentTarget(): NuGetTarget | undefined {
        return this.targets.find((t) => t.id === this.selectedTargetId);
    }

    private async handleChangeTarget(targetId: string): Promise<void> {
        if (targetId === "" || targetId === this.selectedTargetId) return;
        log.info(`NuGetBrowserPanel: switching target to ${targetId}`);
        this.selectedTargetId = targetId;
        await persistTargetSelection(this.context, targetId);
        this.installedPackages.clear();
        this.searchResults = [];
        this.selectedPackage = undefined;
        this.updateContent();
        await this.loadInstalledPackages();
        await this.performSearch(this.currentSearchQuery);
    }

    // ── LSP-backed actions ──────────────────────────────────────

    private async loadInstalledPackages(): Promise<void> {
        const target = this.currentTarget();
        const lsp = this.getClient();
        if (target === undefined || lsp === undefined) return;
        this.loading.add("installed");
        this.updateContent();
        const result = await fetchInstalled(lsp, target);
        this.loading.delete("installed");
        if (!result.ok) {
            this.toast = {
                kind: "error",
                text: `Failed to load installed: ${result.error}`,
            };
            this.updateContent();
            return;
        }
        this.installedPackages.clear();
        for (const pkg of result.value.packages) {
            this.installedPackages.set(pkg.id, pkg.resolvedVersion);
        }
        log.info(
            `NuGetBrowserPanel: loaded ${this.installedPackages.size.toString()} installed packages`,
        );
        this.updateContent();
    }

    private async performSearch(query: string): Promise<void> {
        this.currentSearchQuery = query;
        const target = this.currentTarget();
        const lsp = this.getClient();
        if (target === undefined || lsp === undefined) return;
        this.loading.add("search");
        this.updateContent();
        const result = await searchPackages(lsp, target, query);
        this.loading.delete("search");
        if (!result.ok) {
            this.toast = {
                kind: "error",
                text: `Search failed: ${result.error}`,
            };
            this.updateContent();
            return;
        }
        this.searchResults = result.value.packages;
        log.info(
            `NuGetBrowserPanel: search returned ${this.searchResults.length.toString()} results`,
        );
        this.updateContent();
    }

    private async handleSelectPackage(packageId: string): Promise<void> {
        const pkg = findOrSynthesizePackage(
            this.searchResults,
            this.installedPackages,
            packageId,
        );
        if (pkg === undefined) return;
        this.selectedPackage = pkg;
        this.updateContent();
        const target = this.currentTarget();
        const lsp = this.getClient();
        if (
            target !== undefined &&
            lsp !== undefined &&
            pkg.description.length === 0
        ) {
            await enrichPackageMetadata(lsp, target, pkg);
        }
        await this.loadPackageVersions(pkg);
        this.updateContent();
    }

    private async loadPackageVersions(pkg: NuGetSearchResult): Promise<void> {
        const lsp = this.getClient();
        if (lsp === undefined) return;
        this.loading.add("versions");
        this.updateContent();
        const result = await fetchVersions(lsp, pkg.id);
        this.loading.delete("versions");
        if (!result.ok) {
            log.error(
                `NuGetBrowserPanel: failed to load versions for ${pkg.id}: ${result.error}`,
            );
            this.updateContent();
            return;
        }
        pkg._versions = result.value.versions;
        this.updateContent();
    }

    private async handleInstall(
        packageId: string,
        version: string,
    ): Promise<void> {
        const target = this.currentTarget();
        const lsp = this.getClient();
        if (target === undefined || lsp === undefined) return;

        const snapshot = applyOptimisticInstall(
            this.installedPackages,
            this.searchResults,
            packageId,
            version,
        );
        const installLoadKey = installKey(packageId);
        this.loading.add(installLoadKey);
        this.toast = {
            kind: "info",
            text: buildInstallToast(target, packageId, version),
        };
        this.updateContent();

        const result = await installPackage(lsp, target, packageId, version);
        this.loading.delete(installLoadKey);

        if (this.handleMutationResult(result, "install", packageId)) {
            await this.loadInstalledPackages();
        } else {
            revertOptimisticInstall(
                this.installedPackages,
                packageId,
                snapshot,
            );
            this.updateContent();
        }
    }

    private async handleUninstall(packageId: string): Promise<void> {
        const target = this.currentTarget();
        const lsp = this.getClient();
        if (target === undefined || lsp === undefined) return;

        const snapshot = applyOptimisticUninstall(
            this.installedPackages,
            this.searchResults,
            packageId,
        );
        const uninstallLoadKey = uninstallKey(packageId);
        this.loading.add(uninstallLoadKey);
        this.toast = {
            kind: "info",
            text: buildUninstallToast(target, packageId),
        };
        this.updateContent();

        const result = await uninstallPackage(lsp, target, packageId);
        this.loading.delete(uninstallLoadKey);

        if (this.handleMutationResult(result, "uninstall", packageId)) {
            await this.loadInstalledPackages();
        } else {
            revertOptimisticUninstall(
                this.installedPackages,
                packageId,
                snapshot,
            );
            this.updateContent();
        }
    }

    private async handleChangeVersion(
        packageId: string,
        version: string,
    ): Promise<void> {
        await this.handleInstall(packageId, version);
    }

    private async handleSwitchTab(tabValue: string): Promise<void> {
        this.currentTab = tabValue === "installed" ? "installed" : "browse";
        if (this.currentTab === "installed") await this.loadInstalledPackages();
        this.updateContent();
    }

    private async refresh(): Promise<void> {
        await this.loadInstalledPackages();
        await this.performSearch(this.currentSearchQuery);
    }

    private handleMutationResult(
        result: LspResult<{ success: boolean; message: string }>,
        op: "install" | "uninstall",
        packageId: string,
    ): boolean {
        const errorText = !result.ok
            ? result.error
            : !result.value.success
              ? result.value.message
              : undefined;
        if (errorText !== undefined) {
            const text = `${op} failed: ${errorText}`;
            this.toast = { kind: "error", text };
            void vscode.window.showErrorMessage(text);
            return false;
        }
        const verb = op === "install" ? "Installed" : "Removed";
        this.toast = { kind: "success", text: `${verb} ${packageId}` };
        this.scheduleToastClear(2000);
        return true;
    }

    // ── Rendering ───────────────────────────────────────────────

    private updateContent(): void {
        log.info(
            `NuGetBrowserPanel: rendering tab=${this.currentTab} packages=${this.searchResults.length.toString()} installed=${this.installedPackages.size.toString()} loading=${this.loading.size.toString()}`,
        );
        const state: RenderState = {
            projectName: this.projectName,
            currentTab: this.currentTab,
            currentSearchQuery: this.currentSearchQuery,
            targets: this.targets,
            selectedTargetId: this.selectedTargetId,
            targetsLoading: this.targetsLoading,
            searchResults: this.searchResults,
            installedPackages: this.installedPackages,
            selectedPackage: this.selectedPackage,
            loading: this.loading,
            toast: this.toast,
        };
        this.panel.webview.html = buildHtml(state);
    }
}
