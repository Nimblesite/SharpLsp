package com.forgelsp.rider.toolwindow.nuget

import com.forgelsp.rider.lsp.NuGetInstallParams
import com.forgelsp.rider.lsp.NuGetSearchParams
import com.forgelsp.rider.lsp.NuGetTarget
import com.forgelsp.rider.lsp.NuGetTargetsParams
import com.forgelsp.rider.lsp.NuGetUninstallParams
import com.forgelsp.rider.lsp.NuGetVersionsParams
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
import com.intellij.ui.JBSplitter
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.event.ActionEvent
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.AbstractAction
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.ListSelectionModel
import javax.swing.SwingUtilities
import javax.swing.Timer

/**
 * Main UI for the NuGet Package Browser.
 *
 * Parity target: VS Code extension's nuget-browser webview. Layout:
 *
 *   ┌─ toolbar ─────────────────────────────────────────────────┐
 *   │  target ▾   [search        ]  [ ] prerelease   [Search]   │
 *   ├─ split ───────────────────────────────────────────────────┤
 *   │  results list        │  details + install / uninstall      │
 *   └───────────────────────────────────────────────────────────┘
 *
 * A debounced search runs 300ms after the last keystroke. Targets are
 * loaded lazily on first show via `forge/nuget/targets`.
 */
class ForgeNuGetBrowserPanel(
    private val project: Project,
    private val initialProjectPath: String?,
) {
    private val targetCombo = ComboBox<NuGetTarget>()
    private val searchField = JBTextField()
    private val prereleaseCheckbox = JBCheckBox("Prerelease", false)
    private val searchButton = JButton(AllIcons.Actions.Search)
    private val statusLabel = JBLabel("")
    private val spinner = JBLabel(AnimatedIcon.Default())

    private val resultsModel = DefaultListModel<PackageInfo>()
    private val resultsList = JBList(resultsModel).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        cellRenderer = PackageListRenderer()
    }

    private val detailsPanel = PackageDetailsPanel(project) { pkg, version ->
        installPackage(pkg, version)
    }.also { it.onUninstall = ::uninstallPackage }

    private val debounceTimer = Timer(DEBOUNCE_MS) { runSearch() }.apply {
        isRepeats = false
    }

    val component: JComponent = buildComponent()

    init {
        loadTargets()
    }

    private fun buildComponent(): JComponent {
        spinner.isVisible = false

        searchField.emptyText.text = "Search NuGet packages…"
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
        searchButton.toolTipText = "Search"
        searchButton.addActionListener { runSearch() }

        targetCombo.renderer = TargetComboRenderer()
        targetCombo.isEnabled = false

        resultsList.addListSelectionListener { e ->
            if (e.valueIsAdjusting) return@addListSelectionListener
            val selected = resultsList.selectedValue ?: return@addListSelectionListener
            detailsPanel.show(selected, targetCombo.selectedItem as? NuGetTarget)
        }

        val toolbar = JPanel(FlowLayout(FlowLayout.LEFT, 6, 4)).apply {
            add(JBLabel("Target:"))
            add(targetCombo)
            add(Box.createHorizontalStrut(8))
            add(searchField.also { it.columns = 28 })
            add(searchButton)
            add(prereleaseCheckbox)
            add(Box.createHorizontalStrut(8))
            add(spinner)
            add(statusLabel)
        }

        val split = JBSplitter(false, 0.4f).apply {
            firstComponent = JBScrollPane(resultsList)
            secondComponent = detailsPanel.component
            dividerWidth = 2
        }

        return JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(4)
            add(toolbar, BorderLayout.NORTH)
            add(split, BorderLayout.CENTER)
        }
    }

    // ── Targets ────────────────────────────────────────────────────

    private fun loadTargets() {
        setBusy(true, "Loading targets…")
        LspBridge.call(project) { lsp ->
            lsp.nugetTargets(NuGetTargetsParams(workspaceRoot = project.basePath.orEmpty()))
        }.whenComplete { response, err ->
            SwingUtilities.invokeLater {
                setBusy(false, "")
                if (err != null || response == null) {
                    statusLabel.text = "Failed to load targets: ${err?.message ?: "no response"}"
                    statusLabel.foreground = JBUI.CurrentTheme.NotificationError.foregroundColor()
                    return@invokeLater
                }
                targetCombo.removeAllItems()
                response.targets.forEach { targetCombo.addItem(it) }
                targetCombo.isEnabled = response.targets.isNotEmpty()

                val initial = response.targets.firstOrNull { it.path == initialProjectPath }
                    ?: response.targets.firstOrNull { it.id == response.defaultTargetId }
                    ?: response.targets.firstOrNull()
                if (initial != null) targetCombo.selectedItem = initial
            }
        }
    }

    // ── Search ─────────────────────────────────────────────────────

    private fun runSearch() {
        val query = searchField.text.trim()
        if (query.isEmpty()) {
            resultsModel.clear()
            statusLabel.text = ""
            return
        }
        val target = targetCombo.selectedItem as? NuGetTarget
        setBusy(true, "Searching…")
        LspBridge.call(project) { lsp ->
            lsp.nugetSearch(
                NuGetSearchParams(
                    query = query,
                    target = target,
                    projectPath = target?.path,
                    prerelease = prereleaseCheckbox.isSelected,
                ),
            )
        }.whenComplete { response, err ->
            SwingUtilities.invokeLater {
                setBusy(false, "")
                resultsModel.clear()
                if (err != null || response == null) {
                    statusLabel.text = "Search failed: ${err?.message ?: "no response"}"
                    statusLabel.foreground = JBUI.CurrentTheme.NotificationError.foregroundColor()
                    return@invokeLater
                }
                response.packages.forEach { resultsModel.addElement(it) }
                statusLabel.foreground = JBUI.CurrentTheme.Label.disabledForeground()
                statusLabel.text = "${response.packages.size} of ${response.totalHits} result(s)"
                if (response.packages.isNotEmpty()) resultsList.selectedIndex = 0
            }
        }
    }

    // ── Install / Uninstall ────────────────────────────────────────

    private fun installPackage(pkg: PackageInfo, version: String) {
        val target = targetCombo.selectedItem as? NuGetTarget ?: run {
            notify("Pick a target first", NotificationType.WARNING)
            return
        }
        setBusy(true, "Installing ${pkg.id} $version…")
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
                setBusy(false, "")
                if (err != null || response == null || !response.success) {
                    val msg = response?.message ?: err?.message ?: "unknown error"
                    notify("Install failed: $msg", NotificationType.ERROR)
                    return@invokeLater
                }
                notify("Installed ${pkg.id} $version", NotificationType.INFORMATION)
                // Re-run the search so the "Installed" flag updates on the result.
                runSearch()
            }
        }
    }

    private fun uninstallPackage(pkg: PackageInfo) {
        val target = targetCombo.selectedItem as? NuGetTarget ?: return
        setBusy(true, "Uninstalling ${pkg.id}…")
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
                setBusy(false, "")
                if (err != null || response == null || !response.success) {
                    val msg = response?.message ?: err?.message ?: "unknown error"
                    notify("Uninstall failed: $msg", NotificationType.ERROR)
                    return@invokeLater
                }
                notify("Uninstalled ${pkg.id}", NotificationType.INFORMATION)
                runSearch()
            }
        }
    }

    // ── Helpers ────────────────────────────────────────────────────

    private fun setBusy(busy: Boolean, text: String) {
        spinner.isVisible = busy
        statusLabel.foreground = JBUI.CurrentTheme.Label.disabledForeground()
        statusLabel.text = text
        searchButton.isEnabled = !busy
    }

    private fun notify(message: String, type: NotificationType) {
        ApplicationManager.getApplication().invokeLater {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("Forge")
                .createNotification(message, type)
                .notify(project)
        }
    }

    private companion object {
        const val DEBOUNCE_MS = 300
    }
}

