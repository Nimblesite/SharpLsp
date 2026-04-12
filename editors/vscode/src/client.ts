import { type ExtensionContext, type Disposable } from "vscode";
import {
    type Executable,
    LanguageClient,
    type LanguageClientOptions,
    type ServerOptions,
    TransportKind,
    State,
} from "vscode-languageclient/node";
import { EXTENSION_ID, EXTENSION_NAME } from "./constants.js";
import * as config from "./config.js";
import * as install from "./install.js";
import * as log from "./log.js";
import { type ForgeStatusBar, ServerState } from "./status.js";

/** Create, start, and return a new `LanguageClient`. */
export async function start(
    context: ExtensionContext,
    statusBar: ForgeStatusBar,
): Promise<LanguageClient | undefined> {
    let serverPath: string;
    try {
        const result = await install.ensureBinaries(config.serverPath());
        serverPath = result.serverPath;
    } catch {
        statusBar.setState(ServerState.Error);
        return undefined;
    }

    log.info(`Server binary: ${serverPath}`);

    const run: Executable = {
        command: serverPath,
        args: [...config.serverExtraArgs()],
        transport: TransportKind.stdio,
        options: {
            env: { ...process.env, RUST_LOG: config.loggingLevel() },
        },
    };

    const serverOptions: ServerOptions = { run, debug: run };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: "file", language: "csharp" },
            { scheme: "file", language: "fsharp" },
            { scheme: "untitled", language: "csharp" },
            { scheme: "untitled", language: "fsharp" },
        ],
        outputChannel: log.output(),
        traceOutputChannel: log.trace(),
    };

    const client = new LanguageClient(
        EXTENSION_ID,
        EXTENSION_NAME,
        serverOptions,
        clientOptions,
    );

    wireStatusBar(client, statusBar, context);

    statusBar.setState(ServerState.Starting);
    await client.start();
    return client;
}

/** Wire client state changes to the status bar indicator. */
function wireStatusBar(
    client: LanguageClient,
    statusBar: ForgeStatusBar,
    context: ExtensionContext,
): void {
    const listener: Disposable = client.onDidChangeState((event) => {
        switch (event.newState) {
            case State.Starting:
                statusBar.setState(ServerState.Starting);
                break;
            case State.Running:
                statusBar.setState(ServerState.Running);
                log.info("Server is running.");
                break;
            case State.Stopped:
                statusBar.setState(ServerState.Stopped);
                log.info("Server stopped.");
                break;
        }
    });
    context.subscriptions.push(listener);
}
