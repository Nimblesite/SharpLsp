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
    val projectNode: ProjectNode,
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
                    NuGetPackageNode(it.id, it.resolvedVersion, projectNode.path)
                })
            }
            children += ProjectReferencesGroupNode(readProjectRefs(projectNode.path))
            callback(children)
        }
    }

    override fun tooltip(): String = "Dependencies of ${projectNode.name}"

    private fun readProjectRefs(csproj: String): List<ProjectReferenceNode> {
        return try {
            val content = File(csproj).readText()
            parseProjectRefs(content, csproj)
        } catch (_: Throwable) {
            emptyList()
        }
    }

    companion object {
        /**
         * Parse `<ProjectReference Include="..."/>` entries out of a
         * csproj/fsproj. Uses a real XML parser rather than regex —
         * msbuild files are well-formed XML, and regex over XML is
         * banned by CLAUDE.md.
         */
        fun parseProjectRefs(xml: String, owningProjectPath: String): List<ProjectReferenceNode> {
            return try {
                val factory = javax.xml.parsers.DocumentBuilderFactory.newInstance().apply {
                    isNamespaceAware = false
                    // Harden against XXE — these files come from disk but
                    // are still untrusted enough to deserve the defaults.
                    setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
                    isXIncludeAware = false
                    isExpandEntityReferences = false
                }
                val doc = factory.newDocumentBuilder().parse(xml.byteInputStream(Charsets.UTF_8))
                val nodes = doc.getElementsByTagName("ProjectReference")
                val result = mutableListOf<ProjectReferenceNode>()
                for (i in 0 until nodes.length) {
                    val el = nodes.item(i) as? org.w3c.dom.Element ?: continue
                    val include = el.getAttribute("Include").takeIf { it.isNotBlank() } ?: continue
                    val normalized = include.replace('\\', '/')
                    val name = normalized.substringAfterLast('/').substringBeforeLast('.')
                    result += ProjectReferenceNode(name, normalized, owningProjectPath)
                }
                result
            } catch (_: Throwable) {
                emptyList()
            }
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
