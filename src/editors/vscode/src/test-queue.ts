/**
 * One `dotnet` invocation at a time, for the whole Test Explorer.
 *
 * Discovery BUILDS the solution and a run rebuilds the same projects, so two
 * overlapping invocations race on the shared `bin/`/`obj/` output — VSTest then
 * dies with "The application to execute does not exist: …testhost.dll", and a
 * Microsoft.Testing.Platform module cannot even be started while it is being
 * written. Reactive re-discovery is debounced, not cancelled, so that overlap
 * is reachable whenever a user runs a test while a sweep is still building.
 *
 * Implements [TEST-REACTIVITY].
 */

/** A serial queue of `dotnet` invocations. */
export class DotnetQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Queue `work` behind any invocation already in flight. */
  public async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return await next;
  }

  /**
   * Resolve once no invocation is outstanding. Tests use this to settle
   * reactive re-discovery before touching the fixture on disk; a `dotnet test`
   * left pointing at a deleted directory hangs and poisons the next run.
   */
  public async whenIdle(): Promise<void> {
    let seen: Promise<unknown> | undefined;
    while (seen !== this.tail) {
      seen = this.tail;
      await seen;
    }
  }
}
