package com.forgelsp.rider.toolwindow.nodes

import com.forgelsp.rider.lsp.NuGetInstalledParams
import com.forgelsp.rider.lsp.ProjectNode
import com.intellij.icons.AllIcons
import com.intellij.openapi.project.Project
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.SimpleTextAttributes
import java.io.File

/**
 * "Dependencies" grouping node under a project. Fetches installed
 * NuGet packages via `forge/nuget/installed` and parses project
 * references directly from the csproj/fsproj XML (no LSP call — the
 * data is already in front of us).
 */
class DependenciesNode(
    private val projectNode: ProjectNode,
) : ForgeTreeNode {
    override var childrenLoaded: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = AllIcons.Nodes.PpLib
        renderer.append("Dependencies")
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        LspBridge.call(project) { lsp ->
            lsp.nugetInstalled(
                NuGetInstalledParams(projectPath = projectNode.path),
            )
        }.whenComplete { response, err ->
            val children = mutableListOf<ForgeTreeNode>()
            if (err != null) {
                children += ErrorNode("NuGet load failed: ${err.message}")
            } else {
                children += PackagesGroupNode(response.packages.map {
                    NuGetPackageNode(it.id, it.resolvedVersion)
                })
            }
            children += ProjectReferencesGroupNode(readProjectRefs(projectNode.path))
            callback(children)
        }
    }

    private fun readProjectRefs(csproj: String): List<ProjectReferenceNode> {
        return try {
            val content = File(csproj).readText()
            parseProjectRefs(content)
        } catch (_: Throwable) {
            emptyList()
        }
    }

    companion object {
        private val REF_REGEX = Regex(
            """<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+)"""",
            RegexOption.IGNORE_CASE,
        )

        fun parseProjectRefs(xml: String): List<ProjectReferenceNode> {
            return REF_REGEX.findAll(xml).map { match ->
                val path = match.groupValues[1].replace('\\', '/')
                val name = path.substringAfterLast('/').substringBeforeLast('.')
                ProjectReferenceNode(name, path)
            }.toList()
        }
    }
}

/** Subfolder listing installed NuGet packages. */
class PackagesGroupNode(
    private val packages: List<NuGetPackageNode>,
) : ForgeTreeNode {
    override var childrenLoaded: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = AllIcons.Nodes.PpLibFolder
        renderer.append("Packages")
        renderer.append(
            "  (${packages.size})",
            SimpleTextAttributes.GRAY_ATTRIBUTES,
        )
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        callback(packages)
    }
}

class ProjectReferencesGroupNode(
    private val refs: List<ProjectReferenceNode>,
) : ForgeTreeNode {
    override var childrenLoaded: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = AllIcons.Nodes.ModuleGroup
        renderer.append("Project References")
        renderer.append(
            "  (${refs.size})",
            SimpleTextAttributes.GRAY_ATTRIBUTES,
        )
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        callback(refs)
    }
}
