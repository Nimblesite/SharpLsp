package com.forgelsp.rider.toolwindow

import com.forgelsp.rider.toolwindow.nodes.ForgeTreeNode
import com.forgelsp.rider.toolwindow.nodes.SolutionRootNode
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.ui.ScrollPaneFactory
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.tree.TreeUtil
import java.awt.BorderLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.nio.file.Path
import javax.swing.JPanel
import javax.swing.SwingUtilities
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath

/**
 * The Forge Solution tool window.
 *
 * Builds a tree with a single `SolutionRootNode` at the top. Children
 * load asynchronously: expanding a node fires the LSP round-trip that
 * fetches its subtree, and the returned children are spliced into the
 * tree on the EDT.
 *
 * The tree is a plain Swing [DefaultTreeModel] keyed by
 * [DefaultMutableTreeNode] whose `userObject` is always a
 * [ForgeTreeNode] from the `nodes` package — the node objects encode
 * their own rendering, icons, and child-loading logic.
 */
class ForgeSolutionToolWindow(
    private val project: Project,
) : Disposable {
    private val rootNode = DefaultMutableTreeNode(
        SolutionRootNode(project, findDefaultSolution(project)),
    )
    private val treeModel = DefaultTreeModel(rootNode)
    private val tree: Tree = Tree(treeModel).also { configureTree(it) }

    val component: JPanel = JPanel(BorderLayout()).also { root ->
        root.add(buildToolbar().component, BorderLayout.NORTH)
        root.add(ScrollPaneFactory.createScrollPane(tree), BorderLayout.CENTER)
    }

    init {
        // Kick off the first load after the UI is wired up.
        loadChildren(rootNode)
        subscribeToVfsChanges()
    }

    override fun dispose() {
        // Nothing to release — VFS subscription is tied to project bus
        // which cleans up automatically on project close.
    }

    // ── Tree wiring ─────────────────────────────────────────────

    private fun configureTree(tree: Tree) {
        tree.isRootVisible = true
        tree.showsRootHandles = true
        tree.cellRenderer = ForgeTreeCellRenderer()
        // Register with the tooltip manager so the renderer's toolTipText
        // actually surfaces on hover — without this Swing ignores it.
        javax.swing.ToolTipManager.sharedInstance().registerComponent(tree)

        tree.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) {
                if (e.clickCount != 2) return
                val path = tree.getClosestPathForLocation(e.x, e.y) ?: return
                handleActivation(path)
            }
        })

        // Right-click → context menu. PopupHandler fires for both
        // mousePressed(isPopupTrigger) on macOS/Linux and
        // mouseReleased(isPopupTrigger) on Windows, so it beats a
        // hand-rolled MouseListener.
        com.intellij.ui.PopupHandler.installPopupMenu(
            tree,
            object : com.intellij.openapi.actionSystem.ActionGroup() {
                override fun getChildren(e: com.intellij.openapi.actionSystem.AnActionEvent?): Array<com.intellij.openapi.actionSystem.AnAction> {
                    val path = tree.selectionPath ?: return emptyArray()
                    val mutable = path.lastPathComponent as? DefaultMutableTreeNode
                        ?: return emptyArray()
                    return ForgeTreeActions.menuFor(project, mutable).childActionsOrStubs
                }
            },
            "ForgeSolutionToolWindow",
        )

        tree.addTreeWillExpandListener(object : javax.swing.event.TreeWillExpandListener {
            override fun treeWillExpand(event: javax.swing.event.TreeExpansionEvent) {
                val node = event.path.lastPathComponent as? DefaultMutableTreeNode ?: return
                loadChildren(node)
            }

            override fun treeWillCollapse(event: javax.swing.event.TreeExpansionEvent) {
                // nothing
            }
        })
    }

    /**
     * Drive a node's children from its [ForgeTreeNode].
     *
     * Loads are idempotent: every call triggers a fresh async fetch.
     * The node is responsible for setting a "loading" placeholder
     * child immediately and returning the real children via the
     * callback when the LSP round-trip completes.
     */
    private fun loadChildren(mutable: DefaultMutableTreeNode) {
        val forge = mutable.userObject as? ForgeTreeNode ?: return
        if (forge.childrenLoaded) return
        forge.childrenLoaded = true

        // Replace any existing children (placeholder "loading" leaf).
        mutable.removeAllChildren()
        val loadingNode = DefaultMutableTreeNode("Loading…")
        mutable.add(loadingNode)
        treeModel.nodeStructureChanged(mutable)

        forge.loadChildren(project) { children ->
            SwingUtilities.invokeLater {
                mutable.removeAllChildren()
                for (child in children) {
                    mutable.add(wrapForgeNode(child))
                }
                treeModel.nodeStructureChanged(mutable)
            }
        }
    }

    /**
     * Wrap a [ForgeTreeNode] in a Swing [DefaultMutableTreeNode]. If the
     * wrapped node claims it can have children, pre-insert a "Loading…"
     * placeholder so Swing's JTree renders the disclosure triangle and
     * fires `treeWillExpand` when the user clicks it. Without this,
     * leaf-looking nodes never become expandable and the whole tree
     * bottoms out at projects.
     */
    private fun wrapForgeNode(node: ForgeTreeNode): DefaultMutableTreeNode {
        val mutable = DefaultMutableTreeNode(node)
        if (node.hasChildren) {
            mutable.add(DefaultMutableTreeNode("Loading…"))
        }
        return mutable
    }

    private fun handleActivation(path: TreePath) {
        val mutable = path.lastPathComponent as? DefaultMutableTreeNode ?: return
        val forge = mutable.userObject as? ForgeTreeNode ?: return
        val target = forge.navigationTarget() ?: return
        val vfile = LocalFileSystem.getInstance().findFileByNioFile(target.path) ?: return
        OpenFileDescriptor(project, vfile, target.line, target.character).navigate(true)
    }

    // ── Toolbar ─────────────────────────────────────────────────

    private fun buildToolbar() = ActionManager.getInstance().createActionToolbar(
        ActionPlaces.TOOLWINDOW_CONTENT,
        DefaultActionGroup().apply {
            add(RefreshAction())
            add(CollapseAllAction())
        },
        /* horizontal = */ true,
    ).also { it.targetComponent = tree }

    private inner class RefreshAction : AnAction(
        "Refresh",
        "Reload the Forge solution tree",
        com.intellij.icons.AllIcons.Actions.Refresh,
    ) {
        override fun actionPerformed(e: AnActionEvent) {
            val forge = rootNode.userObject as? ForgeTreeNode ?: return
            forge.childrenLoaded = false
            loadChildren(rootNode)
        }
    }

    private inner class CollapseAllAction : AnAction(
        "Collapse All",
        "Collapse every expanded node",
        com.intellij.icons.AllIcons.Actions.Collapseall,
    ) {
        override fun actionPerformed(e: AnActionEvent) {
            TreeUtil.collapseAll(tree, /* keepSelectionLevel = */ 1)
        }
    }

    // ── VFS auto-refresh ────────────────────────────────────────

    private fun subscribeToVfsChanges() {
        val connection = project.messageBus.connect(this)
        Disposer.register(project, this)
        connection.subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                val relevant = events.any { event ->
                    val p = event.path
                    p.endsWith(".sln") ||
                        p.endsWith(".csproj") ||
                        p.endsWith(".fsproj") ||
                        p.endsWith("Directory.Build.props") ||
                        p.endsWith("Directory.Packages.props")
                }
                if (!relevant) return
                SwingUtilities.invokeLater {
                    val forge = rootNode.userObject as? ForgeTreeNode ?: return@invokeLater
                    forge.childrenLoaded = false
                    loadChildren(rootNode)
                }
            }
        })
    }

    companion object {
        /**
         * Best-effort: find a `.sln` in the project base directory.
         * If there are zero or multiple, the Solution root node will
         * render a clear "pick a solution" message instead of a tree.
         */
        fun findDefaultSolution(project: Project): Path? {
            val basePath = project.basePath ?: return null
            val base = java.io.File(basePath)
            val slns = base.listFiles { f -> f.extension.equals("sln", ignoreCase = true) }
                ?: return null
            return slns.singleOrNull()?.toPath()
        }
    }
}

/**
 * Lightweight render delegate.
 *
 * Defers all presentation to `ForgeTreeNode.render(...)`, which sets
 * icon + label + tooltip on the passed-in label component. The cell
 * renderer is intentionally dumb — node types own their appearance.
 */
private class ForgeTreeCellRenderer : com.intellij.ui.ColoredTreeCellRenderer() {
    override fun customizeCellRenderer(
        tree: javax.swing.JTree,
        value: Any?,
        selected: Boolean,
        expanded: Boolean,
        leaf: Boolean,
        row: Int,
        hasFocus: Boolean,
    ) {
        val mutable = value as? DefaultMutableTreeNode ?: return
        when (val payload = mutable.userObject) {
            is ForgeTreeNode -> {
                payload.render(this)
                toolTipText = payload.tooltip()
            }
            is String -> append(payload)
            else -> append(payload?.toString() ?: "")
        }
    }
}

/** Data class used by `ForgeTreeNode.navigationTarget()`. */
data class NavigationTarget(
    val path: java.nio.file.Path,
    val line: Int,
    val character: Int,
)

// Also used by action-system targets — kept for future context-menu work.
@Suppress("unused")
private val CONTEXT_DATA_KEY = CommonDataKeys.VIRTUAL_FILE
