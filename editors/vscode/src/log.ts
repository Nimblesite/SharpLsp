import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { window, type OutputChannel } from "vscode";
import { OUTPUT_CHANNEL_NAME, TRACE_CHANNEL_NAME } from "./constants.js";

let outputChannel: OutputChannel | undefined;
let traceChannel: OutputChannel | undefined;

const LOG_FILE = path.join(os.tmpdir(), "forge-vscode.log");
let logStream: fs.WriteStream | undefined;

/** Get or create the file log stream. */
function fileStream(): fs.WriteStream {
    logStream ??= fs.createWriteStream(LOG_FILE, { flags: "a" });
    return logStream;
}

/** Write a timestamped line to the log file. */
function fileLog(level: string, message: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${message}\n`;
    try {
        fileStream().write(line);
    } catch {
        /* best-effort */
    }
}

/** Lazily create and return the main output channel. */
export function output(): OutputChannel {
    outputChannel ??= window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    return outputChannel;
}

/** Lazily create and return the LSP trace channel. */
export function trace(): OutputChannel {
    traceChannel ??= window.createOutputChannel(TRACE_CHANNEL_NAME);
    return traceChannel;
}

/** Log a timestamped message to the main output channel + file. */
export function info(message: string): void {
    const ts = new Date().toISOString();
    output().appendLine(`[${ts}] ${message}`);
    fileLog("INFO", message);
}

/** Log a timestamped message to the trace output channel + file. */
export function traceInfo(message: string): void {
    const ts = new Date().toISOString();
    trace().appendLine(`[${ts}] ${message}`);
    fileLog("TRACE", message);
}

/** Return the path to the log file for diagnostics. */
export function logFilePath(): string {
    return LOG_FILE;
}

/** Dispose both channels and close the file stream. */
export function dispose(): void {
    outputChannel?.dispose();
    traceChannel?.dispose();
    outputChannel = undefined;
    traceChannel = undefined;
    logStream?.end();
    logStream = undefined;
}
