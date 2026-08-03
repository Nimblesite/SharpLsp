package com.forgelsp.rider.toolwindow.nuget

import com.forgelsp.rider.lsp.NuGetInstallParams
import com.forgelsp.rider.lsp.NuGetInstalledParams
import com.forgelsp.rider.lsp.NuGetSearchParams
import com.forgelsp.rider.lsp.NuGetTarget
import com.forgelsp.rider.lsp.NuGetTargetsParams
import com.forgelsp.rider.lsp.NuGetUninstallParams
import com.forgelsp.rider.lsp.PackageInfo
import com.forgelsp.rider.toolwindow.nodes.LspBridge
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.ui.AnimatedIcon
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.event.ActionEvent
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.AbstractAction
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.ListSelectionModel
import javax.swing.SwingUtilities
import javax.swing.Timer
import javax.swing.border.EmptyBorder

/**
 * Main UI for the Forge NuGet browser. Visual parity with the VS Code
 * webview in `editors/vscode/src/nuget-browser/`.
 *
 * Layout:
 *
 *   ┌─ header (56 px) ─────────────────────────────────────────┐
 *   │ NuGet   Browse Installed   Target ▾   [ search… ]   ↻    │
 *   ├─ content ────────────────────────────┬───────────────────┤
 *   │ package cards                        │ details (384 px)  │
 *   └──────────────────────────────────────┴───────────────────┘
 *
 * Behaviour matches the VS Code panel: open → load targets → search ""
 * + load installed in parallel. Tab click switches view. Search is
 * debounced 250 ms. Install/uninstall are optimistic with revert on
 * failure and toast notifications.
 */
