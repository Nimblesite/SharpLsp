// The heap half of async call-stack reconstruction: recovering the AWAITING
// frames that are not on any thread's physical stack.
//
// Implements steps 2-5 of [DEBUG-FEATURES-STACK-ASYNC]: resolve each state
// machine, read its builder, follow the continuation chain, and hand the
// logical frames to `dap-stack.ts` for injection. The spec's Phase Four route
// is the debugger's own data surface: netcoredbg exposes no `this` on a
// `MoveNext` frame, but it CAN set `Task.s_asyncDebuggingEnabled` through
// `setExpression` — the same switch Visual Studio's debugger flips — after
// which every suspended async method's builder box registers itself in
// `Task.s_currentActiveTasks`. Walking that dictionary and each box's
// `m_continuationObject` IS the continuation traversal, performed through DAP
// `evaluate`/`variables` instead of `ICorDebugObjectValue::GetFieldValue`.
//
// Everything here is bounded and fail-open: any refused request, missing
// field, ambiguous edge or exhausted budget abandons the walk, and the caller
// falls back to the physical stack — "If compiler-generated fields cannot be
// resolved, the response retains the physical stack unchanged".
//
// Deliberately free of `vscode` imports so the walk is exercisable directly
// against a live adapter.
import { isRecord, recordList, type DapMessage } from './dap-emulate';
import { splitQualifiedName, stateMachineMethod } from './dap-frames';

/** The internal static the runtime keys async-debugging support on. */
const DEBUG_FLAG = 'System.Threading.Tasks.Task.s_asyncDebuggingEnabled';

/** The registry of suspended async method builders, once the flag is set. */
const ACTIVE_TASKS = 'System.Threading.Tasks.Task.s_currentActiveTasks';

/** The runtime type wrapping every suspended state machine. */
const BOX_MARKER = 'AsyncStateMachineBox<';

/** Dictionary slots examined before the walk gives up. */
const MAX_SLOTS = 32;

/** Continuation hops followed before the walk gives up. */
const MAX_HOPS = 32;

/** `variables` entries examined when searching one object graph. */
const MAX_DIG = 48;

/** What the chain walker needs from its owning router. */
export interface ChainHost {
  /** Request in the router's own name and await the response. */
  request(command: string, args: Record<string, unknown>): Promise<DapMessage>;
}

/** One evaluated expression, narrowed to what the walk reads. */
interface Evaluated {
  readonly result: string;
  readonly type: string;
  readonly ref: number;
}

/** One suspended async activation found in the active-task registry. */
interface TaskNode {
  /** The state machine's runtime type, as netcoredbg renders it. */
  readonly smType: string;
  /** `variablesReference` of the state machine object — its hoisted locals. */
  readonly smRef: number;
  /** `variablesReference` of the whole registry box (`AsyncStateMachineBox`). */
  readonly boxRef: number;
  /** The logical method name, when the type name yields one. */
  readonly method: string | undefined;
  /** The qualified prefix in front of the method (`Ns.Type`). */
  readonly prefix: string;
  /** The continuation's runtime type, or undefined while unhooked. */
  readonly contType: string | undefined;
  readonly contRef: number;
  used: boolean;
}

/** One awaiting caller recovered from the heap. */
export interface AwaitingFrame {
  /** Rendered frame name, `Ns.Type.Method()`. */
  readonly name: string;
  /** The bare method name, for source resolution and dedup. */
  readonly method: string;
  /** The state machine object's `variablesReference`; 0 when unknown. */
  readonly localsRef: number;
}

/** The recovered chain, innermost awaiter first. */
export interface AsyncChain {
  readonly frames: AwaitingFrame[];
  /** True when the chain ended at a sink (a blocked waiter, not a cut). */
  readonly complete: boolean;
}

