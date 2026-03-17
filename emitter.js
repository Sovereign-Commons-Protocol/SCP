/**
 * emitter.js
 * Internal event bus — the nervous system of the kernel.
 *
 * Rules:
 *   - Zero dependencies
 *   - No async inside emit (callers own that)
 *   - Errors in listeners are caught and re-emitted on 'error'
 *     so one bad listener never kills the bus
 */

export class Emitter {
  #listeners = new Map() // event → Set<fn>

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set())
    this.#listeners.get(event).add(fn)
    // return unsubscribe handle
    return () => this.off(event, fn)
  }

  once(event, fn) {
    const wrap = (data) => { this.off(event, wrap); fn(data) }
    wrap._original = fn
    return this.on(event, wrap)
  }

  off(event, fn) {
    const set = this.#listeners.get(event)
    if (!set) return
    // handle once-wrappers
    for (const f of set) {
      if (f === fn || f._original === fn) { set.delete(f); break }
    }
    if (set.size === 0) this.#listeners.delete(event)
  }

  emit(event, data) {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try { fn(data) } catch (e) {
        // avoid infinite loop if 'error' listener itself throws
        if (event !== 'error') this.emit('error', { source: event, error: e })
        else console.error('[Emitter] error listener threw:', e)
      }
    }
  }

  removeAll(event) {
    event ? this.#listeners.delete(event) : this.#listeners.clear()
  }
}
