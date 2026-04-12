package com.forgelsp.rider.lsp

import com.forgelsp.rider.settings.ForgeSettings
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Describes how to launch and talk to forge-lsp for a given project.
 *
 * One descriptor instance per project. The platform keys servers by
 * `presentableName` equality, so we include the project's basePath to
 * guarantee one server per project.
 */
class ForgeLspServerDescriptor(
    project: Project,
) : ProjectWideLspServerDescriptor(project, "Forge LSP") {

    override fun isSupportedFile(file: VirtualFile): Boolean {
        val ext = file.extension?.lowercase() ?: return false
        return ext in SUPPORTED_EXTENSIONS
    }

    override fun createCommandLine(): GeneralCommandLine {
        val binary = resolveForgeLspBinary(project)
            ?: throw ForgeLspNotFoundException()

        val settings = project.service<ForgeSettings>()
        val logLevel = settings.state.logLevel

        return GeneralCommandLine(binary.toString())
            .withEnvironment("RUST_LOG", logLevel)
            .withWorkDirectory(project.basePath)
            .withCharset(Charsets.UTF_8)
    }

    // Hook JetBrains documents for custom LSP requests: point
    // lsp4jServerClass at our subinterface of LanguageServer with
    // @JsonRequest methods declared on it.
    override val lsp4jServerClass: Class<out org.eclipse.lsp4j.services.LanguageServer> =
        ForgeLsp4jServer::class.java

    companion object {
        private val SUPPORTED_EXTENSIONS = setOf(
            "cs", "csx",
            "fs", "fsx", "fsi",
        )

        /**
         * Resolve the `forge-lsp` binary path.
         *
         * Priority (matches the VS Code extension in
         * `editors/vscode/src/install.ts`):
         *   1. `forge.server.path` project setting
         *   2. `~/.local/bin/forge-lsp`
         *   3. Anything on $PATH (best-effort via `which`)
         *
         * Returns null if nothing was found; the caller turns that into
         * a user-visible error.
         */
        fun resolveForgeLspBinary(project: Project): Path? {
            val settings = project.service<ForgeSettings>()
            val override = settings.state.serverPath
            if (!override.isNullOrBlank()) {
                val p = Paths.get(override)
                if (Files.isExecutable(p)) return p
            }

            val home = System.getProperty("user.home") ?: return null
            val localBin = Paths.get(home, ".local", "bin", "forge-lsp")
            if (Files.isExecutable(localBin)) return localBin

            // Last resort: probe $PATH via the OS. Avoid shelling out to
            // `which` so Windows works too.
            val pathEnv = System.getenv("PATH") ?: return null
            val sep = if (System.getProperty("os.name")
                    .lowercase()
                    .contains("win")
            ) ";" else ":"
            val exeName = if (sep == ";") "forge-lsp.exe" else "forge-lsp"
            for (dir in pathEnv.split(sep)) {
                if (dir.isBlank()) continue
                val candidate = Paths.get(dir, exeName)
                if (Files.isExecutable(candidate)) return candidate
            }
            return null
        }
    }
}

/**
 * Thrown when `forge-lsp` can't be found. The message is user-facing —
 * it ends up in Rider's Event Log as an LSP startup failure.
 */
class ForgeLspNotFoundException : RuntimeException(
    "forge-lsp binary not found. Install it with " +
        "`make install` (puts it in ~/.local/bin), or set the binary " +
        "path at Settings → Tools → Forge → Server path. " +
        "See https://github.com/Nimblesite/forge",
)
