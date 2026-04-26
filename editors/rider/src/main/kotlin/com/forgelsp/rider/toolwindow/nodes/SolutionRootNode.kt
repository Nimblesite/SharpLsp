package com.forgelsp.rider.toolwindow.nodes

import com.forgelsp.rider.lsp.WorkspaceSymbolsParams
import com.intellij.icons.AllIcons
import com.intellij.openapi.project.Project
import com.intellij.ui.ColoredTreeCellRenderer
import java.nio.file.Path

/**
 * Top-level node for a solution file. Loads the full list of
 * projects via `forge/workspaceSymbols` the first time it's expanded.
 */
class SolutionRootNode(
    private val project: Project,
    private val solutionPath: Path?,
) : ForgeTreeNode {
    override var childrenLoaded: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = AllIcons.Nodes.Module
        val label = solutionPath?.fileName?.toString() ?: "(no .sln/.slnx found)"
        renderer.append("Solution: ")
        renderer.append(label)
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        if (solutionPath == null) {
            callback(
                listOf(
                    ErrorNode(
                        "No .sln or .slnx found in project root. " +
                            "Open a folder containing one solution file to see the tree.",
                    ),
                ),
            )
            return
        }
        LspBridge.call(project) { lsp ->
            lsp.workspaceSymbols(WorkspaceSymbolsParams(solution = solutionPath.toString()))
        }.whenComplete { response, err ->
            if (err != null) {
                callback(listOf(ErrorNode(err.message ?: err.javaClass.simpleName)))
                return@whenComplete
            }
            val children = response.projects.map { ProjectTreeNode(it) }
            callback(children)
        }
    }
}
