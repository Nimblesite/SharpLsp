// Async call-stack reconstruction, as a pure transform over DAP `stackTrace`
// frames.
//
// Implements the naming half of [DEBUG-FEATURES-STACK-ASYNC]: "netcoredbg
// reports physical `MoveNext` frames. `DapRouter` and the C# sidecar
// reconstruct the logical chain." Step 1 of that algorithm is "find types
// matching `<MethodName>d__N`" — and the compiler-generated type name already
// carries the logical method name, so the physical half of the chain can be
// recovered from the frame names alone. The frames that are NOT physical —
// awaiting callers parked in heap continuations — are recovered separately by
// `dap-async-chain.ts` and spliced in by `dap-stack.ts`.
//
// Per the spec's own fallback rule — "If compiler-generated fields cannot be
// resolved, the response retains the physical stack unchanged" — anything not
// recognised here is passed through untouched.
//
// Deliberately free of `vscode` imports so the transform is exercisable
// directly against captured netcoredbg output; the editor-aware "is this path
// the user's code" judgement is injected as a predicate.

/** The compiler's marker for a C# async state machine type: `<Method>d__N`. */
const STATE_MACHINE_SUFFIX = 'd__';

/** The single method every async state machine implements. */
const MOVE_NEXT = 'MoveNext';

