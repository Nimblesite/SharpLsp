package com.forgelsp.rider.toolwindow.nodes

import com.forgelsp.rider.lsp.ForgeLsp4jServer
import com.forgelsp.rider.lsp.ForgeLspServerDescriptor
import com.forgelsp.rider.lsp.ForgeLspServerSupportProvider
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.platform.lsp.api.LspServer
import com.intellij.platform.lsp.api.LspServerManager
import com.intellij.platform.lsp.api.LspServerState
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

    /**
     * Return the live forge-lsp server for this project, starting one if
     * none exists. The tool window can be opened without any .cs/.fs file
     * having ever been visited, and `LspServerSupportProvider.fileOpened`
     * only fires on file-open events — so we kick the server ourselves.
     *
     * `ensureServerStarted` is non-blocking: it schedules initialization
     * on the IDE's coroutine dispatcher and returns immediately, so the
     * server is in `Initializing` state (or not yet registered at all)
     * when we come back. We poll for up to 15 s waiting for `Running` —
     * long enough for a cold `dotnet` sidecar spawn, short enough that
     * a genuine failure surfaces as an error in the tree.
     */
    fun server(project: Project): LspServer? {
        val mgr = LspServerManager.getInstance(project)
        val running = mgr.getServersForProvider(ForgeLspServerSupportProvider::class.java)
            .firstOrNull { it.state == LspServerState.Running }
        if (running != null) return running

        log.info("forge-lsp not running; starting it for project ${project.name}")
        try {
            mgr.ensureServerStarted(
                ForgeLspServerSupportProvider::class.java,
                ForgeLspServerDescriptor(project),
            )
        } catch (err: Throwable) {
            log.warn("failed to start forge-lsp", err)
            return null
        }

        val deadline = System.currentTimeMillis() + SERVER_START_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            val servers = mgr.getServersForProvider(ForgeLspServerSupportProvider::class.java)
            val ready = servers.firstOrNull { it.state == LspServerState.Running }
            if (ready != null) {
                log.info("forge-lsp reached Running state")
                return ready
            }
            val dead = servers.firstOrNull {
                it.state == LspServerState.ShutdownNormally ||
                    it.state == LspServerState.ShutdownUnexpectedly
            }
            if (dead != null) {
                log.warn("forge-lsp start failed: state=${dead.state}")
                return null
            }
            Thread.sleep(SERVER_POLL_INTERVAL_MS)
        }
        log.warn("forge-lsp did not reach Running state within ${SERVER_START_TIMEOUT_MS}ms")
        return null
    }

    private const val SERVER_START_TIMEOUT_MS = 15_000L
    private const val SERVER_POLL_INTERVAL_MS = 100L

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
