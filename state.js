/**
 * state.js
 * Deterministic state projection — derived entirely from the event log.
 *
 * Rules:
 *   - No direct mutation. Ever. Only apply(event) is the write path.
 *   - Pure functions only: same log → same state, on every node
 *   - State is always fully rebuildable by calling derive(log.toArray())
 *   - Subscribers are notified after every successful apply()
 */

export class State {
  // Internal flat key-value store.
  // All actions write deltas that are merged here.
  #data = {}

  /** @type {Registry} */
  #registry

  /** @type {Set<Function>} */
  #subscribers = new Set()

  constructor(registry) {
    this.#registry = registry
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Snapshot of the full state — returns a copy, never the live object */
  snapshot() {
    return { ...this.#data }
  }

  /** Read a single key */
  get(key) {
    return this.#data[key] ?? null
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Apply a single event to state.
   * Called by the Kernel after the event is appended to the log.
   *
   * @returns {{ delta, snapshot }} — what changed and the resulting state
   */
  apply(event) {
    if (!this.#registry.has(event.action)) {
      // Unknown action — skip silently (future-proof for schema upgrades)
      // The log still has it; we just can't project it yet.
      return null
    }

    let delta
    try {
      delta = this.#registry.execute(event.action, this.#data, event.payload, event)
    } catch (e) {
      // Execution errors mean the event is invalid — do not apply
      throw new Error(`[State] action "${event.action}" failed: ${e.message}`)
    }

    // Merge delta into state
    // For DELETE the handler returns the full next-state object
    if (event.action === 'DELETE') {
      this.#data = { ...delta }
    } else {
      this.#data = { ...this.#data, ...delta }
    }

    const snap = this.snapshot()
    for (const fn of this.#subscribers) {
      try { fn(snap, event, delta) } catch {}
    }

    return { delta, snapshot: snap }
  }

  /**
   * Rebuild state from scratch by replaying a full event array.
   * Guarantees determinism — same log → same state on every node.
   */
  derive(events) {
    this.#data = {}
    for (const ev of events) this.apply(ev)
    return this.snapshot()
  }

  // ── Subscribe ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to state changes.
   * Callback receives (snapshot, event, delta) after every apply().
   * @returns {Function} unsubscribe handle
   */
  subscribe(fn) {
    this.#subscribers.add(fn)
    return () => this.#subscribers.delete(fn)
  }
}
