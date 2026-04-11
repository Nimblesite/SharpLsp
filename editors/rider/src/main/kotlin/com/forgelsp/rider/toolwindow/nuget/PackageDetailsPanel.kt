package com.forgelsp.rider.toolwindow.nuget

import com.forgelsp.rider.lsp.NuGetTarget
import com.forgelsp.rider.lsp.NuGetVersionsParams
import com.forgelsp.rider.lsp.PackageInfo
import com.forgelsp.rider.toolwindow.nodes.LspBridge
import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.ui.AnimatedIcon
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.Font
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.Insets
import java.awt.RenderingHints
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingUtilities
import javax.swing.border.EmptyBorder

/**
 * Right-hand pane inside the NuGet browser. Mirrors the VS Code
 * webview's details panel:
 *
 *   ┌────────────────────────┐
 *   │ [icon] Package.Id       │
 *   │        Authors          │
 *   │                         │
 *   │ [ Install ] [ v1.2.3 ▾ ]│
 *   │                         │
 *   │ Description             │
 *   │ ……………………………………………      │
 *   │                         │
 *   │ License     View license│
 *   │ Published   5y ago      │
 *   │ Downloads   100M        │
 *   │                         │
 *   │ Tags                    │
 *   │ [tag] [tag] [tag]       │
 *   └────────────────────────┘
 *
 * Empty state is a centered icon + "Select a package to view details".
 */
