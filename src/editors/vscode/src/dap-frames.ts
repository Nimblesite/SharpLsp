// Async call-stack reconstruction, as a pure transform over DAP `stackTrace`
// frames.
//
// Implements the naming half of [DEBUG-FEATURES-STACK-ASYNC]: "netcoredbg
// reports physical `MoveNext` frames. `DapRouter` and the C# sidecar
// reconstruct the logical chain." Step 1 of that algorithm is "find types
// matching `<MethodName>d__N`" — and the compiler-generated type name already
// carries the logical method name, so the chain can be recovered from the frame
// names alone, without reading `<>1__state` through ICorDebug.
//
// What this module CANNOT do is follow `_continuation` across a suspension
// point; frames that are parked in a continuation are not on the physical
// stack at all. Per the spec's own fallback rule — "If compiler-generated
// fields cannot be resolved, the response retains the physical stack
// unchanged" — anything not recognised here is passed through untouched.
//
// Deliberately free of `vscode` imports so the transform is exercisable
// directly against captured netcoredbg output.

/** The compiler's marker for an async state machine type: `<Method>d__N`. */
const STATE_MACHINE_SUFFIX = 'd__';

/** The single method every async state machine implements. */
const MOVE_NEXT = 'MoveNext';

/** One DAP stack frame, narrowed to the fields this transform reads. */
export interface RawFrame {
  readonly id: number;
  readonly name: string;
  readonly line: number;
  readonly source?: { readonly path?: string; readonly name?: string };
  readonly [key: string]: unknown;
}

/**
 * Split a frame name into its dotted segments, treating `<...>` and `<...>`-
 * style generic argument lists as opaque.
 *
 * A regex cannot do this correctly: generic arguments nest and themselves
 * contain dots (`Builder.Start<Ns.Type.<M>d__1>()`), so a naive split on `.`
 * shatters the type argument. This walks the string once and only splits at
 * depth zero, which is what an actual parse of the name requires.
 */
