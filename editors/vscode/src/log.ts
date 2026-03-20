import { window, type OutputChannel } from "vscode";
import { OUTPUT_CHANNEL_NAME, TRACE_CHANNEL_NAME } from "./constants.js";

let outputChannel: OutputChannel | undefined;
let traceChannel: OutputChannel | undefined;

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

/** Log a timestamped message to the main output channel. */
export function info(message: string): void {
  const ts = new Date().toISOString();
  output().appendLine(`[${ts}] ${message}`);
}

/** Dispose both channels. */
export function dispose(): void {
  outputChannel?.dispose();
  traceChannel?.dispose();
  outputChannel = undefined;
  traceChannel = undefined;
}
