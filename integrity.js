/**
 * integrity.js
 * Local-observed integrity scores — Layer A only.
 *
 * Critical invariants:
 *   - NEVER fed by log replay (would silently corrupt scores)
 *   - NEVER stored in consensus state (would create event loops)
 *   - Only updated by live kernel observations (commit / receive)
 *   - Memory-first; optional IndexedDB persistence handled externally
 *
 * Score formula:
 *   validRatio = validEvents / totalEvents
 *   score      = round(validRatio * 100)
 *   baseline   = 50 (no data)
 *
 * One honest number beats three invented ones.
 */

export class Integrity {
  /** nodeId → { valid, invalid, firstSeen, lastSeen } */
  #nodes = new Map()

  // ── Write ─────────────────────────────────────────────────────────────────

  recordValid(nodeId) {
    const n = this.#get(nodeId)
    n.valid++
    n.lastSeen = Date.now()
  }

  recordInvalid(nodeId) {
    const n = this.#get(nodeId)
    n.invalid++
    n.lastSeen = Date.now()
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  score(nodeId) {
    const n     = this.#nodes.get(nodeId)
    if (!n) return 50  // neutral — no data
    const total = n.valid + n.invalid
    if (total === 0) return 50
    return Math.round((n.valid / total) * 100)
  }

  get(nodeId) {
    const n = this.#nodes.get(nodeId)
    if (!n) return null
    return { ...n, score: this.score(nodeId) }
  }

  /** Full snapshot — safe copy, no live references */
  snapshot() {
    const out = {}
    for (const [id, n] of this.#nodes) {
      out[id] = { ...n, score: this.score(id) }
    }
    return out
  }

  /** All tracked nodeIds */
  nodeIds() {
    return [...this.#nodes.keys()]
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #get(nodeId) {
    if (!this.#nodes.has(nodeId)) {
      this.#nodes.set(nodeId, {
        valid:     0,
        invalid:   0,
        firstSeen: Date.now(),
        lastSeen:  Date.now(),
      })
    }
    return this.#nodes.get(nodeId)
  }
}