internal class PackageDetailsPanel(
    private val project: Project,
    private val onInstall: (PackageInfo, String) -> Unit,
    private val onUninstall: (PackageInfo) -> Unit,
) {
    private val cards = CardLayout()
    val component: JPanel = JPanel(cards).apply {
        background = NuGetColors.PANEL_BG
    }

    private var currentPackage: PackageInfo? = null
    private var currentTarget: NuGetTarget? = null

    // ── Empty state ────────────────────────────────────────────
    private val emptyPane = buildEmptyPane()

    // ── Details widgets ────────────────────────────────────────
    private val iconBox = DetailsIconBox()
    private val titleLabel = JBLabel().apply {
        foreground = NuGetColors.FG_PRIMARY
        font = font.deriveFont(Font.BOLD, 18f)
    }
    private val authorsLabel = JBLabel().apply {
        foreground = NuGetColors.FG_SECONDARY
        font = font.deriveFont(font.size2D - 1f)
    }
    private val installButton = JButton("Install", AllIcons.Actions.Download).apply {
        background = NuGetColors.ACCENT_STRONG
        foreground = Color.WHITE
        isOpaque = true
        isBorderPainted = false
        font = font.deriveFont(Font.BOLD)
    }
    private val uninstallButton = JButton("Remove", AllIcons.Actions.Cancel).apply {
        background = NuGetColors.PANEL_BG
        foreground = NuGetColors.DANGER
        isBorderPainted = false
        font = font.deriveFont(Font.BOLD)
        isVisible = false
    }
    private val versionsCombo = ComboBox<String>().apply {
        isEnabled = false
        preferredSize = Dimension(150, preferredSize.height)
    }
    private val versionsSpinner = JBLabel(AnimatedIcon.Default()).apply { isVisible = false }

    private val descriptionArea = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
        background = NuGetColors.PANEL_BG
        foreground = NuGetColors.FG_SECONDARY
        border = null
        font = font.deriveFont(font.size2D)
    }
    private val licenseLink = LinkLabel("View License")
    private val publishedLabel = JBLabel().apply { foreground = NuGetColors.FG_PRIMARY }
    private val downloadsLabel = JBLabel().apply { foreground = NuGetColors.FG_PRIMARY }
    private val homepageLink = LinkLabel("View Homepage")
    private val tagsPanel = JPanel().apply {
        background = NuGetColors.PANEL_BG
        layout = java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 6, 6)
    }

    private val detailsPane = buildDetailsPane()

    init {
        component.add(emptyPane, CARD_EMPTY)
        component.add(detailsPane, CARD_DETAILS)
        installButton.addActionListener {
            val pkg = currentPackage ?: return@addActionListener
            val version = versionsCombo.selectedItem as? String ?: pkg.version
            onInstall(pkg, version)
        }
        uninstallButton.addActionListener {
            val pkg = currentPackage ?: return@addActionListener
            onUninstall(pkg)
        }
        homepageLink.onClick = { currentPackage?.projectUrl?.let { BrowserUtil.browse(it) } }
        licenseLink.onClick = { currentPackage?.licenseUrl?.let { BrowserUtil.browse(it) } }
        showEmpty()
    }

    fun show(pkg: PackageInfo, target: NuGetTarget?) {
        currentPackage = pkg
        currentTarget = target
        titleLabel.text = pkg.id
        authorsLabel.text = pkg.authors.ifBlank { "Unknown author" }
        descriptionArea.text = pkg.description.ifBlank { "(no description)" }
        descriptionArea.caretPosition = 0

        publishedLabel.text = pkg.published ?: "—"
        downloadsLabel.text = if (pkg.downloadCount > 0) "%,d".format(pkg.downloadCount) else "—"

        licenseLink.isVisible = !pkg.licenseUrl.isNullOrBlank()
        homepageLink.isVisible = !pkg.projectUrl.isNullOrBlank()

        tagsPanel.removeAll()
        pkg.tags.take(12).forEach { tagsPanel.add(TagChip(it)) }
        tagsPanel.revalidate()

        iconBox.isInstalled = pkg.isInstalled
        installButton.isEnabled = target != null && !pkg.isInstalled
        installButton.text = if (pkg.isInstalled) "Installed" else "Install"
        uninstallButton.isVisible = pkg.isInstalled
        uninstallButton.isEnabled = target != null

        cards.show(component, CARD_DETAILS)
        loadVersions(pkg)
    }

    fun showEmpty() {
        currentPackage = null
        cards.show(component, CARD_EMPTY)
    }

    fun setBusy(busy: Boolean) {
        installButton.isEnabled = !busy && currentPackage?.isInstalled == false && currentTarget != null
        uninstallButton.isEnabled = !busy && currentPackage?.isInstalled == true && currentTarget != null
        versionsCombo.isEnabled = !busy
    }

    // ── Load versions ──────────────────────────────────────────

    private fun loadVersions(pkg: PackageInfo) {
        versionsCombo.removeAllItems()
        versionsCombo.isEnabled = false
        versionsSpinner.isVisible = true

        LspBridge.call(project) { lsp ->
            lsp.nugetVersions(NuGetVersionsParams(packageId = pkg.id))
        }.whenComplete { response, err ->
            SwingUtilities.invokeLater {
                versionsSpinner.isVisible = false
                val versions = if (err != null || response == null) {
                    listOf(pkg.version)
                } else {
                    response.versions.ifEmpty { listOf(pkg.version) }
                }
                versions.forEach { versionsCombo.addItem(it) }
                versionsCombo.isEnabled = currentTarget != null
                versionsCombo.selectedIndex = 0
            }
        }
    }

    // ── Layout ─────────────────────────────────────────────────

    private fun buildEmptyPane(): JPanel {
        val icon = JBLabel(AllIcons.Nodes.PpLib).apply {
            alignmentX = JComponent.CENTER_ALIGNMENT
        }
        val text = JBLabel("Select a package to view details").apply {
            foreground = NuGetColors.FG_SECONDARY
            alignmentX = JComponent.CENTER_ALIGNMENT
        }
        return JPanel().apply {
            background = NuGetColors.PANEL_BG
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(Box.createVerticalGlue())
            add(icon)
            add(Box.createVerticalStrut(12))
            add(text)
            add(Box.createVerticalGlue())
        }
    }

    private fun buildDetailsPane(): JPanel {
        val header = JPanel(BorderLayout(12, 0)).apply {
            background = NuGetColors.PANEL_BG
            add(iconBox, BorderLayout.WEST)
            val titles = JPanel().apply {
                background = NuGetColors.PANEL_BG
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                add(titleLabel)
                add(authorsLabel)
            }
            add(titles, BorderLayout.CENTER)
        }

        val versionRow = JPanel().apply {
            background = NuGetColors.PANEL_BG
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(JBLabel("Version:").apply { foreground = NuGetColors.FG_SECONDARY })
            add(Box.createHorizontalStrut(6))
            add(versionsCombo)
            add(Box.createHorizontalStrut(6))
            add(versionsSpinner)
        }

        val actionsRow = JPanel().apply {
            background = NuGetColors.PANEL_BG
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(installButton)
            add(Box.createHorizontalStrut(8))
            add(uninstallButton)
            add(Box.createHorizontalGlue())
        }

        val actionsBlock = JPanel().apply {
            background = NuGetColors.PANEL_BG
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = EmptyBorder(16, 0, 16, 0)
            add(versionRow)
            add(Box.createVerticalStrut(10))
            add(actionsRow)
        }

        val descSection = section("Description", JBScrollPane(descriptionArea).apply {
            border = null
            preferredSize = Dimension(0, 140)
            viewport.background = NuGetColors.PANEL_BG
        })

        val infoGrid = JPanel(GridBagLayout()).apply {
            background = NuGetColors.PANEL_BG
            val gbc = GridBagConstraints().apply {
                gridx = 0
                gridy = 0
                anchor = GridBagConstraints.WEST
                fill = GridBagConstraints.HORIZONTAL
                insets = Insets(2, 0, 2, 12)
            }
            addRow(gbc, "License", licenseLink)
            addRow(gbc, "Homepage", homepageLink)
            addRow(gbc, "Published", publishedLabel)
            addRow(gbc, "Downloads", downloadsLabel)
        }

        val infoSection = section("Info", infoGrid)
        val tagsSection = section("Tags", tagsPanel)

        val body = JPanel().apply {
            background = NuGetColors.PANEL_BG
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = EmptyBorder(20, 24, 20, 24)
            add(header)
            add(actionsBlock)
            add(descSection)
            add(Box.createVerticalStrut(12))
            add(infoSection)
            add(Box.createVerticalStrut(12))
            add(tagsSection)
            add(Box.createVerticalGlue())
        }

        return JPanel(BorderLayout()).apply {
            background = NuGetColors.PANEL_BG
            add(JBScrollPane(body).apply {
                border = null
                viewport.background = NuGetColors.PANEL_BG
            }, BorderLayout.CENTER)
        }
    }

    private fun section(title: String, content: JComponent): JPanel {
        val header = JBLabel(title.uppercase()).apply {
            foreground = NuGetColors.FG_MUTED
            font = font.deriveFont(Font.BOLD, font.size2D - 2f)
            border = EmptyBorder(8, 0, 6, 0)
        }
        return JPanel().apply {
            background = NuGetColors.PANEL_BG
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JComponent.LEFT_ALIGNMENT
            add(header)
            add(content)
        }
    }

    private fun JPanel.addRow(gbc: GridBagConstraints, label: String, value: JComponent) {
        gbc.gridx = 0
        add(JBLabel(label).apply { foreground = NuGetColors.FG_MUTED }, gbc)
        gbc.gridx = 1
        add(value, gbc)
        gbc.gridy++
    }

    private companion object {
        const val CARD_EMPTY = "empty"
        const val CARD_DETAILS = "details"
    }
}

