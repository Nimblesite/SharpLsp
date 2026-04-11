package com.forgelsp.rider.toolwindow.nuget

import com.intellij.icons.AllIcons
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListCellRenderer
import javax.swing.SwingConstants
import javax.swing.border.EmptyBorder

/**
 * Card-style renderer for a NuGet package row. Mirrors the VS Code
 * webview layout:
 *
 *   ┌──┐  Package.Id                       [ v1.2.3 ]
 *   │📦│  Short description, one line…
 *   └──┘  [icon] 12M Downloads   [icon] Author
 *
 * The card is built once and re-populated for each row via
 * [getListCellRendererComponent]. We avoid allocating a new JPanel per
 * row — Swing calls this method during paint, so allocations here
 * burn CPU on every repaint.
 */
internal class PackageCardRenderer : ListCellRenderer<DisplayPackage> {
    private val iconBox = IconBoxLabel()
    private val nameLabel = JBLabel().apply {
        font = font.deriveFont(Font.BOLD, font.size2D + 1f)
        foreground = NuGetColors.FG_PRIMARY
    }
    private val versionPill = PillLabel()
    private val descLabel = JBLabel().apply {
        foreground = NuGetColors.FG_SECONDARY
        font = font.deriveFont(font.size2D - 1f)
    }
    private val downloadsLabel = JBLabel("", AllIcons.Actions.Download, SwingConstants.LEFT).apply {
        foreground = NuGetColors.FG_MUTED
        font = font.deriveFont(font.size2D - 2f)
        iconTextGap = 3
    }
    private val authorsLabel = JBLabel("", AllIcons.General.User, SwingConstants.LEFT).apply {
        foreground = NuGetColors.FG_MUTED
        font = font.deriveFont(font.size2D - 2f)
        iconTextGap = 3
    }

    private val headerRow = JPanel(BorderLayout(8, 0)).apply {
        isOpaque = false
        add(nameLabel, BorderLayout.CENTER)
        add(versionPill, BorderLayout.EAST)
    }
    private val metaRow = JPanel(FlowLayout(FlowLayout.LEFT, 16, 0)).apply {
        isOpaque = false
        border = JBUI.Borders.emptyTop(6)
        add(downloadsLabel)
        add(authorsLabel)
    }
    private val contentCol = JPanel().apply {
        isOpaque = false
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        alignmentY = Component.TOP_ALIGNMENT
        add(headerRow)
        add(Box.createVerticalStrut(4))
        add(descLabel)
        add(metaRow)
    }
    private val card = SelectableCard().apply {
        layout = BorderLayout(14, 0)
        border = EmptyBorder(12, 14, 12, 14)
        add(iconBox, BorderLayout.WEST)
        add(contentCol, BorderLayout.CENTER)
    }

    override fun getListCellRendererComponent(
        list: JList<out DisplayPackage>,
        value: DisplayPackage?,
        index: Int,
        selected: Boolean,
        focused: Boolean,
    ): Component {
        val row = value ?: return card
        val info = row.info

        card.isSelected = selected
        card.isPending = row.pending
        iconBox.isSelected = selected
        iconBox.isInstalled = info.isInstalled

        nameLabel.text = info.id
        nameLabel.foreground = if (selected) NuGetColors.ACCENT else NuGetColors.FG_PRIMARY

        versionPill.setVersion(
            text = if (info.isInstalled) "v${info.installedVersion ?: info.version}" else info.version,
            installed = info.isInstalled,
            pending = row.pending,
        )

        descLabel.text = info.description.lineSequence().firstOrNull()?.take(160).orEmpty()

        downloadsLabel.text = if (info.downloadCount > 0) formatDownloads(info.downloadCount) else ""
        downloadsLabel.isVisible = info.downloadCount > 0
        authorsLabel.text = info.authors.take(40)
        authorsLabel.isVisible = info.authors.isNotBlank()

        card.preferredSize = Dimension(list.width.coerceAtLeast(300), 78)
        return card
    }

    private fun formatDownloads(count: Long): String = when {
        count >= 1_000_000_000 -> "%.1fB Downloads".format(count / 1_000_000_000.0)
        count >= 1_000_000 -> "%.1fM Downloads".format(count / 1_000_000.0)
        count >= 1_000 -> "%.1fK Downloads".format(count / 1_000.0)
        else -> "$count Downloads"
    }
}

/**
 * Rounded card background with a 2-px left accent stripe when selected.
 * Drawn manually so we get rounded corners that match the VS Code CSS
 * without depending on a look-and-feel that may or may not round
 * JPanel borders.
 */
private class SelectableCard : JPanel() {
    var isSelected: Boolean = false
    var isPending: Boolean = false

    init {
        isOpaque = false
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            val bg: Color = if (isSelected) NuGetColors.CARD_SELECTED_BG else NuGetColors.HEADER_BG
            g2.color = bg
            g2.fillRoundRect(0, 0, width - 1, height - 1, 8, 8)
            if (isSelected) {
                g2.color = NuGetColors.ACCENT
                g2.fillRect(0, 4, 3, height - 8)
            }
            if (isPending) {
                g2.color = Color(0, 0, 0, 60)
                g2.fillRoundRect(0, 0, width - 1, height - 1, 8, 8)
            }
        } finally {
            g2.dispose()
        }
        super.paintComponent(g)
    }
}

/** 40x40 rounded square with a package icon. */
private class IconBoxLabel : JComponent() {
    var isSelected: Boolean = false
    var isInstalled: Boolean = false

    init {
        preferredSize = Dimension(40, 40)
        minimumSize = preferredSize
        maximumSize = preferredSize
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = if (isSelected) NuGetColors.ACCENT_STRONG else NuGetColors.ICON_BOX_BG
            g2.fillRoundRect(0, 0, 40, 40, 6, 6)
            val icon = AllIcons.Nodes.PpLib
            val x = (40 - icon.iconWidth) / 2
            val y = (40 - icon.iconHeight) / 2
            icon.paintIcon(this, g2, x, y)
        } finally {
            g2.dispose()
        }
    }
}

/** Rounded-pill label used for version chips. */
private class PillLabel : JComponent() {
    private var text: String = ""
    private var installed: Boolean = false
    private var pending: Boolean = false

    init {
        font = JBUI.Fonts.smallFont()
    }

    fun setVersion(text: String, installed: Boolean, pending: Boolean) {
        this.text = text
        this.installed = installed
        this.pending = pending
        preferredSize = calcSize()
        revalidate()
    }

    private fun calcSize(): Dimension {
        val metrics = getFontMetrics(font)
        val w = metrics.stringWidth(text) + 18
        val h = metrics.height + 4
        return Dimension(w, h)
    }

    override fun paintComponent(g: Graphics) {
        if (text.isEmpty()) return
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = if (installed) NuGetColors.PILL_INSTALLED_BG else NuGetColors.PILL_BG
            g2.fillRoundRect(0, 0, width, height, height, height)
            g2.font = font
            g2.color = if (installed) NuGetColors.PILL_INSTALLED_FG else NuGetColors.FG_SECONDARY
            val fm = g2.fontMetrics
            val tx = (width - fm.stringWidth(text)) / 2
            val ty = (height + fm.ascent - fm.descent) / 2
            g2.drawString(text, tx, ty)
            if (pending) {
                g2.color = Color(0xff, 0xff, 0xff, 30)
                g2.fillRoundRect(0, 0, width, height, height, height)
            }
        } finally {
            g2.dispose()
        }
    }
}