/** Evaluate one watch expression, or undefined when the adapter refuses. */
async function evaluate(
  host: ChainHost,
  frameId: number,
  expression: string,
): Promise<Evaluated | undefined> {
  const response = await host.request('evaluate', { expression, frameId, context: 'watch' });
  if (response.success === false) return undefined;
  const body = isRecord(response.body) ? response.body : {};
  if (typeof body.result !== 'string') return undefined;
  return {
    result: body.result,
    type: typeof body.type === 'string' ? body.type : '',
    ref: Number(body.variablesReference ?? 0),
  };
}

/** A rendered string field of one variables entry, or ''. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The children of one `variablesReference`, or [] when expansion fails. */
async function expand(host: ChainHost, ref: number): Promise<Record<string, unknown>[]> {
  if (ref <= 0) return [];
  const response = await host.request('variables', { variablesReference: ref });
  if (response.success === false) return [];
  return recordList(isRecord(response.body) ? response.body.variables : undefined);
}

/** The id of a thread's innermost frame, or 0 when it cannot be read. */
export async function topFrameId(host: ChainHost, threadId: number): Promise<number> {
  const stack = await host.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
  const body = isRecord(stack.body) ? stack.body : {};
  return Number(recordList(body.stackFrames)[0]?.id ?? 0);
}

/**
 * Enable the runtime's async-task registry.
 *
 * Must run while the debuggee is paused and BEFORE the awaits under
 * inspection are reached — `dap-stack.ts` arms it at the entry stop.
 */
export async function armAsyncDebugging(host: ChainHost, frameId: number): Promise<boolean> {
  const response = await host.request('setExpression', {
    expression: DEBUG_FLAG,
    value: 'true',
    frameId,
  });
  return response.success !== false;
}

/** Strip the `{...}` netcoredbg wraps object values in. */
function unbrace(rendered: string): string {
  const trimmed = rendered.trim();
  return trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed.slice(1, -1) : trimmed;
}

/** The state-machine type inside a box rendering, via bracket matching. */
function boxStateMachineType(rendered: string): string | undefined {
  const start = rendered.indexOf(BOX_MARKER);
  if (start < 0) return undefined;
  let depth = 1;
  for (let index = start + BOX_MARKER.length; index < rendered.length; index += 1) {
    const character = rendered[index];
    if (character === '<') depth += 1;
    else if (character === '>') {
      depth -= 1;
      if (depth === 0) return rendered.slice(start + BOX_MARKER.length, index);
    }
  }
  return undefined;
}

/** Parse `Ns.Type.<M>d__N` / `Ns.method@L` into method and prefix. */
function parseMachineType(smType: string): { method: string | undefined; prefix: string } {
  const segments = splitQualifiedName(smType);
  const last = segments[segments.length - 1] ?? '';
  return {
    method: stateMachineMethod(last),
    prefix: segments.slice(0, -1).join('.'),
  };
}

/** Read one dictionary slot into a node; null slot yields undefined. */
async function readSlot(
  host: ChainHost,
  frameId: number,
  slot: number,
): Promise<TaskNode | 'end' | undefined> {
  const entry = `${ACTIVE_TASKS}._entries[${String(slot)}]`;
  const key = await evaluate(host, frameId, `${entry}.key`);
  if (key === undefined) return 'end';
  const value = await evaluate(host, frameId, `${entry}.value`);
  if (value === undefined || value.result === 'null') return undefined;
  const machine = await evaluate(host, frameId, `${entry}.value.StateMachine`);
  if (machine === undefined) return undefined;
  const cont = await evaluate(host, frameId, `${entry}.value.m_continuationObject`);
  return nodeFrom(machine, cont, value.ref);
}

/** Assemble one node from its evaluated state machine and continuation. */
function nodeFrom(machine: Evaluated, cont: Evaluated | undefined, boxRef = 0): TaskNode {
  const smType = machine.type !== '' ? machine.type : unbrace(machine.result);
  const { method, prefix } = parseMachineType(smType);
  return {
    smType,
    smRef: machine.ref,
    boxRef,
    method,
    prefix,
    contType: cont === undefined || cont.result === 'null' ? undefined : unbrace(cont.result),
    contRef: cont?.ref ?? 0,
    used: false,
  };
}

