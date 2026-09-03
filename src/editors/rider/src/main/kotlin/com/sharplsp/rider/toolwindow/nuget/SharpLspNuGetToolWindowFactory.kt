package com.sharplsp.rider.toolwindow.nuget

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/**
 * Tool window factory for the SharpLsp NuGet Package Browser. Registers a
 * single content panel; all UI lives in [SharpLspNuGetBrowserPanel].
 */
class SharpLspNuGetToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = SharpLspNuGetBrowserPanel(project, initialProjectPath = null)
        val content = ContentFactory.getInstance().createContent(
            panel.component,
            /* displayName = */ "",
            /* isLockable = */ false,
        )
        content.isCloseable = false
        toolWindow.contentManager.addContent(content)
    }
}
