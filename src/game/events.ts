/**
 * Event bridge between the Phaser runtime and the Svelte interface.
 *
 * The game loop stays in Phaser. Only meaningful state changes cross this bus —
 * never per-frame movement data.
 *
 * A small typed emitter, free of Phaser so the stores and the session load in
 * Node tests. Names and payloads come from one registry (`EventMap` in
 * event-names.ts); `on(name, fn, ctx)` and `off(name, fn, ctx)` keep Phaser's
 * shape so scene code reads the same.
 */
import type { EventArgs, EventHandler, EventMap, EventName } from './event-names.ts'

interface Listener {
  fn: (...args: never[]) => void
  ctx: unknown
  once: boolean
}

export class Bus<M extends object> {
  // Each name's listeners are replaced (never mutated) on change, so an emit
  // walks the list as it was when it started, as Phaser's emitter did.
  private readonly listeners = new Map<keyof M, readonly Listener[]>()

  on<K extends keyof M>(name: K, fn: EventHandler<M[K]>, ctx?: unknown): this {
    return this.add(name, fn, ctx, false)
  }

  once<K extends keyof M>(name: K, fn: EventHandler<M[K]>, ctx?: unknown): this {
    return this.add(name, fn, ctx, true)
  }

  /** Removes `fn` (every `fn` with this `ctx` when one is given), or every listener of `name`. */
  off<K extends keyof M>(name: K, fn?: EventHandler<M[K]>, ctx?: unknown): this {
    const list = this.listeners.get(name)
    if (!list) return this
    const keep = fn ? list.filter((l) => l.fn !== fn || (ctx !== undefined && l.ctx !== ctx)) : []
    if (keep.length) this.listeners.set(name, keep)
    else this.listeners.delete(name)
    return this
  }

  emit<K extends keyof M>(name: K, ...args: EventArgs<M[K]>): boolean {
    const list = this.listeners.get(name)
    if (!list) return false
    for (const l of list) {
      if (l.once) this.off(name, l.fn as EventHandler<M[K]>, l.ctx)
      ;(l.fn as (...a: unknown[]) => void).apply(l.ctx, args)
    }
    return true
  }

  listenerCount(name: keyof M): number {
    return this.listeners.get(name)?.length ?? 0
  }

  removeAllListeners(name?: keyof M): this {
    if (name === undefined) this.listeners.clear()
    else this.listeners.delete(name)
    return this
  }

  private add<K extends keyof M>(name: K, fn: EventHandler<M[K]>, ctx: unknown, once: boolean): this {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), { fn: fn as Listener['fn'], ctx, once }])
    return this
  }
}

export const bus = new Bus<EventMap>()

export * from './event-names.ts'

/** Subscribe to several events at once; returns the matching unsubscribe. */
export function listen(handlers: { [K in EventName]?: EventHandler<EventMap[K]> }): () => void {
  const pairs = Object.entries(handlers) as [EventName, EventHandler<EventMap[EventName]>][]
  for (const [name, fn] of pairs) bus.on(name, fn)
  return () => {
    for (const [name, fn] of pairs) bus.off(name, fn)
  }
}
