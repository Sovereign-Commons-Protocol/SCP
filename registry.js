/**
 * registry.js
 * The action registry — the "smart contract layer" of the SNR.
 *
 * Actions are pure functions: (state, payload) → stateDelta
 *
 * Rules:
 *   - Handlers MUST be pure — same input → same output, always
 *   - Handlers MUST NOT mutate state — return a delta object
 *   - Unknown actions are rejected before execution
 *   - This is the ONLY place business logic lives
 */

export class Registry {
  #handlers  = new Map()  // name → (state, payload) => delta
  #validators = new Map() // name → (payload) => { valid, errors }

  /**
   * Register an action.
   * @param {string}    name
   * @param {Function}  handler   (state, payload) => stateDelta — must be pure
   * @param {Function}  [validator] (payload) => { valid, errors[] }
   */
  register(name, handler, validator = null) {
    const key = name.toUpperCase()
    this.#handlers.set(key, handler)
    if (validator) this.#validators.set(key, validator)
    return this // chainable
  }

  has(name) {
    return this.#handlers.has(name?.toUpperCase())
  }

  list() {
    return [...this.#handlers.keys()]
  }

  validate(name, payload) {
    const key = name?.toUpperCase()
    if (!this.#handlers.has(key))
      return { valid: false, errors: [`unknown action: "${name}"`] }
    const validator = this.#validators.get(key)
    if (!validator) return { valid: true, errors: [] }
    try {
      return validator(payload) ?? { valid: true, errors: [] }
    } catch (e) {
      return { valid: false, errors: [e.message] }
    }
  }

  /**
   * Execute an action against current state.
   * Returns the state delta — does NOT mutate state.
   */
  execute(name, state, payload, event = null) {
    const key     = name?.toUpperCase()
    const handler = this.#handlers.get(key)
    if (!handler) throw new Error(`unknown action: "${name}"`)
    const delta = handler(state, payload, event)
    if (typeof delta !== 'object' || delta === null)
      throw new Error(`handler for "${name}" must return an object`)
    return delta
  }
}

// ── Built-in actions ──────────────────────────────────────────────────────
// These ship with the SNR. Custom actions can be added via registry.register().

function balanceKey(token, id) { return `balance:${token}:${id}` }

export const builtins = [

  ['SET', (state, { ns = 'default', key, value }) => {
    if (!key) throw new Error('SET requires key')
    return { [`${ns}:${key}`]: value }
  }],

  ['DELETE', (state, { ns = 'default', key }) => {
    if (!key) throw new Error('DELETE requires key')
    const next = { ...state }
    delete next[`${ns}:${key}`]
    return next  // returns full state replacement for delete
  }],

  ['MINT', (state, { to, amount, token = 'credits' }) => {
    if (!to)                           throw new Error('MINT requires to')
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('MINT amount must be a positive number')
    const k = balanceKey(token, to)
    return { [k]: (state[k] ?? 0) + amount }
  }],

  ['BURN', (state, { from, amount, token = 'credits' }) => {
    if (!from)                         throw new Error('BURN requires from')
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('BURN amount must be a positive number')
    const k   = balanceKey(token, from)
    const bal = state[k] ?? 0
    if (bal < amount) throw new Error(`insufficient balance: have ${bal}, need ${amount}`)
    return { [k]: bal - amount }
  }],

  ['TRANSFER', (state, { from, to, amount, token = 'credits' }) => {
    if (!from || !to)                  throw new Error('TRANSFER requires from and to')
    if (from === to)                   throw new Error('TRANSFER: from and to must differ')
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('TRANSFER amount must be a positive number')
    const kFrom = balanceKey(token, from)
    const kTo   = balanceKey(token, to)
    const bal   = state[kFrom] ?? 0
    if (bal < amount) throw new Error(`insufficient balance: have ${bal}, need ${amount}`)
    return {
      [kFrom]: bal - amount,
      [kTo]:   (state[kTo] ?? 0) + amount,
    }
  }],

  ['REGISTER_NODE', (state, { nodeId, did, publicKeyHex, name = '' }) => {
    if (!nodeId || !did)       throw new Error('REGISTER_NODE requires nodeId and did')
    if (!publicKeyHex)         throw new Error('REGISTER_NODE requires publicKeyHex')
    return {
      [`node:${nodeId}`]: { nodeId, did, publicKeyHex, name, registeredAt: Date.now() },
    }
  }],

  ['SET_KEY', (state, { key, value }) => {
    if (!key) throw new Error('SET_KEY requires key')
    return { [key]: value }
  }],

  // ── Messaging ──────────────────────────────────────────────────────────────
  // Uses event context (3rd arg) for actor + timestamp — payload stays clean.
  // Messages stored under 'messages' key as a flat map: id → message.

  ['MESSAGE', (state, { text, to = null }, event) => {
    if (!text?.trim()) throw new Error('MESSAGE requires non-empty text')
    if (text.length > 2000) throw new Error('MESSAGE text exceeds 2000 chars')
    const existing = state['messages'] ?? {}
    return {
      messages: {
        ...existing,
        [event.id]: {
          text:      text.trim(),
          to,
          from:      event?.actor  ?? 'unknown',
          timestamp: event?.timestamp ?? Date.now(),
        }
      }
    }
  }],
]

/** Create a registry pre-loaded with all built-in actions */
export function createDefaultRegistry() {
  const r = new Registry()
  for (const [name, handler] of builtins) r.register(name, handler)
  return r
}
