package com.forgelsp.rider.toolwindow

import com.forgelsp.rider.lsp.NuGetUninstallParams
import com.forgelsp.rider.toolwindow.nodes.DependenciesNode
import com.forgelsp.rider.toolwindow.nodes.LspBridge
import com.forgelsp.rider.toolwindow.nodes.NuGetPackageNode
import com.forgelsp.rider.toolwindow.nodes.ProjectReferenceNode
import com.forgelsp.rider.toolwindow.nodes.ProjectTreeNode
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import java.awt.datatransfer.StringSelection
import java.io.File
import javax.swing.tree.DefaultMutableTreeNode

/**
 * Builds a context-specific right-click menu for whichever node was
 * clicked. The popup is rebuilt on every click so we can filter actions
 * by the node type under the mouse (project / package / reference).
 */
internal object ForgeTreeActions {
    fun menuFor(project: Project, node: DefaultMutableTreeNode): DefaultActionGroup {
        val group = DefaultActionGroup()
        when (val payload = node.userObject) {
            is ProjectTreeNode -> buildProjectMenu(group, project, payload)
            is NuGetPackageNode -> buildPackageMenu(group, project, payload)
            is ProjectReferenceNode -> buildReferenceMenu(group, project, payload)
            is DependenciesNode -> buildDependenciesMenu(group, project, payload)
        }
        return group
    }

    private fun buildProjectMenu(group: DefaultActionGroup, project: Project, node: ProjectTreeNode) {
        group.add(OpenFileAction("Open ${File(node.projectPath()).name}", node.projectPath(), project))
        group.addSeparator()
        group.add(InstallNuGetAction(project, node.projectPath()))
        group.add(RestorePackagesAction(project, node.projectPath()))
        group.addSeparator()
        group.add(CopyStringAction("Copy Full Path", node.projectPath()))
        group.add(CopyStringAction("Copy Project Name", node.projectName()))
        group.add(ShowInFilesAction(node.projectPath()))
    }

    private fun buildPackageMenu(group: DefaultActionGroup, project: Project, node: NuGetPackageNode) {
        group.add(UninstallNuGetAction(project, node))
        group.addSeparator()
        group.add(CopyStringAction("Copy Package ID", node.id))
        group.add(CopyStringAction("Copy Version", node.version))
        group.add(CopyStringAction("Copy 'id version'", "${node.id} ${node.version}"))
    }

    private fun buildReferenceMenu(group: DefaultActionGroup, project: Project, node: ProjectReferenceNode) {
        val absolute = resolveReferencePath(node)
        if (absolute != null) {
            group.add(OpenFileAction("Open ${node.name}.csproj", absolute, project))
        }
        group.addSeparator()
        group.add(CopyStringAction("Copy Path", node.path))
        if (absolute != null) {
            group.add(CopyStringAction("Copy Full Path", absolute))
            group.add(ShowInFilesAction(absolute))
        }
    }

    private fun buildDependenciesMenu(group: DefaultActionGroup, project: Project, node: DependenciesNode) {
        group.add(InstallNuGetAction(project, node.projectNode.path))
        group.add(RestorePackagesAction(project, node.projectNode.path))
    }

    /**
     * Project references are stored in csproj files as paths relative
     * to the csproj that declares them. Resolve them against the owning
     * project directory so the "Open" action can navigate there.
     */
    private fun resolveReferencePath(node: ProjectReferenceNode): String? {
        return try {
            val owningDir = File(node.owningProjectPath).parentFile ?: return null
            File(owningDir, node.path).canonicalPath
        } catch (_: Throwable) {
            null
        }
    }
}

// ── Concrete actions ─────────────────────────────────────────────

private class OpenFileAction(
    title: String,
    private val path: String,
    private val project: Project,
) : AnAction(title, "Open $path in the editor", AllIcons.Actions.MenuOpen) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
        val vfile = LocalFileSystem.getInstance().refreshAndFindFileByPath(path) ?: return
        OpenFileDescriptor(project, vfile).navigate(true)
    }
}

