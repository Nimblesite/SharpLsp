package com.forgelsp.rider.settings

import com.intellij.openapi.components.service
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Settings panel at `Settings → Tools → Forge`.
 *
 * Three knobs, no more:
 *   - Server path override
 *   - Log level (RUST_LOG)
 *   - Auto-load solution on project open
 */
class ForgeSettingsConfigurable(
    private val project: Project,
) : Configurable {
    private val serverPathField = JBTextField()
    private val logLevelCombo = ComboBox(arrayOf("error", "warn", "info", "debug", "trace"))
    private val autoLoadCheck = JBCheckBox("Auto-load solution on project open")

    private var panel: JPanel? = null

    override fun getDisplayName(): String = "Forge"

    override fun createComponent(): JComponent {
        val form = FormBuilder.createFormBuilder()
            .addLabeledComponent("forge-lsp path (blank = auto-detect):", serverPathField)
            .addLabeledComponent("Log level:", logLevelCombo)
            .addComponent(autoLoadCheck)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        panel = form
        reset()
        return form
    }

    override fun isModified(): Boolean {
        val current = project.service<ForgeSettings>().state
        return serverPathField.text != (current.serverPath ?: "") ||
            logLevelCombo.selectedItem != current.logLevel ||
            autoLoadCheck.isSelected != current.autoLoadSolution
    }

    override fun apply() {
        val settings = project.service<ForgeSettings>()
        val text = serverPathField.text
        settings.state.serverPath = if (text.isBlank()) null else text
        settings.state.logLevel = logLevelCombo.selectedItem as? String ?: "info"
        settings.state.autoLoadSolution = autoLoadCheck.isSelected
    }

    override fun reset() {
        val current = project.service<ForgeSettings>().state
        serverPathField.text = current.serverPath ?: ""
        logLevelCombo.selectedItem = current.logLevel
        autoLoadCheck.isSelected = current.autoLoadSolution
    }

    override fun disposeUIResources() {
        panel = null
    }
}
