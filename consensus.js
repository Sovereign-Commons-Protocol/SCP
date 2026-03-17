/**
 * consensus.js
 * Phase 1 consensus — validation + longest-chain fork resolution.
 *
 * Phase 1 rules (deliberately simple):
 *   1. Event signature must be valid
 *   2. Event hash must match content
 *   3. Fork resolution: longest chain wins
 *      (tie-break: lexicographically smaller head id)
 *
 * Phase 2+ (not in this file):
 *   CRDT merge strategies, quorum-based agreement, stake-weighted validation
 *
 * Invariant:
 *   validate() must be called and pass before any event enters the log.
 */

import { Identity, sha256hex, hexToBytes } from './identity.js'

export class Consensus {

  // ── Validate a single event ───────────────────────────────────────────────

  /**
   * Verify that an event is structurally sound and properly signed.
   *
   * @param {object} event       — the event to validate
   * @param {object} [publicKey] — Uint8Array public key of the actor
   *                               (optional: if unknown node, skip sig check)
   * @returns {{ valid: boolean, reason?: string }}
   */
  async validate(event, publicKey = null) {
    // 1. Required fields
    for (const f of ['id', 'prev', 'seq', 'timestamp', 'actor', 'action', 'payload', 'signature']) {
      if (event[f] === undefined)
        return { valid: false, reason: `missing field: ${f}` }
    }

    // 2. Hash matches content
    const { id, signature, ...base } = event
    const expectedId = await sha256hex(JSON.stringify(base))
    if (id !== expectedId)
      return { valid: false, reason: 'hash mismatch' }

    // 3. Signature valid (if we have the public key)
    if (publicKey) {
      const ok = await Identity.verify(
        JSON.stringify({ id, ...base }),
        hexToBytes(signature),
        publicKey
      )
      if (!ok) return { valid: false, reason: 'invalid signature' }
    }

    return { valid: true }
  }

  // ── Fork resolution ───────────────────────────────────────────────────────

  /**
   * Given two competing chain heads, return the one that should win.
   *
   * Strategy (Phase 1):
   *   - Longer chain wins (higher seq)
   *   - Tie: lexicographically smaller head id wins (deterministic)
   *
   * @param {{ head: string, seq: number }} local
   * @param {{ head: string, seq: number }} remote
   * @returns {'local' | 'remote'}
   */
  resolve(local, remote) {
    if (remote.seq > local.seq) return 'remote'
    if (remote.seq < local.seq) return 'local'
    // tie-break: smaller id is lexicographically "earlier" → wins
    return remote.head < local.head ? 'remote' : 'local'
  }
}