// ── Supporting widgets ────────────────────────────────────────

private class DetailsIconBox : JComponent() {
    var isInstalled: Boolean = false

    init {
        preferredSize = Dimension(48, 48)
        minimumSize = preferredSize
        maximumSize = preferredSize
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = NuGetColors.ACCENT_STRONG
            g2.fillRoundRect(0, 0, 48, 48, 8, 8)
            val icon = AllIcons.Nodes.PpLib
            val x = (48 - icon.iconWidth) / 2
            val y = (48 - icon.iconHeight) / 2
            icon.paintIcon(this, g2, x, y)
        } finally {
            g2.dispose()
        }
    }
}

private class LinkLabel(text: String) : JBLabel("<html><u>$text</u></html>") {
    var onClick: (() -> Unit)? = null

    init {
        foreground = NuGetColors.ACCENT
        cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
        addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) { onClick?.invoke() }
        })
    }
}

private class TagChip(text: String) : JComponent() {
    private val label = text

    init {
        val fm = getFontMetrics(JBUI.Fonts.smallFont())
        preferredSize = Dimension(fm.stringWidth(label) + 18, fm.height + 6)
        isOpaque = false
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = NuGetColors.PILL_BG
            g2.fillRoundRect(0, 0, width, height, height, height)
            g2.font = JBUI.Fonts.smallFont()
            g2.color = NuGetColors.FG_SECONDARY
            val fm = g2.fontMetrics
            val tx = (width - fm.stringWidth(label)) / 2
            val ty = (height + fm.ascent - fm.descent) / 2
            g2.drawString(label, tx, ty)
        } finally {
            g2.dispose()
        }
    }
}
