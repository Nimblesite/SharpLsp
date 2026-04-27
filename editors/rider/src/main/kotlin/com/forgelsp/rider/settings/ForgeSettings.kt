package com.forgelsp.rider.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Per-project Forge settings. Persisted in the project's workspace.xml.
 *
 * Fields:
 *  - `serverPath` — override for the `forge-lsp` binary location.
 *    Null / blank means auto-detect (~/.local/bin/forge-lsp then $PATH).
 *  - `logLevel`  — env var passed as RUST_LOG to forge-lsp.
 *  - `autoLoadSolution` — whether to send `forge/loadSolution` on project
 *    open if we can find a single .sln or .slnx in the project root.
 */
@Service(Service.Level.PROJECT)
@State(
    name = "ForgeSettings",
    storages = [Storage("forge.xml")],
)
class ForgeSettings : PersistentStateComponent<ForgeSettings.State> {
    data class State(
        var serverPath: String? = null,
        var logLevel: String = "info",
        var autoLoadSolution: Boolean = true,
    )

    private var internalState = State()

    override fun getState(): State = internalState

    override fun loadState(state: State) {
        internalState = state
    }
}
