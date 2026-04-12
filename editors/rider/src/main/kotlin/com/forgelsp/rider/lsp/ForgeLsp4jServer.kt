package com.forgelsp.rider.lsp

import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

/**
 * Custom LSP server interface for forge-lsp's forge/ extensions.
 *
 * JetBrains's LSP API lets us override `LspServerDescriptor.lsp4jServerClass`
 * with a subinterface of [LanguageServer] that adds `@JsonRequest` methods.
 * Method names match exactly what the Rust host in `src/main.rs` routes
 * under `handle_custom_request()`.
 *
 * All DTO fields are camelCase to match the Rust wire format — no Gson
 * `@SerializedName` needed because the names already line up, and we'd
 * rather not take a transitive dependency on a specific Gson version.
 */
interface ForgeLsp4jServer : LanguageServer {
    @JsonRequest("forge/workspaceSymbols")
    fun workspaceSymbols(
        params: WorkspaceSymbolsParams,
    ): CompletableFuture<WorkspaceSymbolsResponse>

    @JsonRequest("forge/nuget/installed")
    fun nugetInstalled(
        params: NuGetInstalledParams,
    ): CompletableFuture<NuGetInstalledResponse>

    @JsonRequest("forge/nuget/targets")
    fun nugetTargets(
        params: NuGetTargetsParams,
    ): CompletableFuture<NuGetTargetsResponse>

    @JsonRequest("forge/nuget/search")
    fun nugetSearch(
        params: NuGetSearchParams,
    ): CompletableFuture<NuGetSearchResponse>

    @JsonRequest("forge/nuget/versions")
    fun nugetVersions(
        params: NuGetVersionsParams,
    ): CompletableFuture<NuGetVersionsResponse>

    @JsonRequest("forge/nuget/install")
    fun nugetInstall(
        params: NuGetInstallParams,
    ): CompletableFuture<NuGetInstallResponse>

    @JsonRequest("forge/nuget/uninstall")
    fun nugetUninstall(
        params: NuGetUninstallParams,
    ): CompletableFuture<NuGetUninstallResponse>

    @JsonRequest("forge/loadSolution")
    fun loadSolution(
        params: LoadSolutionParams,
    ): CompletableFuture<LoadSolutionResponse>
}

// ── DTOs ────────────────────────────────────────────────────────

data class WorkspaceSymbolsParams(
    val solution: String,
)

data class WorkspaceSymbolsResponse(
    val projects: List<ProjectNode> = emptyList(),
)

data class ProjectNode(
    val name: String,
    val path: String,
    val symbols: List<FileSymbol> = emptyList(),
)

data class FileSymbol(
    val file: String,
    val symbols: List<SymbolNode> = emptyList(),
)

data class SymbolNode(
    val name: String,
    val kind: String,
    val detail: String? = null,
    val access: String? = null,
    val range: SymbolRange,
    val children: List<SymbolNode> = emptyList(),
)

data class SymbolRange(
    val start: SymbolPosition,
    val end: SymbolPosition,
)

data class SymbolPosition(
    val line: Int,
    val character: Int,
)

data class NuGetInstalledParams(
    val target: NuGetTarget? = null,
    val projectPath: String? = null,
)

data class NuGetInstalledResponse(
    val packages: List<InstalledPackage> = emptyList(),
)

data class InstalledPackage(
    val id: String,
    val requestedVersion: String,
    val resolvedVersion: String,
)

data class NuGetTargetsParams(
    val workspaceRoot: String,
)

data class NuGetTargetsResponse(
    val targets: List<NuGetTarget> = emptyList(),
    val defaultTargetId: String? = null,
    val cpmEnabled: Boolean = false,
    val cpmFile: String? = null,
)

data class NuGetTarget(
    val id: String,
    val kind: String,
    val displayName: String,
    val path: String,
    val language: String? = null,
    val framework: List<String> = emptyList(),
)

data class LoadSolutionParams(
    val solutionPath: String,
)

data class LoadSolutionResponse(
    val success: Boolean,
)

// ── forge/nuget/search ──────────────────────────────────────────

data class NuGetSearchParams(
    val query: String,
    val target: NuGetTarget? = null,
    val projectPath: String? = null,
    val prerelease: Boolean = false,
    val take: Int = 50,
    val skip: Int = 0,
)

data class NuGetSearchResponse(
    val packages: List<PackageInfo> = emptyList(),
    val totalHits: Long = 0,
)

data class PackageInfo(
    val id: String,
    val version: String,
    val description: String = "",
    val authors: String = "",
    val iconUrl: String? = null,
    val licenseUrl: String? = null,
    val projectUrl: String? = null,
    val published: String? = null,
    val downloadCount: Long = 0,
    val tags: List<String> = emptyList(),
    val isInstalled: Boolean = false,
    val installedVersion: String? = null,
)

// ── forge/nuget/versions ────────────────────────────────────────

data class NuGetVersionsParams(
    val packageId: String,
)

data class NuGetVersionsResponse(
    val versions: List<String> = emptyList(),
)

// ── forge/nuget/install ─────────────────────────────────────────

data class NuGetInstallParams(
    val target: NuGetTarget? = null,
    val projectPath: String? = null,
    val packageId: String,
    val version: String,
)

data class NuGetInstallResponse(
    val success: Boolean,
    val message: String = "",
    val modifiedFiles: List<String> = emptyList(),
)

// ── forge/nuget/uninstall ───────────────────────────────────────

data class NuGetUninstallParams(
    val target: NuGetTarget? = null,
    val projectPath: String? = null,
    val packageId: String,
)

data class NuGetUninstallResponse(
    val success: Boolean,
    val message: String = "",
    val modifiedFiles: List<String> = emptyList(),
)