private class CopyStringAction(
    title: String,
    private val value: String,
) : AnAction(title, "Copy \"$value\" to clipboard", AllIcons.Actions.Copy) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
        CopyPasteManager.getInstance().setContents(StringSelection(value))
    }
}

private class ShowInFilesAction(
    private val path: String,
) : AnAction(
    if (System.getProperty("os.name").lowercase().contains("mac")) "Reveal in Finder" else "Show in Files",
    "Reveal this file in the OS file manager",
    AllIcons.Actions.MenuOpen,
) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
        try {
            com.intellij.ide.actions.RevealFileAction.openFile(java.nio.file.Paths.get(path))
        } catch (_: Throwable) {
            // swallow — nothing sensible to show the user here
        }
    }
}

private class InstallNuGetAction(
    private val project: Project,
    private val projectPath: String,
) : AnAction("Install NuGet Package…", "Install a NuGet package into this project", AllIcons.General.Add) {
    override fun getActionUpdateThread() = ActionUpdateThread.EDT
    override fun actionPerformed(e: AnActionEvent) {
        // Prefer the full browser. This quick dialog is a fast-path for
        // users who already know what they want — open the browser pre-
        // scoped to the target project so they can search, pick a
        // version, and install without retyping anything.
        com.forgelsp.rider.toolwindow.nuget.ForgeNuGetBrowserDialog(project, projectPath).show()
    }
}

private class UninstallNuGetAction(
    private val project: Project,
    private val node: NuGetPackageNode,
) : AnAction("Uninstall", "Remove this NuGet package from the project", AllIcons.General.Remove) {
    override fun getActionUpdateThread() = ActionUpdateThread.EDT
    override fun actionPerformed(e: AnActionEvent) {
        val confirm = Messages.showYesNoDialog(
            project,
            "Uninstall ${node.id} ${node.version}?",
            "Uninstall NuGet Package",
            AllIcons.General.QuestionDialog,
        )
        if (confirm != Messages.YES) return

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                LspBridge.call(project, timeoutMs = 120_000) { lsp ->
                    lsp.nugetUninstall(
                        NuGetUninstallParams(
                            projectPath = node.owningProjectPath,
                            packageId = node.id,
                        ),
                    )
                }.join()
                showInfo(project, "Uninstalled ${node.id}")
            } catch (err: Throwable) {
                showError(project, "Uninstall failed: ${err.message}")
            }
        }
    }
}

private class RestorePackagesAction(
    private val project: Project,
    private val projectPath: String,
) : AnAction("Restore Packages", "Run dotnet restore on this project", AllIcons.Actions.Refresh) {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val dir = File(projectPath).parentFile ?: return@executeOnPooledThread
                val pb = ProcessBuilder("dotnet", "restore")
                    .directory(dir)
                    .redirectErrorStream(true)
                val proc = pb.start()
                val exit = proc.waitFor()
                if (exit == 0) {
                    showInfo(project, "dotnet restore OK: ${File(projectPath).name}")
                } else {
                    val tail = proc.inputStream.bufferedReader().readText().takeLast(400)
                    showError(project, "dotnet restore failed (exit $exit):\n$tail")
                }
            } catch (err: Throwable) {
                showError(project, "Restore failed: ${err.message}")
            }
        }
    }
}

// ── Notification helpers ─────────────────────────────────────────

private fun showInfo(project: Project, message: String) {
    ApplicationManager.getApplication().invokeLater {
        com.intellij.notification.NotificationGroupManager.getInstance()
            .getNotificationGroup("Forge")
            .createNotification(message, com.intellij.notification.NotificationType.INFORMATION)
            .notify(project)
    }
}

private fun showError(project: Project, message: String) {
    ApplicationManager.getApplication().invokeLater {
        com.intellij.notification.NotificationGroupManager.getInstance()
            .getNotificationGroup("Forge")
            .createNotification(message, com.intellij.notification.NotificationType.ERROR)
            .notify(project)
    }
}
