package com.sharplsp.rider.lsp

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
import com.sharplsp.rider.settings.SharpLspSettings
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Describes how to launch and talk to sharplsp for a given project.
 *
 * One descriptor instance per project. The platform keys servers by
 * `presentableName` equality, so we include the project's basePath to
 * guarantee one server per project.
 * Implements [RIDER-LSP-DESCRIPTOR].
 */
class SharpLspServerDescriptor(
    project: Project,
) : ProjectWideLspServerDescriptor(project, "SharpLsp LSP") {

    override fun isSupportedFile(file: VirtualFile): Boolean {
        val ext = file.extension?.lowercase() ?: return false
        return ext in SUPPORTED_EXTENSIONS
    }

    override fun createCommandLine(): GeneralCommandLine {
        val binary = resolveSharpLspBinary(project)
            ?: throw SharpLspNotFoundException()

        val settings = project.service<SharpLspSettings>()
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
        SharpLsp4jServer::class.java

    companion object {
        private val SUPPORTED_EXTENSIONS = setOf(
            "cs", "csx",
            "fs", "fsx", "fsi",
        )

        /**
         * Resolve the `sharplsp` binary path.
         *
         * Priority (matches the VS Code extension in
         * `src/editors/vscode/src/install.ts`):
         *   1. `sharplsp.server.path` project setting
         *   2. `~/.local/bin/sharplsp`
         *   3. Anything on $PATH (best-effort via `which`)
         *
         * Returns null if nothing was found; the caller turns that into
         * a user-visible error.
         */
        fun resolveSharpLspBinary(project: Project): Path? {
            val settings = project.service<SharpLspSettings>()
            val override = settings.state.serverPath
            if (!override.isNullOrBlank()) {
                val p = Paths.get(override)
                if (Files.isExecutable(p)) return p
            }

            val home = System.getProperty("user.home") ?: return null
            val localBin = Paths.get(home, ".local", "bin", "sharplsp")
            if (Files.isExecutable(localBin)) return localBin

            // Last resort: probe $PATH via the OS. Avoid shelling out to
            // `which` so Windows works too.
            val pathEnv = System.getenv("PATH") ?: return null
            val sep = if (System.getProperty("os.name")
                    .lowercase()
                    .contains("win")
            ) ";" else ":"
            val exeName = if (sep == ";") "sharplsp.exe" else "sharplsp"
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
 * Thrown when `sharplsp` can't be found. The message is user-facing —
 * it ends up in Rider's Event Log as an LSP startup failure.
 */
class SharpLspNotFoundException : RuntimeException(
    "sharplsp binary not found. Install it with " +
        "`brew install nimblesite/tap/sharplsp` or " +
        "`scoop install nimblesite/sharplsp`, unpack the " +
        "sharplsp-<platform> archive from a GitHub release onto your PATH, " +
        "or set the binary path at Settings → Tools → SharpLsp → Server path. " +
        "See https://github.com/Nimblesite/sharplsp/releases",
)
