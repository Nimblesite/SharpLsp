package com.sharplsp.rider.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Per-project SharpLsp settings. Persisted in the project's workspace.xml.
 *
 * Fields:
 *  - `serverPath` — override for the `sharplsp` binary location.
 *    Null / blank means auto-detect (~/.local/bin/sharplsp then $PATH).
 *  - `logLevel`  — env var passed as RUST_LOG to sharplsp.
 *  - `autoLoadSolution` — whether to send `sharplsp/loadSolution` on project
 *    open if we can find a single .sln or .slnx in the project root.
 * Implements [RIDER-SETTINGS].
 */
@Service(Service.Level.PROJECT)
@State(
    name = "SharpLspSettings",
    storages = [Storage("sharplsp.xml")],
)
class SharpLspSettings : PersistentStateComponent<SharpLspSettings.State> {
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
