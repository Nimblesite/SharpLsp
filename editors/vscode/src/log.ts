import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { window, type OutputChannel } from "vscode";
import { OUTPUT_CHANNEL_NAME, TRACE_CHANNEL_NAME } from "./constants.js";

let outputChannel: OutputChannel | undefined;
let traceChannel: OutputChannel | undefined;

const LOG_FILE = path.join(os.tmpdir(), "forge-vscode.log");

/** Write a timestamped line to the log file synchronously (never lost on crash). */
function fileLog(level: string, message: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${message}\n`;
    try {
        fs.appendFileSync(LOG_FILE, line);
    } catch {
        /* best-effort: cannot log a logging failure */
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

/** Log an error message to the main output channel + file. */
export function error(message: string): void {
    const ts = new Date().toISOString();
    output().appendLine(`[${ts}] ERROR: ${message}`);
    fileLog("ERROR", message);
}

/** Return the path to the log file for diagnostics. */
export function logFilePath(): string {
    return LOG_FILE;
}

/** Dispose both channels. */
export function dispose(): void {
    outputChannel?.dispose();
    traceChannel?.dispose();
    outputChannel = undefined;
    traceChannel = undefined;
}
