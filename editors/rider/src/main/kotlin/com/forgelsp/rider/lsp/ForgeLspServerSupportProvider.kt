package com.forgelsp.rider.lsp

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspServerSupportProvider

/**
 * Tells the IntelliJ platform to start a forge-lsp instance whenever a
 * C# or F# file is opened in a supported IDE.
 *
 * Registered via the `com.intellij.platform.lsp.serverSupportProvider`
 * extension point in `plugin.xml`.
 */
class ForgeLspServerSupportProvider : LspServerSupportProvider {
    override fun fileOpened(
        project: Project,
        file: VirtualFile,
        serverStarter: LspServerSupportProvider.LspServerStarter,
    ) {
        if (!isForgeSupportedFile(file)) return
        serverStarter.ensureServerStarted(ForgeLspServerDescriptor(project))
    }

    private fun isForgeSupportedFile(file: VirtualFile): Boolean {
        val ext = file.extension?.lowercase() ?: return false
        return ext in SUPPORTED_EXTENSIONS
    }

    companion object {
        private val SUPPORTED_EXTENSIONS = setOf(
            "cs", "csx",
            "fs", "fsx", "fsi",
        )
    }
}
