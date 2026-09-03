package com.sharplsp.rider.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/**
 * Factory that builds the SharpLsp Solution tool window the first time the
 * user clicks on it. Registered via the `toolWindow` extension point in
 * `plugin.xml`.
 *
 * The actual tree lives in [SharpLspSolutionToolWindow]; this factory just
 * wraps it in a Content tab so the platform can manage its lifecycle.
 */
class SharpLspSolutionToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val window = SharpLspSolutionToolWindow(project)
        val content = ContentFactory.getInstance()
            .createContent(window.component, "", false)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project): Boolean = true
}