class ForgeNuGetBrowserPanel(
    private val project: Project,
    initialProjectPath: String?,
) {
    private val state = NuGetState()

    // ── Header widgets ─────────────────────────────────────────
    private val browseTab = TabLabel("Browse") { switchTab(Tab.BROWSE) }
    private val installedTab = TabLabel("Installed") { switchTab(Tab.INSTALLED) }
    private val targetCombo = ComboBox<NuGetTarget>().apply {
        renderer = TargetComboRenderer()
        isEnabled = false
    }
    private val searchField = JBTextField().apply {
        emptyText.text = "Search packages…"
        columns = 32
    }
    private val refreshButton = JButton(AllIcons.Actions.Refresh).apply {
        toolTipText = "Refresh"
        isBorderPainted = false
        isContentAreaFilled = false
        isFocusPainted = false
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
    }
    private val headerSpinner = JBLabel(AnimatedIcon.Default()).apply { isVisible = false }

    // ── Body widgets ───────────────────────────────────────────
    private val listModel = DefaultListModel<DisplayPackage>()
    private val resultsList = JBList(listModel).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        cellRenderer = PackageCardRenderer()
        fixedCellHeight = 82
        background = NuGetColors.HEADER_BG
        border = EmptyBorder(8, 8, 8, 8)
    }
    private val listEmpty = JBLabel("", AllIcons.General.InspectionsEye, JBLabel.CENTER).apply {
        foreground = NuGetColors.FG_SECONDARY
        horizontalTextPosition = JBLabel.CENTER
        verticalTextPosition = JBLabel.BOTTOM
        text = "No packages found"
    }
    private val listContainer = JPanel(BorderLayout()).apply {
        background = NuGetColors.HEADER_BG
    }

    private val detailsPanel = PackageDetailsPanel(
        project = project,
        onInstall = { pkg, version -> installPackage(pkg, version) },
        onUninstall = { pkg -> uninstallPackage(pkg) },
    )

    private val debounceTimer = Timer(DEBOUNCE_MS) { runSearch() }.apply { isRepeats = false }

    private val initialTargetPath: String? = initialProjectPath

    val component: JComponent = buildComponent()

    init {
        wireEvents()
        loadTargets()
    }

    // ── Build UI ───────────────────────────────────────────────

    private fun buildComponent(): JComponent {
        val header = buildHeader()

        listContainer.add(JBScrollPane(resultsList).apply {
            border = null
            viewport.background = NuGetColors.HEADER_BG
        }, BorderLayout.CENTER)

        val split = JPanel(BorderLayout()).apply {
            background = NuGetColors.HEADER_BG
            add(listContainer, BorderLayout.CENTER)
            val detailsWrap = JPanel(BorderLayout()).apply {
                background = NuGetColors.PANEL_BG
                preferredSize = Dimension(384, 0)
                border = BorderFactory.createMatteBorder(0, 1, 0, 0, NuGetColors.BORDER_LIGHT)
                add(detailsPanel.component, BorderLayout.CENTER)
            }
            add(detailsWrap, BorderLayout.EAST)
        }

        return JPanel(BorderLayout()).apply {
            background = NuGetColors.HEADER_BG
            add(header, BorderLayout.NORTH)
            add(split, BorderLayout.CENTER)
        }
    }

    private fun buildHeader(): JComponent {
        browseTab.isActive = true

        val logo = JBLabel("NuGet").apply {
            foreground = NuGetColors.FG_PRIMARY
            font = font.deriveFont(Font.BOLD, 15f)
            border = JBUI.Borders.emptyRight(20)
        }

        val tabsPanel = JPanel().apply {
            isOpaque = false
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(browseTab)
            add(Box.createHorizontalStrut(4))
            add(installedTab)
        }

        val targetWrap = JPanel(BorderLayout(6, 0)).apply {
            isOpaque = false
            border = JBUI.Borders.emptyLeft(24)
            val label = JBLabel("", AllIcons.Nodes.Module, JBLabel.LEFT).apply {
                foreground = NuGetColors.FG_SECONDARY
            }
            add(label, BorderLayout.WEST)
            targetCombo.preferredSize = Dimension(220, targetCombo.preferredSize.height)
            add(targetCombo, BorderLayout.CENTER)
        }

        val left = JPanel().apply {
            isOpaque = false
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(logo)
            add(tabsPanel)
            add(targetWrap)
        }

        val right = JPanel().apply {
            isOpaque = false
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            searchField.preferredSize = Dimension(280, searchField.preferredSize.height)
            add(searchField)
            add(Box.createHorizontalStrut(6))
            add(headerSpinner)
            add(Box.createHorizontalStrut(6))
            add(refreshButton)
        }

        return JPanel(BorderLayout()).apply {
            background = NuGetColors.HEADER_BG
            isOpaque = true
            border = EmptyBorder(10, 20, 10, 20)
            add(left, BorderLayout.WEST)
            add(right, BorderLayout.EAST)
        }
    }

    // ── Events ─────────────────────────────────────────────────

    private fun wireEvents() {
        searchField.addKeyListener(object : KeyAdapter() {
            override fun keyReleased(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER) {
                    debounceTimer.stop()
                    runSearch()
                } else {
                    debounceTimer.restart()
                }
            }
        })
        refreshButton.addActionListener { refresh() }

        targetCombo.addActionListener {
            val picked = targetCombo.selectedItem as? NuGetTarget ?: return@addActionListener
            if (picked == state.target) return@addActionListener
            state.target = picked
            state.setInstalled(emptyList())
            resultsList.clearSelection()
            detailsPanel.showEmpty()
            loadInstalled()
            runSearch()
        }

        resultsList.addListSelectionListener { e ->
            if (e.valueIsAdjusting) return@addListSelectionListener
            val selected = resultsList.selectedValue ?: run {
                detailsPanel.showEmpty(); return@addListSelectionListener
            }
            detailsPanel.show(selected.info, state.target)
        }
    }

    private fun switchTab(tab: Tab) {
        if (state.tab == tab) return
        state.tab = tab
        browseTab.isActive = tab == Tab.BROWSE
        installedTab.isActive = tab == Tab.INSTALLED
        searchField.isVisible = tab == Tab.BROWSE
        refreshList()
        if (tab == Tab.INSTALLED) loadInstalled()
    }

    // ── LSP calls ──────────────────────────────────────────────

    private fun loadTargets() {
        headerSpinner.isVisible = true
        LspBridge.call(project) { lsp ->
            lsp.nugetTargets(NuGetTargetsParams(workspaceRoot = project.basePath.orEmpty()))
        }.whenComplete { response, err ->
            SwingUtilities.invokeLater {
                headerSpinner.isVisible = false
                if (err != null || response == null) {
                    toast("Failed to load targets: ${err?.message ?: "no response"}", NotificationType.ERROR)
                    return@invokeLater
                }
                state.allTargets = response.targets
                targetCombo.removeAllItems()
                response.targets.forEach { targetCombo.addItem(it) }
                targetCombo.isEnabled = response.targets.isNotEmpty()

                val initial = response.targets.firstOrNull { it.path == initialTargetPath }
                    ?: response.targets.firstOrNull { it.id == response.defaultTargetId }
                    ?: response.targets.firstOrNull()
                if (initial != null) {
                    state.target = initial
                    targetCombo.selectedItem = initial
                    loadInstalled()
                    runSearch()
                }
            }
        }
    }

    private fun loadInstalled() {
        val target = state.target ?: return
        LspBridge.call(project) { lsp ->
            lsp.nugetInstalled(
                NuGetInstalledParams(target = target, projectPath = target.path),
            )
        }.whenComplete { response, err ->
            SwingUtilities.invokeLater {
                if (err != null || response == null) return@invokeLater
                state.setInstalled(response.packages)
                refreshList()
            }
        }
    }

    private fun runSearch() {
        val target = state.target ?: return
        state.searchQuery = searchField.text.trim()
        headerSpinner.isVisible = true
        LspBridge.call(project) { lsp ->
            lsp.nugetSearch(
                NuGetSearchParams(
                    query = state.searchQuery,
                    target = target,
                    projectPath = target.path,
                    prerelease = false,
                ),
            )
        }.whenComplete { response, err ->
            SwingUtilities.invokeLater {
                headerSpinner.isVisible = false
                if (err != null || response == null) {
                    toast("Search failed: ${err?.message ?: "no response"}", NotificationType.ERROR)
                    return@invokeLater
                }
                state.setBrowse(response.packages)
                refreshList()
            }
        }
    }

    private fun refresh() {
        loadInstalled()
        runSearch()
    }

    // ── List rendering ─────────────────────────────────────────

    private fun refreshList() {
        val current = state.visible()
        listModel.clear()
        if (current.isEmpty()) {
            showListEmptyState()
        } else {
            hideListEmptyState()
            current.forEach { listModel.addElement(it) }
        }
    }

    private fun showListEmptyState() {
        listContainer.removeAll()
        val center = JPanel().apply {
            background = NuGetColors.HEADER_BG
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(Box.createVerticalGlue())
            listEmpty.alignmentX = JComponent.CENTER_ALIGNMENT
            add(listEmpty)
            add(Box.createVerticalGlue())
        }
        listContainer.add(center, BorderLayout.CENTER)
        listContainer.revalidate()
        listContainer.repaint()
    }

    private fun hideListEmptyState() {
        listContainer.removeAll()
        listContainer.add(JBScrollPane(resultsList).apply {
            border = null
            viewport.background = NuGetColors.HEADER_BG
        }, BorderLayout.CENTER)
        listContainer.revalidate()
        listContainer.repaint()
    }

    // ── Install / Uninstall (optimistic) ───────────────────────

    private fun installPackage(pkg: PackageInfo, version: String) {
        val target = state.target ?: return
        state.pending += pkg.id
        detailsPanel.setBusy(true)
        refreshList()

        LspBridge.call(project, timeoutMs = 120_000) { lsp ->
            lsp.nugetInstall(
                NuGetInstallParams(
                    target = target,
                    projectPath = target.path,
                    packageId = pkg.id,
                    version = version,
                ),
            )
        }.whenComplete { response, err ->
            SwingUtilities.invokeLater {
                state.pending -= pkg.id
                detailsPanel.setBusy(false)
                if (err != null || response == null || !response.success) {
                    toast("Install failed: ${response?.message ?: err?.message.orEmpty()}", NotificationType.ERROR)
                    refreshList()
                    return@invokeLater
                }
                toast("Installed ${pkg.id} $version", NotificationType.INFORMATION)
                loadInstalled()
                runSearch()
            }
        }
    }

    private fun uninstallPackage(pkg: PackageInfo) {
        val target = state.target ?: return
        state.pending += pkg.id
        detailsPanel.setBusy(true)
        refreshList()

        LspBridge.call(project, timeoutMs = 120_000) { lsp ->
            lsp.nugetUninstall(
                NuGetUninstallParams(
                    target = target,
                    projectPath = target.path,
                    packageId = pkg.id,
                ),
            )
        }.whenComplete { response, err ->
            SwingUtilities.invokeLater {
                state.pending -= pkg.id
                detailsPanel.setBusy(false)
                if (err != null || response == null || !response.success) {
                    toast("Uninstall failed: ${response?.message ?: err?.message.orEmpty()}", NotificationType.ERROR)
                    refreshList()
                    return@invokeLater
                }
                toast("Uninstalled ${pkg.id}", NotificationType.INFORMATION)
                loadInstalled()
                runSearch()
            }
        }
    }

    // ── Notifications ──────────────────────────────────────────

    private fun toast(message: String, type: NotificationType) {
        ApplicationManager.getApplication().invokeLater {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("Forge")
                .createNotification(message, type)
                .notify(project)
        }
    }

    private companion object {
        const val DEBOUNCE_MS = 250
    }
}

