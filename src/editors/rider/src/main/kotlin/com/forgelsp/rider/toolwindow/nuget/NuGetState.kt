package com.forgelsp.rider.toolwindow.nuget

import com.forgelsp.rider.lsp.InstalledPackage
import com.forgelsp.rider.lsp.NuGetTarget
import com.forgelsp.rider.lsp.PackageInfo

/** Which tab the browser is currently showing. */
internal enum class Tab { BROWSE, INSTALLED }

/**
 * Live state for the NuGet browser. Mutable by design — the panel is
 * the only owner and every mutation runs on the EDT. Methods return the
 * new visible package list so the caller can refresh the JList model
 * without recomputing it themselves.
 */
internal class NuGetState {
    var tab: Tab = Tab.BROWSE
    var target: NuGetTarget? = null
    var allTargets: List<NuGetTarget> = emptyList()
    var searchQuery: String = ""

    private var browseResults: List<PackageInfo> = emptyList()
    private var installed: List<InstalledPackage> = emptyList()

    /** Ids that have an in-flight install/uninstall op. */
    val pending: MutableSet<String> = mutableSetOf()

    fun setBrowse(results: List<PackageInfo>) {
        browseResults = results
    }

    fun setInstalled(list: List<InstalledPackage>) {
        installed = list
    }

    /**
     * Merge installed metadata onto search results so a package that's
     * already installed renders with the "v1.2.3 ✓ installed" pill even
     * when the Browse tab's search response doesn't set `isInstalled`.
     */
    fun visible(): List<DisplayPackage> = when (tab) {
        Tab.BROWSE -> browseResults.map { toDisplay(it) }
        Tab.INSTALLED -> installed
            .sortedBy { it.id.lowercase() }
            .map { pkg ->
                // Enrich from browse results if we have metadata cached.
                val enriched = browseResults.firstOrNull { it.id.equals(pkg.id, ignoreCase = true) }
                if (enriched != null) {
                    toDisplay(enriched.copy(
                        isInstalled = true,
                        installedVersion = pkg.resolvedVersion,
                    ))
                } else {
                    DisplayPackage(
                        info = PackageInfo(
                            id = pkg.id,
                            version = pkg.resolvedVersion,
                            description = "Installed package",
                            isInstalled = true,
                            installedVersion = pkg.resolvedVersion,
                        ),
                        pending = pkg.id in pending,
                    )
                }
            }
    }

    private fun toDisplay(info: PackageInfo): DisplayPackage {
        val isInstalled = info.isInstalled || installed.any { it.id.equals(info.id, ignoreCase = true) }
        val installedVersion = info.installedVersion
            ?: installed.firstOrNull { it.id.equals(info.id, ignoreCase = true) }?.resolvedVersion
        val effective = if (isInstalled && installedVersion != null) {
            info.copy(isInstalled = true, installedVersion = installedVersion)
        } else {
            info
        }
        return DisplayPackage(info = effective, pending = info.id in pending)
    }

    fun isInstalled(packageId: String): Boolean =
        installed.any { it.id.equals(packageId, ignoreCase = true) }

    fun installedVersion(packageId: String): String? =
        installed.firstOrNull { it.id.equals(packageId, ignoreCase = true) }?.resolvedVersion
}

/** View-model row: a PackageInfo plus UI flags the list cell needs. */
internal data class DisplayPackage(
    val info: PackageInfo,
    val pending: Boolean,
)
