package com.forgelsp.rider.toolwindow.nodes

import com.forgelsp.rider.lsp.ProjectNode
import com.forgelsp.rider.toolwindow.NavigationTarget
import com.intellij.icons.AllIcons
import com.intellij.openapi.project.Project
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.SimpleTextAttributes
import java.nio.file.Paths

/**
 * A single project (.csproj / .fsproj) in the solution. Has two
 * children: Dependencies and Source.
 */
class ProjectTreeNode(
    private val projectNode: ProjectNode,
) : ForgeTreeNode {
    override var childrenLoaded: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = AllIcons.Nodes.Project
        renderer.append(projectNode.name)
        val fileName = projectNode.path.substringAfterLast('/')
        if (fileName.isNotEmpty() && fileName != projectNode.name) {
            renderer.append(
                "  $fileName",
                SimpleTextAttributes.GRAY_ATTRIBUTES,
            )
        }
        renderer.toolTipText = projectNode.path
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        val children = mutableListOf<ForgeTreeNode>()
        children += DependenciesNode(projectNode)
        children += SourceNode(projectNode)
        callback(children)
    }

    override fun navigationTarget(): NavigationTarget? {
        return try {
            NavigationTarget(Paths.get(projectNode.path), 0, 0)
        } catch (_: Throwable) {
            null
        }
    }

    override fun tooltip(): String =
        "<html><b>${projectNode.name}</b><br/>${projectNode.path}</html>"

    fun projectPath(): String = projectNode.path
    fun projectName(): String = projectNode.name
}
