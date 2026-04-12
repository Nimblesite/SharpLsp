/** Minimal reactive signal for centralized state management. */

type Listener<T> = (value: T) => void;

/**
 * Reactive value container that notifies subscribers when the value changes.
 * Uses Object.is equality — primitives skip no-op updates, reference types
 * always notify since each new object is a distinct reference.
 */
export class Signal<T> {
    private readonly listeners = new Set<Listener<T>>();
    private current: T;

    constructor(initial: T) {
        this.current = initial;
    }

    public get value(): T {
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
}
