/**
 * storage.js
 * Persistence layer — IndexedDB only, no abstraction bloat.
 *
 * Stores:
 *   'log'      — serialised event log entries (keyPath: 'id')
 *   'identity' — SPKI/PKCS8 key bytes + metadata
 *   'snapshot' — periodic state snapshots (keyPath: 'seq')
 *
 * Invariants:
 *   - Log entries are append-only — never updated, never deleted
 *   - Identity is overwritten only on explicit key rotation
 *   - Snapshots are additive — old ones never removed automatically
 */

const DB_NAME    = 'snr-v1'
const DB_VERSION = 1

function _open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = e => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('log'))
        db.createObjectStore('log', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('identity'))
        db.createObjectStore('identity')
      if (!db.objectStoreNames.contains('snapshot'))
        db.createObjectStore('snapshot', { keyPath: 'seq' })
    }

    req.onsuccess = e => resolve(e.target.result)
    req.onerror   = e => reject(new Error('IDB open failed: ' + e.target.error))
  })
}

function _tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(stores, mode)
    const req = fn(tx)
    if (req) {
      req.onsuccess = e => resolve(e.target.result)
      req.onerror   = e => reject(e.target.error)
    } else {
      tx.oncomplete = () => resolve()
      tx.onerror    = e => reject(e.target.error)
    }
  })
}

export class Storage {
  #db = null

  async init() {
    this.#db = await _open()
    return this
  }

  // ── Log ───────────────────────────────────────────────────────────────────

  async saveEvent(event) {
    const db = this.#db
    return _tx(db, ['log'], 'readwrite', tx =>
      tx.objectStore('log').put({
        id:        event.id,
        prev:      event.prev,
        seq:       event.seq,
        timestamp: event.timestamp,
        actor:     event.actor,
        action:    event.action,
        payload:   event.payload,
        signature: event.signature,
      })
    )
  }

  async loadLog() {
    const db = this.#db
    const rows = await _tx(db, ['log'], 'readonly', tx =>
      tx.objectStore('log').getAll()
    )
    // Sort by seq to guarantee correct order regardless of IDB iteration
    return (rows ?? []).sort((a, b) => a.seq - b.seq)
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  async saveIdentity(identity) {
    const db = this.#db
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('identity', 'readwrite')
      const st  = tx.objectStore('identity')
      // Store raw bytes — not CryptoKeys (those can't be serialised)
      const data = {
        nodeId:    identity.nodeId,
        did:       identity.did,
        algo:      identity.algo,
        publicKey: Array.from(identity.publicKey),   // Uint8Array → plain array for IDB
        privateKey: Array.from(identity.privateKey),
        createdAt: identity.createdAt,
      }
      st.put(data, 'primary')
      tx.oncomplete = () => resolve()
      tx.onerror    = e  => reject(e.target.error)
    })
  }

  async loadIdentity() {
    const db = this.#db
    const data = await _tx(db, ['identity'], 'readonly', tx =>
      tx.objectStore('identity').get('primary')
    )
    if (!data) return null
    return {
      nodeId:    data.nodeId,
      did:       data.did,
      algo:      data.algo,
      publicKey: new Uint8Array(data.publicKey),
      privateKey: new Uint8Array(data.privateKey),
      createdAt: data.createdAt,
    }
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  async saveSnapshot(snapshot) {
    const db = this.#db
    return _tx(db, ['snapshot'], 'readwrite', tx =>
      tx.objectStore('snapshot').put(snapshot)
    )
  }

  async loadLatestSnapshot() {
    const db = this.#db
    const all = await _tx(db, ['snapshot'], 'readonly', tx =>
      tx.objectStore('snapshot').getAll()
    )
    if (!all || all.length === 0) return null
    return all.sort((a, b) => b.seq - a.seq)[0]
  }
}
