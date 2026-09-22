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
  private readonly tail = new Latest();

  /** Queue `work` behind any invocation already in flight. */
  public async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.current.then(work, work);
    this.tail.current = next.catch(() => undefined);
    return await next;
  }

  /**
   * Resolve once no invocation is outstanding. Tests use this to settle
   * reactive re-discovery before touching the fixture on disk; a `dotnet test`
   * left pointing at a deleted directory hangs and poisons the next run.
   */
  public async whenIdle(): Promise<void> {
    await this.tail.settled();
  }
}

/**
 * The newest of a series of jobs that SUPERSEDE each other.
 *
 * A superseded discovery sweep applies nothing, so whoever awaited it — a
 * refresh, the view's first reveal — must wait for the sweep that superseded it
 * instead. Resolving at once left the previous solution's tree on view as if
 * it had just been discovered. Implements [TEST-REACTIVITY].
 */
export class NewestJob {
  private readonly newest = new Latest();

  /** Make `job` the newest, then resolve once the newest job — whichever — has run. */
  public async settle(job: Promise<unknown>): Promise<void> {
    this.newest.current = job;
    await this.newest.settled();
  }
}

/** A promise later work may replace; settling waits out every replacement too. */
class Latest {
  public current: Promise<unknown> = Promise.resolve();

  public async settled(): Promise<void> {
    let seen: Promise<unknown> | undefined;
    while (seen !== this.current) {
      seen = this.current;
      await seen;
    }
  }
}