/** All registered suspended activations, in dictionary slot order. */
async function readNodes(host: ChainHost, frameId: number): Promise<TaskNode[]> {
  const registry = await evaluate(host, frameId, ACTIVE_TASKS);
  if (registry === undefined || registry.result === 'null') {
    return [];
  }
  const nodes: TaskNode[] = [];
  for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
    const node = await readSlot(host, frameId, slot);
    if (node === 'end') break;
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}

/**
 * Name an F# dynamic-mode state machine by searching its object graph.
 *
 * The compiler's dynamic fallback types every `task {}` as the same generic
 * `ResumableStateMachine<...>`; the function's identity lives in the
 * resumption closures it references (`rootTask@46-2`). A bounded breadth-first
 * expansion of the machine's fields finds the first value or type whose name
 * parses as an F# closure, which names the method.
 */
async function digDynamicName(
  host: ChainHost,
  node: TaskNode,
): Promise<{ method: string; prefix: string } | undefined> {
  const queue: number[] = [node.smRef];
  let spent = 0;
  while (queue.length > 0 && spent < MAX_DIG) {
    const children = await expand(host, queue.shift() ?? 0);
    for (const child of children) {
      spent += 1;
      const rendered = [textOf(child.type), unbrace(textOf(child.value))];
      for (const candidate of rendered) {
        const parsed = parseMachineType(candidate);
        if (parsed.method !== undefined) return { method: parsed.method, prefix: parsed.prefix };
      }
      enqueueChild(queue, child);
    }
  }
  return undefined;
}

/**
 * Queue one child for expansion, resumption machinery first.
 *
 * The dynamic-mode closure hides behind `ResumptionDynamicInfo.ResumptionFunc`
 * (a delegate whose `_target` is the closure), so those names jump the queue;
 * everything else still gets searched within the budget.
 */
function enqueueChild(queue: number[], child: Record<string, unknown>): void {
  const ref = Number(child.variablesReference ?? 0);
  if (ref <= 0) return;
  const name = textOf(child.name);
  if (/resumption|_target|func/i.test(name)) queue.unshift(ref);
  else queue.push(ref);
}

/** Resolve a node's method name, digging when the type alone cannot name it. */
async function nameNode(host: ChainHost, node: TaskNode): Promise<TaskNode> {
  if (node.method !== undefined) return node;
  const dug = await digDynamicName(host, node);
  if (dug === undefined) return node;
  return { ...node, method: dug.method, prefix: dug.prefix };
}

