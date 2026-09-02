package com.sharplsp.rider.settings

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
 * Settings panel at `Settings → Tools → SharpLsp`.
 *
 * Three knobs, no more:
 *   - Server path override
 *   - Log level (RUST_LOG)
 *   - Auto-load solution on project open
 */
class SharpLspSettingsConfigurable(
    private val project: Project,
) : Configurable {
    private val serverPathField = JBTextField()
    private val logLevelCombo = ComboBox(arrayOf("error", "warn", "info", "debug", "trace"))
    private val autoLoadCheck = JBCheckBox("Auto-load solution on project open")

    private var panel: JPanel? = null

    override fun getDisplayName(): String = "SharpLsp"

    override fun createComponent(): JComponent {
        val form = FormBuilder.createFormBuilder()
            .addLabeledComponent("sharplsp path (blank = auto-detect):", serverPathField)
            .addLabeledComponent("Log level:", logLevelCombo)
            .addComponent(autoLoadCheck)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        panel = form
        reset()
        return form
    }

    override fun isModified(): Boolean {
        val current = project.service<SharpLspSettings>().state
        return serverPathField.text != (current.serverPath ?: "") ||
            logLevelCombo.selectedItem != current.logLevel ||
            autoLoadCheck.isSelected != current.autoLoadSolution
    }

    override fun apply() {
        val settings = project.service<SharpLspSettings>()
        val text = serverPathField.text
        settings.state.serverPath = if (text.isBlank()) null else text
        settings.state.logLevel = logLevelCombo.selectedItem as? String ?: "info"
        settings.state.autoLoadSolution = autoLoadCheck.isSelected
    }

    override fun reset() {
        val current = project.service<SharpLspSettings>().state
        serverPathField.text = current.serverPath ?: ""
        logLevelCombo.selectedItem = current.logLevel
        autoLoadCheck.isSelected = current.autoLoadSolution
    }

    override fun disposeUIResources() {
        panel = null
    }
}
