package com.forgelsp.rider.toolwindow.nodes

import com.intellij.icons.AllIcons
import com.intellij.openapi.project.Project
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.SimpleTextAttributes

/** A single installed NuGet package. */
class NuGetPackageNode(
    val id: String,
    val version: String,
    val owningProjectPath: String,
) : ForgeTreeNode {
    override var childrenLoaded: Boolean = true
    override val hasChildren: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = AllIcons.Nodes.PpLib
        renderer.append(id)
        if (version.isNotEmpty()) {
            renderer.append(
                "  $version",
                SimpleTextAttributes.GRAY_ATTRIBUTES,
            )
        }
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        callback(emptyList())
    }

    override fun tooltip(): String =
        "<html><b>$id</b><br/>Version: $version<br/>In: $owningProjectPath</html>"
}

/** A single project-to-project reference. */
class ProjectReferenceNode(
    val name: String,
    val path: String,
    val owningProjectPath: String,
) : ForgeTreeNode {
    override var childrenLoaded: Boolean = true
    override val hasChildren: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = AllIcons.Nodes.Module
        renderer.append(name)
        renderer.append(
            "  $path",
            SimpleTextAttributes.GRAY_ATTRIBUTES,
        )
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        callback(emptyList())
    }

    override fun tooltip(): String =
        "<html><b>$name</b><br/>$path<br/>Referenced by: $owningProjectPath</html>"
}

/**
 * An error leaf — displayed in red. Used wherever an async load fails
 * so the user sees the actual reason instead of a silent empty node.
 */
class ErrorNode(private val message: String) : ForgeTreeNode {
    override var childrenLoaded: Boolean = true
    override val hasChildren: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = AllIcons.General.Error
        renderer.append(message, SimpleTextAttributes.ERROR_ATTRIBUTES)
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        callback(emptyList())
    }
}
