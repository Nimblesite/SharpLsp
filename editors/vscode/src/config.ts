import { workspace } from "vscode";
import {
    CONFIG_SECTION,
    CONFIG_SERVER_PATH,
    CONFIG_SERVER_EXTRA_ARGS,
    CONFIG_LOGGING_LEVEL,
} from "./constants.js";

function section(): ReturnType<typeof workspace.getConfiguration> {
    return workspace.getConfiguration(CONFIG_SECTION);
}

/** User-configured path to the forge-lsp binary, or empty string. */
export function serverPath(): string {
    return section().get<string>(CONFIG_SERVER_PATH) ?? "";
}

/** Extra CLI arguments to pass to the server process. */
export function serverExtraArgs(): readonly string[] {
    return section().get<string[]>(CONFIG_SERVER_EXTRA_ARGS) ?? [];
}

/** Logging level forwarded to the server as `RUST_LOG`. */
export function loggingLevel(): string {
    return section().get<string>(CONFIG_LOGGING_LEVEL) ?? "info";
}
