/** Minimal reactive signals for centralized state management. */

type Listener<T> = (value: T) => void;

/**
 * Tracked signals during an active effect run. Each signal registers itself
 * via the `trackable` hook passed to `trackRead`, which records a subscribe
 * closure capable of re-running the effect.
 */
interface Trackable {
  readonly subscribeUntyped: (onChange: () => void) => () => void;
}

/**
 * Reactive value container that notifies subscribers when the value changes.
 * Uses Object.is equality — primitives skip no-op updates, reference types
 * always notify since each new object is a distinct reference.
 */
export class Signal<T> implements Trackable {
  private readonly listeners = new Set<Listener<T>>();
  private current: T;

  constructor(initial: T) {
    this.current = initial;
  }

  public get value(): T {
    trackRead(this);
    return this.current;
  }

  public set value(next: T) {
    if (Object.is(this.current, next)) return;
    this.current = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  /** Subscribe to value changes. Returns a dispose function. */
  public subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe without receiving the new value. Used by `effect()` — keeps
   * the public `subscribe` typed while letting the tracker avoid `unknown`.
   */
  public subscribeUntyped(onChange: () => void): () => void {
    return this.subscribe(() => {
      onChange();
    });
  }

  /** Force-notify listeners even if value is Object.is-equal (for mutable collections). */
  public notify(): void {
    for (const listener of this.listeners) {
      listener(this.current);
    }
  }
}

// ── Dependency tracking for effect() ───────────────────────────────

let activeTracker: Set<Trackable> | undefined;

function trackRead(signal: Trackable): void {
  activeTracker?.add(signal);
}

/**
 * Run `fn` immediately, record every Signal read during the call, and re-run
 * `fn` whenever any of those signals change. Returns a dispose function that
 * cancels all subscriptions. Re-runs re-track dependencies — signals not read
 * on a subsequent run stop triggering.
 */
export function effect(fn: () => void): () => void {
  let disposers: (() => void)[] = [];
  let disposed = false;

  const run = (): void => {
    if (disposed) return;
    for (const d of disposers) d();
    disposers = [];
    const deps = new Set<Trackable>();
    const prev = activeTracker;
    activeTracker = deps;
    try {
      fn();
    } finally {
      activeTracker = prev;
    }
    for (const dep of deps) {
      disposers.push(
        dep.subscribeUntyped(() => {
          run();
        }),
      );
    }
  };

  run();

  return () => {
    disposed = true;
    for (const d of disposers) d();
    disposers = [];
  };
}