/** The method F# dynamic-mode resumption closures implement. */
const INVOKE = 'Invoke';

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
export function withoutArguments(segment: string): string {
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
 * F# does NOT use C#'s `<name>d__N`. A `task { }` state machine — and, in the
 * compiler's dynamic fallback, each resumption closure — is a type named after
 * the function and the line it starts on: `leafTask@40`, with `leafTask@42-3`
 * where one function yields several types. Recognising only the C# spelling
 * left every F# async stack unenriched, which [DEBUG-FSHARP-STEPPING] and this
 * project's "F# is a first class citizen" rule both forbid.
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

/** How one frame name was recognised, if it was. */
interface RecognisedFrame {
  /** The rewritten logical name. */
  readonly name: string;
  /** True for an F# dynamic-mode resumption closure (`...@L-N.Invoke()`). */
  readonly viaInvoke: boolean;
}

/**
 * Recognise `Ns.Type.<Method>d__N.MoveNext()`, `Ns.method@L.MoveNext()` and
 * the F# dynamic-mode `Ns.method@L-N.Invoke()`, yielding `Ns.Type.Method()`.
 *
 * `Invoke` is only accepted on an F#-shaped owner: a C# lambda display class
 * (`<>c.<Main>b__0_0`) also implements `Invoke` but is not an async frame.
 */
function recogniseFrame(name: string): RecognisedFrame | undefined {
  const segments = splitQualifiedName(name);
  const last = segments[segments.length - 1];
  const owner = segments[segments.length - 2];
  if (last === undefined || owner === undefined) return undefined;
  const tail = withoutArguments(last);
  const method =
    tail === MOVE_NEXT
      ? stateMachineMethod(owner)
      : tail === INVOKE
        ? fsharpStateMachine(owner)
        : undefined;
  if (method === undefined) return undefined;
  const prefix = segments.slice(0, -2);
  return { name: [...prefix, `${method}()`].join('.'), viaInvoke: tail === INVOKE };
}

/**
 * Rewrite `Ns.Type.<Method>d__N.MoveNext()` to `Ns.Type.Method()`.
 *
 * Returns the name unchanged when it is not an async state-machine frame, so
 * the caller can use the identity of the result to detect a no-op.
 */
export function logicalFrameName(name: string): string {
  return recogniseFrame(name)?.name ?? name;
}

/**
 * The state-machine TYPE a physical frame executes, when the frame is one.
 *
 * `StepTarget.Program.<LeafAsync>d__0.MoveNext()` yields
 * `StepTarget.Program.<LeafAsync>d__0` — the exact string netcoredbg renders
 * for that type in `evaluate` results, which is what lets `dap-stack.ts` match
 * the paused frame against the heap's active-task boxes.
 */
export function frameStateMachineType(name: string): string | undefined {
  const segments = splitQualifiedName(name);
  const last = segments[segments.length - 1];
  const owner = segments[segments.length - 2];
  if (last === undefined || owner === undefined) return undefined;
  if (withoutArguments(last) !== MOVE_NEXT) return undefined;
  if (stateMachineMethod(owner) === undefined) return undefined;
  return segments.slice(0, -1).join('.');
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

/**
 * True when the frame is F# compiler/library machinery by NAME grammar alone.
 *
 * `Microsoft.FSharp.*` is the F# compiler's own namespace and
 * `<StartupCode$FSharp-Core>.$Tasks.*` hosts the dynamic-mode resumption
 * interpreter. Unlike CoreLib these carry embedded PDBs, so they arrive WITH
 * source locations (a build-server path such as `D:\a\_work\...`) and the
 * sourceless-plumbing rule above never fires; [DEBUG-FSHARP-PDB] still forbids
 * showing them. The name test alone is not enough to drop a frame — the caller
 * must also prove the source is not the user's — so this is a predicate, not a
 * filter.
 */
export function isFSharpMachineryName(name: string): boolean {
  const segments = splitQualifiedName(name);
  const root = segments[0] ?? '';
  if (root === 'Microsoft' && segments[1] === 'FSharp') return true;
  return root.startsWith('<StartupCode$FSharp');
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

/** One frame paired with how the rename pass classified it. */
interface NamedFrame {
  readonly frame: RawFrame;
  readonly renamed: boolean;
  readonly viaInvoke: boolean;
}

/** Rename every recognised state-machine frame, remembering what changed. */
function renameFrames(frames: readonly RawFrame[]): NamedFrame[] {
  return frames.map((frame) => {
    const recognised = recogniseFrame(frame.name);
    if (recognised === undefined) return { frame, renamed: false, viaInvoke: false };
    return {
      frame: { ...frame, name: recognised.name },
      renamed: true,
      viaInvoke: recognised.viaInvoke,
    };
  });
}

/** True when a frame is F# machinery whose source is provably not the user's. */
function isForeignMachinery(frame: RawFrame, isUserPath?: (path: string) => boolean): boolean {
  if (!isFSharpMachineryName(frame.name)) return false;
  if (isSourceless(frame)) return true;
  const path = frame.source?.path;
  return path !== undefined && isUserPath !== undefined && !isUserPath(path);
}

/**
 * Collapse the duplicate rows renaming exposes.
 *
 * Two shapes arise. The F# stub `rootTask()` sits directly under the renamed
 * `rootTask@46.MoveNext()` frame once the plumbing between them is filtered —
 * a second row for the same activation, parked on the declaration line. And in
 * the compiler's dynamic mode ONE resumption is split across several closures
 * (`leafTask@42-3.Invoke()` over `leafTask@1-2.Invoke()`), each renaming to
 * the same logical method. Both duplicates are adjacent to the frame they
 * duplicate, so a single adjacency pass removes them; the innermost copy wins
 * because it carries the statement actually executing.
 */
function collapseDuplicates(frames: readonly NamedFrame[]): NamedFrame[] {
  const kept: NamedFrame[] = [];
  for (const current of frames) {
    const previous = kept[kept.length - 1];
    if (previous !== undefined && sameLogicalMethod(previous, current)) {
      const stubAfterMachine = previous.renamed && !current.renamed;
      const splitClosure = previous.viaInvoke && current.viaInvoke;
      if (stubAfterMachine || splitClosure) continue;
    }
    kept.push(current);
  }
  return kept;
}

/** True when two adjacent rows would render the same method name. */
function sameLogicalMethod(previous: NamedFrame, current: NamedFrame): boolean {
  return withoutArguments(previous.frame.name) === withoutArguments(current.frame.name);
}

/**
 * Reconstruct the logical async chain for one `stackTrace` response.
 *
 * `justMyCode` controls only the machinery frames: with it off the builder and
 * FSharp.Core frames are kept, because a user who deliberately turned Just My
 * Code off is asking to see the runtime's own frames. `isUserPath` is the
 * editor-aware ownership test for a source path; without it, frames WITH
 * source are never dropped, per the spec's retain-the-physical-stack fallback.
 */
export function enrichAsyncFrames(
  frames: readonly RawFrame[],
  justMyCode: boolean,
  isUserPath?: (path: string) => boolean,
): RawFrame[] {
  const named = renameFrames(frames);
  const renamed = new Set<string>(
    named.filter((entry) => entry.renamed).map((entry) => withoutArguments(entry.frame.name)),
  );
  const visible = named.filter(({ frame }) => {
    if (isRedundantStub(frame, renamed)) return false;
    if (!justMyCode) return true;
    return !isAsyncPlumbing(frame) && !isForeignMachinery(frame, isUserPath);
  });
  return collapseDuplicates(visible).map((entry) => entry.frame);
}