export function splitQualifiedName(name: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < name.length; index += 1) {
    const character = name[index];
    if (character === '<') depth += 1;
    else if (character === '>') depth -= 1;
    else if (character === '.' && depth === 0) {
      segments.push(name.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(name.slice(start));
  return segments;
}

/** Strip a trailing `(...)` argument list from one name segment. */
function withoutArguments(segment: string): string {
  const open = segment.indexOf('(');
  return open < 0 ? segment : segment.slice(0, open);
}

/**
 * The logical method name a C# state-machine type segment stands for.
 *
 * `<MiddleAsync>d__1` yields `MiddleAsync`. The leading `<` and the `>d__`
 * marker are both required: a plain generic type such as `List<int>` must not
 * be mistaken for a state machine.
 */
function csharpStateMachine(segment: string): string | undefined {
  if (!segment.startsWith('<')) return undefined;
  const close = segment.indexOf('>');
  if (close <= 1) return undefined;
  if (!segment.slice(close + 1).startsWith(STATE_MACHINE_SUFFIX)) return undefined;
  return segment.slice(1, close);
}

/** True when every character is an ASCII digit, and there is at least one. */
function isDigits(text: string): boolean {
  if (text.length === 0) return false;
  for (const character of text) {
    if (character < '0' || character > '9') return false;
  }
  return true;
}

/**
 * The logical method name an F# state-machine type segment stands for.
 *
 * F# does NOT use C#'s `<name>d__N`. `task { }` and `async { }` compile to a
 * type named after the function and the line it starts on — `leafAsync@4`, and
 * `leafAsync@4-2` where one function yields several. Recognising only the C#
 * spelling left every F# async stack unenriched, which
 * [DEBUG-FSHARP-STEPPING] and this project's "F# is a first class citizen"
 * rule both forbid.
 *
 * The digit test is what keeps a legitimate name containing `@` from being
 * mistaken for a state machine.
 */
function fsharpStateMachine(segment: string): string | undefined {
  const at = segment.lastIndexOf('@');
  if (at <= 0) return undefined;
  const suffix = segment.slice(at + 1);
  const dash = suffix.indexOf('-');
  const line = dash < 0 ? suffix : suffix.slice(0, dash);
  const ordinal = dash < 0 ? '' : suffix.slice(dash + 1);
  if (!isDigits(line)) return undefined;
  if (dash >= 0 && !isDigits(ordinal)) return undefined;
  return segment.slice(0, at);
}

/**
 * The logical method name a state-machine type segment stands for, or
 * undefined when the segment is not one. Handles both languages' spellings.
 */
export function stateMachineMethod(segment: string): string | undefined {
  return csharpStateMachine(segment) ?? fsharpStateMachine(segment);
}

/**
 * Rewrite `Ns.Type.<Method>d__N.MoveNext()` to `Ns.Type.Method()`.
 *
 * Returns the name unchanged when it is not an async state-machine frame, so
 * the caller can use the identity of the result to detect a no-op.
 */
export function logicalFrameName(name: string): string {
  const segments = splitQualifiedName(name);
  const last = segments[segments.length - 1];
  if (last === undefined || withoutArguments(last) !== MOVE_NEXT) return name;
  const owner = segments[segments.length - 2];
  if (owner === undefined) return name;
  const method = stateMachineMethod(owner);
  if (method === undefined) return name;
  const prefix = segments.slice(0, -2);
  return [...prefix, `${method}()`].join('.');
}

/** Root namespaces that are never the user's own code. */
const RUNTIME_ROOTS: readonly string[] = ['System', 'Microsoft', 'Internal', 'MS'];

/**
 * True when the frame is runtime plumbing the user never wrote.
 *
 * Matching builder method names does not survive contact with reality: resuming
 * after an await goes through `AsyncStateMachineBox.MoveNext`,
 * `ExecutionContextCallback`, `ExecuteFromThreadPool`,
 * `ThreadPoolWorkQueue.Dispatch` and `WorkerThread.WorkerThreadStart`, and the
 * set differs again between C# and F#. The durable rule is structural: a frame
 * rooted in a runtime namespace that carries NO source location cannot be
 * user code, whatever it happens to be called.
 */
export function isAsyncPlumbing(frame: RawFrame): boolean {
  if (!isSourceless(frame)) return false;
  const root = splitQualifiedName(frame.name)[0] ?? '';
  return RUNTIME_ROOTS.includes(root);
}

/** True when the frame carries no source location the user can navigate to. */
function isSourceless(frame: RawFrame): boolean {
  return frame.source?.path === undefined && frame.source?.name === undefined;
}

/**
 * Drop the sourceless logical stub netcoredbg emits next to each `MoveNext`
 * frame.
 *
 * netcoredbg reports BOTH `<Middle>d__1.MoveNext()` (with a real line) and a
 * bare `Middle()` (line 0, no source). Once the MoveNext frame is renamed to
 * `Middle()` the pair reads as the same method twice, and the stub is the copy
 * without a source location — so the user would see a duplicate frame that
 * navigates nowhere.
 */
function isRedundantStub(frame: RawFrame, renamed: ReadonlySet<string>): boolean {
  return isSourceless(frame) && renamed.has(withoutArguments(frame.name));
}

/**
 * Reconstruct the logical async chain for one `stackTrace` response.
 *
 * `justMyCode` controls only the plumbing frames: with it off the builder
 * frames are kept, because a user who deliberately turned Just My Code off is
 * asking to see the runtime's own frames.
 */
export function enrichAsyncFrames(frames: readonly RawFrame[], justMyCode: boolean): RawFrame[] {
  const renamed = new Set<string>();
  const named = frames.map((frame) => {
    const name = logicalFrameName(frame.name);
    if (name !== frame.name) renamed.add(withoutArguments(name));
    return name === frame.name ? frame : { ...frame, name };
  });
  return named.filter(
    (frame) => !isRedundantStub(frame, renamed) && !(justMyCode && isAsyncPlumbing(frame)),
  );
}
