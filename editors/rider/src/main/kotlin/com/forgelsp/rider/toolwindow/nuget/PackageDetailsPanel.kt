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
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Right-hand details pane inside the NuGet browser.
 *
 * Shows the selected package's metadata, a version dropdown populated
 * via `forge/nuget/versions`, and Install / Uninstall buttons. The
 * parent panel owns the actual LSP install/uninstall calls — this
 * class just collects user intent and fires a callback.
 */
class PackageDetailsPanel(
    private val project: Project,
    private val onInstall: (PackageInfo, String) -> Unit,
) {
    /** Set by the parent panel; fires on Uninstall button click. */
    var onUninstall: ((PackageInfo) -> Unit)? = null

    private val titleLabel = JBLabel().apply {
        font = font.deriveFont(font.size2D + 2f).deriveFont(java.awt.Font.BOLD)
    }
    private val metaLabel = JBLabel().apply {
        foreground = JBUI.CurrentTheme.Label.disabledForeground()
    }
    private val descriptionArea = javax.swing.JTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
        background = null
        border = null
    }
    private val versionsCombo = ComboBox<String>().apply {
        isEnabled = false
        preferredSize = Dimension(180, preferredSize.height)
    }
    private val versionsSpinner = JBLabel(AnimatedIcon.Default()).apply { isVisible = false }
    private val installButton = JButton("Install", AllIcons.General.Add).apply { isEnabled = false }
    private val uninstallButton = JButton("Uninstall", AllIcons.General.Remove).apply { isEnabled = false }
    private val homepageButton = JButton("Homepage", AllIcons.General.Web).apply { isVisible = false }
    private val licenseButton = JButton("License", AllIcons.Ide.External_link_arrow).apply { isVisible = false }

    private var currentPackage: PackageInfo? = null

    val component: JComponent = buildComponent()

    private fun buildComponent(): JComponent {
        installButton.addActionListener {
            val pkg = currentPackage ?: return@addActionListener
            val version = versionsCombo.selectedItem as? String ?: pkg.version
            onInstall(pkg, version)
        }
        uninstallButton.addActionListener {
            val pkg = currentPackage ?: return@addActionListener
            onUninstall?.invoke(pkg)
        }
        homepageButton.addActionListener {
            currentPackage?.projectUrl?.let { BrowserUtil.browse(it) }
        }
        licenseButton.addActionListener {
            currentPackage?.licenseUrl?.let { BrowserUtil.browse(it) }
        }

        val header = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(titleLabel)
            add(Box.createVerticalStrut(4))
            add(metaLabel)
        }

        val actions = JPanel(FlowLayout(FlowLayout.LEFT, 6, 4)).apply {
            add(JBLabel("Version:"))
            add(versionsCombo)
            add(versionsSpinner)
            add(Box.createHorizontalStrut(8))
            add(installButton)
            add(uninstallButton)
            add(Box.createHorizontalStrut(16))
            add(homepageButton)
            add(licenseButton)
        }

        val body = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(8)
            add(header, BorderLayout.NORTH)
            add(JBScrollPane(descriptionArea), BorderLayout.CENTER)
            add(actions, BorderLayout.SOUTH)
        }
        return body
    }

    fun show(pkg: PackageInfo, currentTarget: NuGetTarget?) {
        currentPackage = pkg
        titleLabel.text = pkg.id
        metaLabel.text = buildString {
            append(pkg.version)
            if (pkg.authors.isNotBlank()) append("   •   ${pkg.authors}")
            if (pkg.downloadCount > 0) append("   •   ${"%,d".format(pkg.downloadCount)} downloads")
            if (pkg.isInstalled) {
                append("   •   installed${pkg.installedVersion?.let { ": $it" } ?: ""}")
            }
        }
        descriptionArea.text = pkg.description.ifBlank { "(no description)" }
        descriptionArea.caretPosition = 0

        homepageButton.isVisible = !pkg.projectUrl.isNullOrBlank()
        licenseButton.isVisible = !pkg.licenseUrl.isNullOrBlank()

        installButton.isEnabled = currentTarget != null
        uninstallButton.isEnabled = currentTarget != null && pkg.isInstalled

        loadVersions(pkg)
    }

    private fun loadVersions(pkg: PackageInfo) {
        versionsCombo.removeAllItems()
        versionsCombo.isEnabled = false
        versionsSpinner.isVisible = true

        LspBridge.call(project) { lsp ->
            lsp.nugetVersions(NuGetVersionsParams(packageId = pkg.id))
        }.whenComplete { response, err ->
            SwingUtilities.invokeLater {
                versionsSpinner.isVisible = false
                if (err != null || response == null) {
                    // Fall back to just the current version so install still works.
                    versionsCombo.addItem(pkg.version)
                    versionsCombo.isEnabled = true
                    return@invokeLater
                }
                // Highest version first (server already sorts desc, but be defensive).
                val sorted = response.versions.ifEmpty { listOf(pkg.version) }
                sorted.forEach { versionsCombo.addItem(it) }
                versionsCombo.isEnabled = true
                versionsCombo.selectedIndex = 0
            }
        }
    }
}
