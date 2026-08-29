package com.forgelsp.rider.toolwindow.nodes

import com.forgelsp.rider.toolwindow.NavigationTarget
import com.intellij.openapi.project.Project
import com.intellij.ui.ColoredTreeCellRenderer

/**
 * Base contract for every node in the Forge Solution tree.
 *
 * Nodes own their own:
 *   - rendering (icon + label + tooltip via [render])
 *   - child loading (async via [loadChildren])
 *   - navigation behaviour (via [navigationTarget])
 *
 * The tool window pumps them through the Swing JTree plumbing; node
 * classes themselves do not depend on Swing.
 */
interface ForgeTreeNode {
    /**
     * True once [loadChildren] has been called at least once. The
     * tool window uses this to avoid redundant reloads when a
     * previously-loaded node is re-expanded.
     *
     * Mutable, because the refresh action flips it back to false to
     * force a reload.
     */
    var childrenLoaded: Boolean

    /**
     * Whether this node can have children at all. Swing's JTree needs
     * to know *before* expansion so it renders the disclosure triangle
     * and fires `treeWillExpand` on click. True leaves (NuGet package,
     * project reference, error node) return false; every grouping /
     * container node returns true and pays for expansion with an
     * async [loadChildren] call.
     */
    val hasChildren: Boolean get() = true

    /** Draw this node into the given renderer. */
    fun render(renderer: ColoredTreeCellRenderer)

    /**
     * Load children asynchronously. The implementation must NOT block
     * the calling thread — it should fire the LSP request on a
     * background pool and invoke [callback] with the resulting child
     * nodes when the round-trip completes.
     */
    fun loadChildren(project: Project, callback: (List<ForgeTreeNode>) -> Unit)

    /**
     * Navigation target for double-click / "Go to declaration" actions.
     * Return null for nodes that don't map to a file location (e.g.
     * grouping nodes like "Dependencies").
     */
    fun navigationTarget(): NavigationTarget? = null

    /**
     * Tooltip shown on hover. Default null = no tooltip. Nodes that
     * represent a file or carry extra metadata (full path, version,
     * framework) should return a multi-line string.
     */
    fun tooltip(): String? = null
}
