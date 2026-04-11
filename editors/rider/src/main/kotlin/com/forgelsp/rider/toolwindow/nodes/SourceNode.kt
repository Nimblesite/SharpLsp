package com.forgelsp.rider.toolwindow.nodes

import com.forgelsp.rider.lsp.FileSymbol
import com.forgelsp.rider.lsp.ProjectNode
import com.forgelsp.rider.lsp.SymbolNode
import com.forgelsp.rider.toolwindow.NavigationTarget
import com.intellij.icons.AllIcons
import com.intellij.openapi.project.Project
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.SimpleTextAttributes
import java.nio.file.Paths
import javax.swing.Icon

/**
 * "Source" subtree under a project. Groups file-level symbols by
 * namespace, collapses namespaces that contain only one child, and
 * renders the resulting type/member hierarchy with access-modifier icons.
 *
 * The symbol data comes from `forge/workspaceSymbols` which the root
 * node already fetched — we just walk the subset belonging to this
 * project.
 */
class SourceNode(
    private val projectNode: ProjectNode,
) : ForgeTreeNode {
    override var childrenLoaded: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = AllIcons.Nodes.Package
        renderer.append("Source")
        renderer.append(
            "  (${projectNode.symbols.size} files)",
            SimpleTextAttributes.GRAY_ATTRIBUTES,
        )
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        val grouped = groupByNamespace(projectNode.symbols)
        callback(grouped)
    }

    /**
     * Walk every file in the project, find top-level namespaces, and
     * fold their contents into a single tree keyed by namespace name.
     * Files without an explicit namespace land under "(global)".
     */
    private fun groupByNamespace(files: List<FileSymbol>): List<ForgeTreeNode> {
        val byNs = linkedMapOf<String, MutableList<Pair<FileSymbol, SymbolNode>>>()
        for (file in files) {
            for (sym in file.symbols) {
                if (sym.kind.equals("namespace", ignoreCase = true)) {
                    byNs.getOrPut(sym.name) { mutableListOf() }.add(file to sym)
                } else {
                    byNs.getOrPut("(global)") { mutableListOf() }.add(file to sym)
                }
            }
        }
        return byNs.map { (name, pairs) ->
            NamespaceGroupNode(name, pairs)
        }
    }
}

/**
 * One namespace across potentially many files. Children are the
 * flattened union of every type inside that namespace.
 */
class NamespaceGroupNode(
    private val name: String,
    private val files: List<Pair<FileSymbol, SymbolNode>>,
) : ForgeTreeNode {
    override var childrenLoaded: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = AllIcons.Nodes.Package
        renderer.append(name)
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        val children = mutableListOf<ForgeTreeNode>()
        for ((file, wrapper) in files) {
            val nested = if (name == "(global)") {
                // "global" wraps non-namespace top-level symbols directly.
                listOf(wrapper)
            } else {
                wrapper.children
            }
            for (top in nested) {
                children += SymbolTreeNode(file.file, top)
            }
        }
        callback(children)
    }
}

/**
 * Generic symbol node: class / struct / interface / enum / record /
 * method / property / field / event / delegate. Children recurse via
 * the same class so members of a nested type render correctly.
 */
class SymbolTreeNode(
    private val filePath: String,
    private val symbol: SymbolNode,
) : ForgeTreeNode {
    override var childrenLoaded: Boolean = false

    override fun render(renderer: ColoredTreeCellRenderer) {
        renderer.icon = iconFor(symbol.kind, symbol.access)
        renderer.append(symbol.name)
        val detail = symbol.detail
        if (!detail.isNullOrBlank()) {
            renderer.append("  $detail", SimpleTextAttributes.GRAY_ATTRIBUTES)
        }
    }

    override fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit) {
        val children = symbol.children.map { SymbolTreeNode(filePath, it) }
        callback(children)
    }

    override fun navigationTarget(): NavigationTarget? {
        return try {
            NavigationTarget(
                Paths.get(filePath),
                symbol.range.start.line,
                symbol.range.start.character,
            )
        } catch (_: Throwable) {
            null
        }
    }

    private fun iconFor(kind: String, access: String?): Icon {
        return when (kind.lowercase()) {
            "class" -> AllIcons.Nodes.Class
            "interface" -> AllIcons.Nodes.Interface
            "enum" -> AllIcons.Nodes.Enum
            "struct" -> AllIcons.Nodes.Static
            "record" -> AllIcons.Nodes.Record
            "method", "function" -> AllIcons.Nodes.Method
            "property" -> AllIcons.Nodes.Property
            "field" -> AllIcons.Nodes.Field
            "event" -> AllIcons.Nodes.Property
            "delegate" -> AllIcons.Nodes.Function
            "namespace" -> AllIcons.Nodes.Package
            else -> AllIcons.Nodes.AbstractClass
        }
    }
}
