package com.forgelsp.rider.toolwindow.nuget

import com.forgelsp.rider.lsp.InstalledPackage
import com.forgelsp.rider.lsp.PackageInfo
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * `NuGetState` decides what the browser renders. It is the only part of the
 * Rider plugin with branching logic that does not need a running IDE, and the
 * merge it performs is not obvious: a search response does not know what is
 * installed, so the state has to enrich it — case-insensitively, because NuGet
 * ids are not case-sensitive but the two responses do not agree on casing.
 */
class NuGetStateTest {
    private fun info(id: String, version: String) =
        PackageInfo(id = id, version = version, description = "desc for $id")

    private fun installed(id: String, resolved: String) =
        InstalledPackage(id = id, requestedVersion = resolved, resolvedVersion = resolved)

    /**
     * The Browse response carries `isInstalled = false` for everything. If the
     * state did not merge, an already-installed package would offer "Install"
     * again.
     */
    @Test
    fun `browse marks a package installed from the installed list`() {
        val state = NuGetState()
        state.setBrowse(listOf(info("Serilog", "4.2.0"), info("Newtonsoft.Json", "13.0.3")))
        state.setInstalled(listOf(installed("Serilog", "4.1.0")))

        val visible = state.visible()

        assertEquals(2, visible.size)
        val serilog = visible.first { it.info.id == "Serilog" }
        assertTrue(serilog.info.isInstalled, "Serilog is installed and must render as such")
        assertEquals("4.1.0", serilog.info.installedVersion)

        val newtonsoft = visible.first { it.info.id == "Newtonsoft.Json" }
        assertFalse(newtonsoft.info.isInstalled)
        assertNull(newtonsoft.info.installedVersion)
    }

    /** NuGet ids are case-insensitive; the two responses need not agree. */
    @Test
    fun `browse matches the installed list ignoring case`() {
        val state = NuGetState()
        state.setBrowse(listOf(info("Serilog", "4.2.0")))
        state.setInstalled(listOf(installed("serilog", "4.1.0")))

        val serilog = state.visible().single()

        assertTrue(serilog.info.isInstalled, "casing must not decide installed-ness")
        assertEquals("4.1.0", serilog.info.installedVersion)
    }

    /** The Installed tab is a list the user scans, so ordering is part of it. */
    @Test
    fun `installed tab sorts by id ignoring case`() {
        val state = NuGetState()
        state.tab = Tab.INSTALLED
        state.setInstalled(
            listOf(
                installed("zzTop", "1.0.0"),
                installed("Alpha", "2.0.0"),
                installed("beta", "3.0.0"),
            ),
        )

        val ids = state.visible().map { it.info.id }

        assertEquals(listOf("Alpha", "beta", "zzTop"), ids)
    }

    /**
     * When the Browse tab has already fetched metadata, the Installed tab
     * reuses it rather than showing the placeholder description.
     */
    @Test
    fun `installed tab reuses cached browse metadata`() {
        val state = NuGetState()
        state.tab = Tab.INSTALLED
        state.setBrowse(listOf(info("Serilog", "4.2.0")))
        state.setInstalled(listOf(installed("Serilog", "4.1.0")))

        val serilog = state.visible().single()

        assertEquals("desc for Serilog", serilog.info.description)
        assertTrue(serilog.info.isInstalled)
        assertEquals("4.1.0", serilog.info.installedVersion, "the resolved version wins")
    }

    /** With no cached metadata there is still a row, built from what is known. */
    @Test
    fun `installed tab synthesises a row without cached metadata`() {
        val state = NuGetState()
        state.tab = Tab.INSTALLED
        state.setInstalled(listOf(installed("Serilog", "4.1.0")))

        val serilog = state.visible().single()

        assertEquals("Serilog", serilog.info.id)
        assertEquals("4.1.0", serilog.info.version)
        assertTrue(serilog.info.isInstalled)
        assertEquals("Installed package", serilog.info.description)
    }

    /** A row with an in-flight operation must render its spinner in both tabs. */
    @Test
    fun `a pending package is flagged in both tabs`() {
        val state = NuGetState()
        state.setBrowse(listOf(info("Serilog", "4.2.0")))
        state.setInstalled(listOf(installed("Serilog", "4.1.0")))
        state.pending += "Serilog"

        assertTrue(state.visible().single().pending, "browse tab")

        state.tab = Tab.INSTALLED
        assertTrue(state.visible().single().pending, "installed tab")
    }

    @Test
    fun `installed lookups ignore case and miss cleanly`() {
        val state = NuGetState()
        state.setInstalled(listOf(installed("Serilog", "4.1.0")))

        assertTrue(state.isInstalled("SERILOG"))
        assertEquals("4.1.0", state.installedVersion("serilog"))

        assertFalse(state.isInstalled("Newtonsoft.Json"))
        assertNull(state.installedVersion("Newtonsoft.Json"))
    }

    /** A fresh browser has nothing to show and must not throw doing so. */
    @Test
    fun `an empty state renders nothing in either tab`() {
        val state = NuGetState()

        assertTrue(state.visible().isEmpty(), "browse tab")

        state.tab = Tab.INSTALLED
        assertTrue(state.visible().isEmpty(), "installed tab")
    }
}
