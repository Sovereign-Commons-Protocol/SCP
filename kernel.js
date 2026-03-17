/**
 * kernel.js
 * The Sovereign Node Runtime Kernel.
 *
 * This is the ONLY orchestration point.
 * Every layer has exactly one job. The Kernel wires them together.
 *
 * ─────────────────────────────────────────────────────────
 *  OUTBOUND PIPELINE (commit)
 * ─────────────────────────────────────────────────────────
 *   commit(action, payload)
 *     → validate action + payload (registry)
 *     → create event object
 *     → sign event (identity)
 *     → append to log
 *     → apply to state
 *     → persist (storage)
 *     → broadcast (network)
 *     → emit 'commit'
 *
 * ─────────────────────────────────────────────────────────
 *  INBOUND PIPELINE (receive)
 * ─────────────────────────────────────────────────────────
 *   receive(message)
 *     → check type === 'EVENT'
 *     → verify signature (consensus)
 *     → validate event (consensus)
 *     → deduplicate (log.has)
 *     → append to log
 *     → apply to state
 *     → persist (storage)
 *     → emit 'receive'
 *
 * ─────────────────────────────────────────────────────────
 *  SYNC PIPELINE
 * ─────────────────────────────────────────────────────────
 *   sync(peer)
 *     → exchange heads
 *     → resolve fork (consensus)
 *     → request missing events
 *     → apply via inbound pipeline
 *
 * Invariants (enforced at every layer):
 *   1. Determinism     — same log → same state, on every node
 *   2. Sovereignty     — node can run alone, owns identity, reconstruct fully
 *   3. Append-only     — nothing mutated, only extended
 *   4. Verifiable      — every action signed, validated, replayable
 *   5. Layer isolation — no layer touches another's internals
 */

import { Emitter }   from './emitter.js'
import { Identity, hexToBytes }  from './identity.js'
import { Log }       from './log.js'
import { State }     from './state.js'
import { Consensus } from './consensus.js'
import { Storage }   from './storage.js'
import { Network }   from './network.js'
import { Integrity } from './integrity.js'

export class Kernel extends Emitter {
  // Layers — set during start()
  identity  = null  // { nodeId, did, algo, publicKey, _priv, … }
  log       = null  // Log
  state     = null  // State
  consensus = null  // Consensus
  storage   = null  // Storage
  network   = null  // Network
  integrity = null  // Integrity — live only, NOT derived from log

  /** Registry — injected by caller, not owned by Kernel */
  #registry = null

  #started   = false
  #startedAt = null

  /**
   * @param {object} opts
   * @param {Registry}  opts.registry  — action registry (required)
   * @param {Log}       [opts.log]     — inject pre-built log (e.g. loaded from storage)
   * @param {State}     [opts.state]   — inject pre-built state
   * @param {Consensus} [opts.consensus]
   * @param {Storage}   [opts.storage]
   * @param {Network}   [opts.network]
   */
  constructor({ registry, log, state, consensus, storage, network } = {}) {
    super()
    if (!registry) throw new Error('Kernel requires a registry')
    this.#registry = registry
    this.log       = log       ?? new Log()
    this.state     = state     ?? new State(registry)
    this.consensus = consensus ?? new Consensus()
    this.storage   = storage   ?? new Storage()
    this.network   = network   ?? new Network()
    this.integrity = new Integrity()
  }

  /**
   * Trust threshold for soft filtering.
   *
   * MESSAGE events from nodes whose integrity score is below this value
   * are tagged as `lowTrust: true` in the event before entering state —
   * they are NOT rejected (truth is objective), but they are marked so
   * the UI and future consumers can make their own decision.
   *
   * 0  = accept everything (no filtering)
   * 30 = tag messages from nodes with < 30% valid ratio
   * 50 = tag messages from untrusted or unknown nodes
   *
   * This is a local policy — it never affects consensus.
   */
  trustThreshold = 30

  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────