/** The single unused node matching a state-machine type, or undefined. */
function soleMatch(nodes: readonly TaskNode[], smType: string): TaskNode | undefined {
  const matches = nodes.filter((node) => !node.used && node.smType === smType);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Render one node as the frame the Call Stack panel will show. */
function frameOf(method: string, prefix: string, localsRef: number): AwaitingFrame {
  const name = prefix === '' ? `${method}()` : `${prefix}.${method}()`;
  return { name, method, localsRef };
}

/** Follow one continuation edge; 'sink' ends the chain, undefined cuts it. */
async function nextHop(
  host: ChainHost,
  nodes: readonly TaskNode[],
  current: TaskNode,
): Promise<TaskNode | AwaitingFrame | 'sink' | undefined> {
  if (current.contType === undefined) return undefined;
  const byBoxRef = new Map(
    nodes
      .filter((node) => node !== current && node.boxRef > 0)
      .map((node) => [node.boxRef, node.smType]),
  );
  const inner =
    (current.contRef > 0 ? byBoxRef.get(current.contRef) : undefined) ??
    boxStateMachineType(current.contType) ??
    (await digBoxedContinuation(host, current.contRef, current.smType, byBoxRef));
  if (inner === undefined) return 'sink';
  const node = soleMatch(nodes, inner);
  if (node !== undefined) return node;
  const { method, prefix } = parseMachineType(inner);
  return method === undefined ? 'sink' : frameOf(method, prefix, 0);
}

/** Search a wrapped continuation (context callbacks etc.) for its box. */
async function digBoxedContinuation(
  host: ChainHost,
  ref: number,
  currentMachineType?: string,
  byBoxRef: ReadonlyMap<number, string> = new Map(),
): Promise<string | undefined> {
  const visited = new Set<number>();
  const direct = byBoxRef.get(ref);
  if (direct !== undefined) return direct;
  let spent = 0;

  /** Descend through delegate/wrapper fields; junk (reflection objects,
   * IntPtrs) is never expanded, so the budget goes to the wrapper chain. */
  const descend = async (candidate: number, depth: number): Promise<string | undefined> => {
    if (depth > 8 || candidate <= 0 || visited.has(candidate)) return undefined;
    visited.add(candidate);
    for (const child of await expand(host, candidate)) {
      spent += 1;
      if (spent > MAX_DIG) return undefined;
      // `ContinuationWrapper._innerTask` names the task being AWAITED — the
      // caller's own box — not the awaiter. Matching it yields the machine we
      // are walking FROM (a self-loop that cuts the chain); the awaiter lives
      // in `_continuation`.
      const name = textOf(child.name);
      const childRef = Number(child.variablesReference ?? 0);
      if (/innerTask/i.test(name)) continue;
      const referred = childRef > 0 ? byBoxRef.get(childRef) : undefined;
      if (referred !== undefined) return referred;
      const rendered = [textOf(child.type), unbrace(textOf(child.value))];
      for (const text of rendered) {
        const inner = boxStateMachineType(text);
        if (inner !== undefined && inner !== currentMachineType) return inner;
      }
      // Wrapper and delegate fields carry the chain onward; anything else is
      // a dead end.
      const wrapperish = rendered.some((text) => /action|func|delegate|continuation/i.test(text));
      if (wrapperish && childRef > 0) {
        const found = await descend(childRef, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  return await descend(ref, 0);
}

/** The registered activation the paused frame is executing, if any. */
function startNode(
  nodes: readonly TaskNode[],
  pausedSmType: string | undefined,
  pausedMethod: string | undefined,
): TaskNode | undefined {
  const byType = nodes.find((node) => node.smType === pausedSmType);
  if (byType !== undefined) return byType;
  return nodes.find((node) => node.method !== undefined && node.method === pausedMethod);
}

/**
 * Recover the awaiting callers of the paused async method.
 *
 * Returns undefined when the registry is unavailable (arming failed, older
 * runtime, evaluation refused) so the caller can fall back cleanly.
 */
export async function readAsyncChain(
  host: ChainHost,
  frameId: number,
  pausedSmType: string | undefined,
  pausedMethod: string | undefined,
): Promise<AsyncChain | undefined> {
  const nodes: TaskNode[] = [];
  for (const node of await readNodes(host, frameId)) {
    nodes.push(await nameNode(host, node));
  }
  const start = startNode(nodes, pausedSmType, pausedMethod);
  if (start === undefined) return undefined;
  start.used = true;
  return await followChain(host, nodes, start);
}

/** Walk the continuation edges from the paused activation outward. */
async function followChain(
  host: ChainHost,
  nodes: readonly TaskNode[],
  start: TaskNode,
): Promise<AsyncChain> {
  const frames: AwaitingFrame[] = [];
  let current = start;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const next = await nextHop(host, nodes, current);
    if (next === undefined) return { frames, complete: false };
    if (next === 'sink') return { frames, complete: true };
    if (!isNode(next)) {
      frames.push(next);
      return { frames, complete: true };
    }
    next.used = true;
    if (next.method !== undefined) frames.push(frameOf(next.method, next.prefix, next.smRef));
    current = next;
  }
  return { frames, complete: true };
}

/** Distinguish a registry node from a name-only frame. */
function isNode(value: TaskNode | AwaitingFrame): value is TaskNode {
  return 'smType' in value;
}