// ── Cell renderers ──────────────────────────────────────────────

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

private class PackageListRenderer : ColoredListCellRenderer<PackageInfo>() {
    override fun customizeCellRenderer(
        list: javax.swing.JList<out PackageInfo>,
        value: PackageInfo?,
        index: Int,
        selected: Boolean,
        hasFocus: Boolean,
    ) {
        val pkg = value ?: return
        icon = AllIcons.Nodes.PpLib
        append(pkg.id, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
        append("  ${pkg.version}", SimpleTextAttributes.GRAY_ATTRIBUTES)
        if (pkg.isInstalled) {
            append("  ✓ installed", SimpleTextAttributes.SYNTHETIC_ATTRIBUTES)
        }
        val desc = pkg.description.lineSequence().firstOrNull().orEmpty()
        if (desc.isNotBlank()) {
            append("  — ${desc.take(80)}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
        }
    }
}

/**
 * Dialog wrapper that embeds a [ForgeNuGetBrowserPanel] inside a modal
 * for the right-click "Install NuGet Package…" action on a project.
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
        it.preferredSize = java.awt.Dimension(900, 550)
    }

    // Only a Close button — install happens from the panel itself.
    override fun createActions(): Array<javax.swing.Action> =
        arrayOf(object : AbstractAction("Close") {
            override fun actionPerformed(e: ActionEvent?) = close(OK_EXIT_CODE)
        })
}
