/**
 * log.js
 * Append-only, hash-linked event log.
 * The single source of truth — everything else derives from this.
 *
 * Event shape:
 *   {
 *     id        : string  — hex(SHA-256(canonical content))
 *     prev      : string | null  — id of predecessor event
 *     seq       : number  — monotonic index (0, 1, 2 …)
 *     timestamp : number  — unix ms
 *     actor     : string  — nodeId of the signer
 *     action    : string  — registered action name
 *     payload   : object  — action-specific data
 *     signature : string  — hex(ECDSA sign of event without sig field)
 *   }
 *
 * Invariants:
 *   - Append-only: no mutation after write
 *   - Hash-chained: every event commits to prev
 *   - Fully replayable: state = reduce(log, registry)
 *   - Signed: every event carries actor signature
 */

import { sha256hex } from './identity.js'

export class Log {
  #events = new Map() // id → frozen event
  #head   = null      // id of latest event
  #seq    = 0         // next sequence number

  get head() { return this.#head }
  get size()  { return this.#events.size }

  // ── Append (used when WE create an event) ────────────────────────────────
  //
  // Signature is applied by the Kernel before calling append().
  // The log itself does not sign — separation of concerns.

  async append({ action, payload, actor, signature }) {
    const base = {
      prev:      this.#head,
      seq:       this.#seq,
      timestamp: Date.now(),
      actor,
      action,
      payload,
    }

    // id = hash of all content fields (not including id or signature)
    const id = await sha256hex(JSON.stringify(base))

    const event = Object.freeze({ id, ...base, signature })

    this.#events.set(id, event)
    this.#head = id
    this.#seq++

    return event
  }

  // ── Import (used when we receive an event from a peer or storage) ─────────
  //
  // Does NOT re-hash or re-sign. Trusts the id already on the event.
  // The Kernel verifies signature before calling import().

  import(event) {
    if (this.#events.has(event.id)) return false // already known
    this.#events.set(event.id, Object.freeze(event))

    // Advance head & seq if this extends our chain
    if (event.seq >= this.#seq) {
      this.#head = event.id
      this.#seq  = event.seq + 1
    }

    return true // new
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  get(id)  { return this.#events.get(id) ?? null }
  has(id)  { return this.#events.has(id) }

  /**
   * Return all events in append order (oldest → newest).
   * Reconstructed by walking the prev-chain from head.
   */
  toArray() {
    if (!this.#head) return []
    const ordered = []
    let cur = this.#head
    while (cur) {
      const ev = this.#events.get(cur)
      if (!ev) break
      ordered.unshift(ev)
      cur = ev.prev
    }
    return ordered
  }

  // ── Verify chain integrity ────────────────────────────────────────────────
  //
  // Checks that every event's prev pointer and hash are self-consistent.
  // Signature verification is separate (needs public keys, lives in Kernel).

  async verify() {
    const events = this.toArray()

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]

      // 1. Prev-link
      const expectedPrev = i === 0 ? null : events[i - 1].id
      if (ev.prev !== expectedPrev)
        return { valid: false, seq: ev.seq, reason: 'broken prev-link' }

      // 2. Hash matches content
      const { id, signature, ...base } = ev
      const expectedId = await sha256hex(JSON.stringify(base))
      if (id !== expectedId)
        return { valid: false, seq: ev.seq, reason: 'hash mismatch' }
    }

    return { valid: true, length: events.length }
  }

  // ── Serialise ─────────────────────────────────────────────────────────────

  toJSON() {
    return { head: this.#head, events: this.toArray() }
  }

  static fromJSON(data) {
    const log = new Log()
    for (const ev of (data.events ?? [])) log.import(ev)
    return log
  }
}
