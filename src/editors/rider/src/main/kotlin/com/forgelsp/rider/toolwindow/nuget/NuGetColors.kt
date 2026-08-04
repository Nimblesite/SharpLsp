package com.forgelsp.rider.toolwindow.nuget

import com.intellij.ui.JBColor
import java.awt.Color

/**
 * Palette for the NuGet browser UI. Pulled directly from the VS Code
 * extension's webview CSS so the Rider panel matches visually. These
 * are fixed colors — the VS Code browser is always dark, so we don't
 * flip in light mode. [JBColor] is only used to expose them as IDE-
 * friendly constants; both branches of the [JBColor] pair are the
 * same fixed value.
 */
internal object NuGetColors {
    // Backgrounds
    val HEADER_BG = fixed(0x131313)
    val PANEL_BG = fixed(0x1B1B1C)
    val CARD_HOVER_BG = fixed(0x1B1B1C)
    val CARD_SELECTED_BG = fixed(0x1B1B1C)
    val PILL_BG = fixed(0x2A2A2A)
    val ICON_BOX_BG = fixed(0x202020)

    // Foregrounds
    val FG_PRIMARY = fixed(0xE5E2E1)
    val FG_SECONDARY = fixed(0xC0C7D3)
    val FG_MUTED = fixed(0x7A8290)

    // Accents
    val ACCENT = fixed(0x9FCAFF)
    val ACCENT_STRONG = fixed(0x007ACC)
    val DANGER = fixed(0xFFB4AB)

    val BORDER_LIGHT = fixed(0x404751)

    // Installed pill background: rgba(159,202,255,0.18) → premultiplied on PANEL_BG
    val PILL_INSTALLED_BG = fixed(0x253847)
    val PILL_INSTALLED_FG = ACCENT

    private fun fixed(rgb: Int): JBColor = JBColor(Color(rgb), Color(rgb))
}