  async start() {
    if (this.#started) return

    // ── 1. Storage ──────────────────────────────────────────────────────────
    this._boot('storage')
    await this.storage.init()

    // ── 2. Identity ─────────────────────────────────────────────────────────
    this._boot('identity')
    const stored = await this.storage.loadIdentity()
    if (stored) {
      // Re-hydrate from stored bytes
      this.identity = await Identity.fromBytes(stored.publicKey, stored.privateKey)
    } else {
      // First boot — generate and persist
      this.identity = await Identity.generate()
      await this.storage.saveIdentity(this.identity)
    }
    this._boot('identity:ready — ' + this.identity.did)

    // ── 3. Log replay ────────────────────────────────────────────────────────
    this._boot('log:replay')
    const storedEvents = await this.storage.loadLog()
    for (const ev of storedEvents) this.log.import(ev)
    // Rebuild state from the full log
    this.state.derive(this.log.toArray())
    this._boot(`log:replay complete — ${this.log.size} events`)

    // ── 4. Network ───────────────────────────────────────────────────────────
    this._boot('network')
    await this.network.init({ nodeId: this.identity.nodeId, name: this.identity.did.slice(-8) })
    this.network.on('message', msg => this.#receive(msg))
    this.network.on('log',     entry => this.emit('netlog', entry))
    this.network.on('connect', p => {
      this.emit('peerConnect', p)
      // On peer connect: send our current head for sync
      this.network.send(p.nodeId, {
        type: 'SYNC_HEAD', from: this.identity.nodeId,
        head: this.log.head, seq: this.log.size,
      })
    })
    this.network.on('disconnect', p => this.emit('peerDisconnect', p))
    this.network.on('peers',      list => this.emit('peers', list))

    // ── 5. Genesis ───────────────────────────────────────────────────────────
    // Only write genesis if we have no events yet
    if (this.log.size === 0) {
      this._boot('genesis')
      await this.commit('REGISTER_NODE', {
        nodeId:       this.identity.nodeId,
        did:          this.identity.did,
        publicKeyHex: Array.from(this.identity.publicKey)
          .map(b => b.toString(16).padStart(2, '0')).join(''),
      })
    }

    this.#started   = true
    this.#startedAt = Date.now()
    this._boot('ready')
    this.emit('ready', {
      nodeId: this.identity.nodeId,
      did:    this.identity.did,
      algo:   this.identity.algo,
      events: this.log.size,
    })
  }

  async stop() {
    this.network?.destroy()
    this.#started = false
    this.emit('stopped')
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OUTBOUND PIPELINE
  // ─────────────────────────────────────────────────────────────────────────

  async commit(action, payload) {
    if (!this.identity) throw new Error('kernel not started — call start() first')

    // 1. Validate action + payload
    const check = this.#registry.validate(action, payload)
    if (!check.valid)
      throw new Error(`[commit] invalid: ${check.errors.join('; ')}`)

    // 2. Sign the canonical content BEFORE appending
    //    We sign: { prev, seq, timestamp, actor, action, payload }
    //    The log computes id from the same fields → id is reproducible
    const base = {
      prev:      this.log.head,
      seq:       this.log.size,
      timestamp: Date.now(),
      actor:     this.identity.nodeId,
      action,
      payload,
    }
    const signature = await Identity.sign(JSON.stringify(base), this.identity)

    // 3. Append to log (log computes id from base fields)
    const event = await this.log.append({ action, payload, actor: this.identity.nodeId, signature })

    // 4. Apply to state
    try {
      this.state.apply(event)
    } catch (e) {
      // State errors don't unwind the log — log is truth
      this.emit('error', { source: 'state:apply', event, error: e.message })
    }

    // 5. Persist
    await this.storage.saveEvent(event)

    // 6. Broadcast
    this.network.broadcast({ type: 'EVENT', payload: event })

    // 7. Notify
    this.emit('commit', event)
    this.integrity.recordValid(this.identity.nodeId)
    return event
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INBOUND PIPELINE
  // ─────────────────────────────────────────────────────────────────────────

  async #receive(msg) {
    if (!msg?.type) return
    try {
      switch (msg.type) {
        case 'EVENT':      return await this.#receiveEvent(msg.payload)
        case 'SYNC_HEAD':  return await this.#receiveSyncHead(msg)
        case 'SYNC_REQ':   return await this.#receiveSyncReq(msg)
        case 'SYNC_RESP':  return await this.#receiveSyncResp(msg)
      }
    } catch (e) {
      this.emit('error', { source: 'receive', error: e.message, msg })
    }
  }

  async #receiveEvent(event) {
    if (!event?.id || !event?.action) return

    // Deduplicate
    if (this.log.has(event.id)) return

    // Get actor's public key from state (if registered)
    const nodeRecord = this.state.get(`node:${event.actor}`)
    const pubKey     = nodeRecord?.publicKeyHex ? hexToBytes(nodeRecord.publicKeyHex) : null

    // Validate event (hash + sig if we have the key)
    const result = await this.consensus.validate(event, pubKey)
    if (!result.valid) {
      this.integrity.recordInvalid(event.actor)
      this.emit('error', { source: 'consensus', reason: result.reason, event })
      return
    }

    // Valid — record before import so we count it even if already seen
    this.integrity.recordValid(event.actor)

    // ── Trust-weighted soft filter ────────────────────────────────────────
    // MESSAGE events from nodes below the trust threshold are tagged
    // `lowTrust: true` before entering state.
    // CRITICAL: the event itself is NOT modified — we annotate a shallow copy.
    // The log stores the original. State sees the annotation.
    // Truth is preserved. Trust is local policy.
    let eventToApply = event
    if (event.action === 'MESSAGE' && this.trustThreshold > 0) {
      const score = this.integrity.score(event.actor)
      if (score < this.trustThreshold) {
        eventToApply = { ...event, payload: { ...event.payload, lowTrust: true, trustScore: score } }
        this.emit('lowTrust', { event, score })
      }
    }

    // Import into log — always the original, unmodified event
    const isNew = this.log.import(event)
    if (!isNew) return

    // Apply to state — possibly with lowTrust annotation
    try { this.state.apply(eventToApply) } catch (e) {
      this.emit('error', { source: 'state:apply', event, error: e.message })
    }

    // Persist
    await this.storage.saveEvent(event)

    this.emit('receive', event)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SYNC PIPELINE
  // ─────────────────────────────────────────────────────────────────────────

  async #receiveSyncHead(msg) {
    if (msg.from === this.identity.nodeId) return
    const winner = this.consensus.resolve(
      { head: this.log.head, seq: this.log.size },
      { head: msg.head,       seq: msg.seq       }
    )
    // If remote chain is longer/better → request what we're missing
    if (winner === 'remote') {
      this.network.send(msg.from, {
        type: 'SYNC_REQ', from: this.identity.nodeId,
        fromSeq: this.log.size,
      })
    }
  }

  async #receiveSyncReq(msg) {
    if (msg.from === this.identity.nodeId) return
    const events = this.log.toArray().filter(e => e.seq >= (msg.fromSeq ?? 0))
    this.network.send(msg.from, {
      type: 'SYNC_RESP', from: this.identity.nodeId,
      events, head: this.log.head, seq: this.log.size,
    })
  }

  async #receiveSyncResp(msg) {
    for (const ev of (msg.events ?? [])) await this.#receiveEvent(ev)
    this.emit('synced', { peer: msg.from, events: msg.events?.length ?? 0 })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /** Manually trigger a sync with a peer */
  async sync(nodeId) {
    this.network.send(nodeId, {
      type: 'SYNC_HEAD', from: this.identity.nodeId,
      head: this.log.head, seq: this.log.size,
    })
  }

  /** Snapshot of the current state */
  snapshot() { return this.state.snapshot() }

  /** Read a single state key */
  get(key) { return this.state.get(key) }

  /** Subscribe to state changes */
  subscribe(fn) { return this.state.subscribe(fn) }

  /** Register a custom action at runtime */
  registerAction(name, handler, validator = null) {
    this.#registry.register(name, handler, validator)
  }

  /** Status summary — useful for debugging and UI */
  status() {
    return {
      started:   this.#started,
      startedAt: this.#startedAt,
      nodeId:    this.identity?.nodeId,
      did:       this.identity?.did,
      algo:      this.identity?.algo,
      logSize:   this.log.size,
      logHead:   this.log.head,
      peers:     this.network.peerCount(),
      swReady:   this.network.isSwReady(),
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────────────────

  _boot(phase) {
    this.emit('boot', { phase, ts: Date.now() })
  }
}