// ── Supporting widgets ─────────────────────────────────────────

private class TabLabel(
    text: String,
    private val onClick: () -> Unit,
) : JBLabel(text) {
    var isActive: Boolean = false
        set(value) {
            field = value
            foreground = if (value) NuGetColors.ACCENT else NuGetColors.FG_SECONDARY
            font = font.deriveFont(if (value) Font.BOLD else Font.PLAIN)
            border = if (value) {
                javax.swing.BorderFactory.createMatteBorder(0, 0, 2, 0, NuGetColors.ACCENT)
            } else {
                EmptyBorder(0, 0, 2, 0)
            }
            repaint()
        }

    init {
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        border = EmptyBorder(0, 12, 2, 12)
        foreground = NuGetColors.FG_SECONDARY
        addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) { onClick() }
        })
    }
}

private class TargetComboRenderer : ColoredListCellRenderer<NuGetTarget>() {
    override fun customizeCellRenderer(
        list: javax.swing.JList<out NuGetTarget>,
        value: NuGetTarget?,
        index: Int,
        selected: Boolean,
        hasFocus: Boolean,
    ) {
        val t = value ?: run { append("(no targets)"); return }
        append(t.displayName)
        append("  ${t.kind}", SimpleTextAttributes.GRAY_ATTRIBUTES)
    }
}

/**
 * Dialog wrapper around [ForgeNuGetBrowserPanel] for the right-click
 * "Install NuGet Package…" action. Pre-selects the clicked project.
 */
class ForgeNuGetBrowserDialog(
    project: Project,
    initialProjectPath: String,
) : com.intellij.openapi.ui.DialogWrapper(project, true) {
    private val panel = ForgeNuGetBrowserPanel(project, initialProjectPath)

    init {
        title = "Install NuGet Package"
        setOKButtonText("Close")
        init()
    }

    override fun createCenterPanel(): JComponent = panel.component.also {
        it.preferredSize = Dimension(1100, 640)
    }

    override fun createActions(): Array<javax.swing.Action> =
        arrayOf(object : AbstractAction("Close") {
            override fun actionPerformed(e: ActionEvent?) = close(OK_EXIT_CODE)
        })
}
