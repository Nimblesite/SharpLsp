package com.forgelsp.rider.toolwindow.nodes

import com.forgelsp.rider.lsp.ForgeLsp4jServer
import com.forgelsp.rider.lsp.ForgeLspServerSupportProvider
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.platform.lsp.api.LspServer
import com.intellij.platform.lsp.api.LspServerManager
import java.util.concurrent.CompletableFuture

/**
 * Glue for talking to a running forge-lsp instance from tree nodes.
 *
 * Tree nodes must not block the EDT, so every call here runs on
 * `ApplicationManager.getApplication().executeOnPooledThread { … }`
 * and returns a `CompletableFuture` that the node resolves on the EDT.
 */
object LspBridge {
    private val log = Logger.getInstance(LspBridge::class.java)

    /** Return the live forge-lsp server for this project, if any. */
    fun server(project: Project): LspServer? {
        val mgr = LspServerManager.getInstance(project)
        val all = mgr.getServersForProvider(ForgeLspServerSupportProvider::class.java)
        return all.firstOrNull()
    }

    /**
     * Fire `block` against the running server's lsp4j facade in a
     * background thread. Uses `sendRequestSync` with a generous 30 s
     * timeout — the long-lived `forge/workspaceSymbols` call on a big
     * solution can take several seconds on a cold start.
     */
    fun <T> call(
        project: Project,
        timeoutMs: Int = 30_000,
        block: (ForgeLsp4jServer) -> CompletableFuture<T>,
    ): CompletableFuture<T> {
        val result = CompletableFuture<T>()
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val srv = server(project)
                if (srv == null) {
                    result.completeExceptionally(
                        IllegalStateException("forge-lsp is not running for this project"),
                    )
                    return@executeOnPooledThread
                }
                val value: T? = srv.sendRequestSync(timeoutMs) { lsp4j ->
                    @Suppress("UNCHECKED_CAST")
                    block(lsp4j as ForgeLsp4jServer)
                }
                if (value == null) {
                    result.completeExceptionally(
                        IllegalStateException("forge-lsp returned no response (timeout or closed)"),
                    )
                } else {
                    result.complete(value)
                }
            } catch (err: Throwable) {
                log.warn("forge-lsp custom request failed", err)
                result.completeExceptionally(err)
            }
        }
        return result
    }
}
