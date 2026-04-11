package com.forgelsp.rider.lsp

import com.google.gson.annotations.SerializedName
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

/**
 * Custom LSP server interface for forge-lsp's `forge/*` extensions.
 *
 * JetBrains's LSP API lets us override `LspServerDescriptor.lsp4jServerClass`
 * with a subinterface of [LanguageServer] that adds `@JsonRequest` methods.
 * Method names match exactly what the Rust host in `src/main.rs` routes
 * under `handle_custom_request()`.
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

    @JsonRequest("forge/loadSolution")
    fun loadSolution(
        params: LoadSolutionParams,
    ): CompletableFuture<LoadSolutionResponse>
}

// ── DTOs ────────────────────────────────────────────────────────
//
// Plain Kotlin data classes. lsp4j uses Gson under the hood to
// (de)serialize these, so the JSON field names must match the Rust
// wire format exactly — hence the explicit @SerializedName where the
// Kotlin-idiomatic name would differ.

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
    @SerializedName("projectPath")
    val projectPath: String? = null,
)

data class NuGetInstalledResponse(
    val packages: List<InstalledPackage> = emptyList(),
)

data class InstalledPackage(
    val id: String,
    @SerializedName("requestedVersion")
    val requestedVersion: String,
    @SerializedName("resolvedVersion")
    val resolvedVersion: String,
)

data class NuGetTargetsParams(
    @SerializedName("workspaceRoot")
    val workspaceRoot: String,
)

data class NuGetTargetsResponse(
    val targets: List<NuGetTarget> = emptyList(),
    @SerializedName("defaultTargetId")
    val defaultTargetId: String? = null,
    @SerializedName("cpmEnabled")
    val cpmEnabled: Boolean = false,
    @SerializedName("cpmFile")
    val cpmFile: String? = null,
)

data class NuGetTarget(
    val id: String,
    val kind: String,
    @SerializedName("displayName")
    val displayName: String,
    val path: String,
    val language: String? = null,
    val framework: List<String> = emptyList(),
)

data class LoadSolutionParams(
    @SerializedName("solutionPath")
    val solutionPath: String,
)

data class LoadSolutionResponse(
    val success: Boolean,
)
