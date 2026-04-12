package com.forgelsp.rider.toolwindow.nuget

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/**
 * Tool window factory for the Forge NuGet Package Browser. Registers a
 * single content panel; all UI lives in [ForgeNuGetBrowserPanel].
 */
class ForgeNuGetToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = ForgeNuGetBrowserPanel(project, initialProjectPath = null)
        val content = ContentFactory.getInstance().createContent(
            panel.component,
            /* displayName = */ "",
            /* isLockable = */ false,
        )
        content.isCloseable = false
        toolWindow.contentManager.addContent(content)
    }
}
