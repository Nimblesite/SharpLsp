// Capability augmentation for the DAP proxy — pure transforms over DAP
// `initialize` responses and `capabilities` events.
//
// Implements the editor-side half of [DEBUG-PROTOCOL-CAPABILITIES]: VS Code
// builds its debug UI from the advertised flags alone, so every capability this
// module adds is one the router genuinely serves, natively or by emulation.

import { isRecord, type DapMessage } from './dap-emulate';

/**
 * Capabilities the router supplies on top of whatever netcoredbg reports.
 *
 * netcoredbg advertises ten; [DEBUG-PROTOCOL-CAPABILITIES] marks more "Yes"
 * for Phase Four. The first four are served by forwarding or translation
 * (`evaluate`/`disassemble` verbatim; `setExceptionBreakpoints` rewritten into
 * the `filterOptions[].condition` netcoredbg implements; `variables` untouched
 * with netcoredbg's real `Variable.type` values; `output` escapes intact).
 * The rest are EMULATED ([DEBUG-ADAPTER-GAPS]: netcoredbg answers `restart`
 * and `goto` with E_NOTIMPL and ignores `hitCondition`/`logMessage` outright):
 * restart respawns + replays the handshake; hit counts auto-continue until the
 * condition passes; logpoints evaluate + emit `output`, never pausing;
 * run-to-cursor uses a temporary adapter-side breakpoint.
 */
export const ROUTER_CAPABILITIES: Readonly<Record<string, boolean>> = {
  supportsEvaluateForHovers: true,
  supportsExceptionOptions: true,
  supportsVariableType: true,
  supportsANSIStyling: true,
  supportsRestartRequest: true,
  supportsHitConditionalBreakpoints: true,
  supportsLogPoints: true,
  supportsGotoTargetsRequest: true,
  supportsDisassembleRequest: true,
};

/** Merge the router's own capabilities into an `initialize` response body. */
export function withRouterCapabilities(
  message: DapMessage,
  childCaps: Record<string, unknown>,
): DapMessage {
  const body: unknown = message.body;
  const existing = isRecord(body) ? body : {};
  return { ...message, body: { ...childCaps, ...existing, ...ROUTER_CAPABILITIES } };
}

/**
 * Merge the router's capabilities into a `capabilities` EVENT.
 *
 * The event nests the flags one level deeper than the `initialize` response
 * does — `body.capabilities` rather than `body` — so it needs its own merge
 * rather than reusing the response one.
 */
export function withEventCapabilities(message: DapMessage): DapMessage {
  const body: unknown = message.body;
  const outer = isRecord(body) ? body : {};
  const advertised: unknown = outer.capabilities;
  const inner = isRecord(advertised) ? advertised : {};
  const capabilities = { ...inner, ...ROUTER_CAPABILITIES };
  return { ...message, body: { ...outer, capabilities } };
}

/**
 * netcoredbg -> VS Code, with the router's capability enrichment applied.
 *
 * Only the `initialize` response carries the merge; every other message is
 * returned untouched, so the router can pipe everything through one call.
 */
export function enrichResponse(
  message: DapMessage,
  childCaps: Record<string, unknown>,
): DapMessage {
  if (message.type !== 'response') return message;
  if (message.command === 'initialize') {
    return withRouterCapabilities(message, childCaps);
  }
  return message;
}
