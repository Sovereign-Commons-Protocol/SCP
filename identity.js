/**
 * identity.js
 * Cryptographic identity — WebCrypto only, zero external deps.
 *
 * Strategy:
 *   Primary  → ECDSA P-256   (universal browser support)
 *   Fallback → same (P-256 is the floor, not the ceiling)
 *
 * Identity shape:
 *   {
 *     nodeId     : string   — hex(SHA-256(spki pubkey))
 *     did        : string   — "did:snr:<nodeId>"
 *     algo       : string   — "ECDSA-P256"
 *     publicKey  : Uint8Array  (SPKI raw export)
 *     privateKey : Uint8Array  (PKCS8 raw export)
 *     _pub       : CryptoKey   (in-memory, not exported)
 *     _priv      : CryptoKey   (in-memory, not exported)
 *     createdAt  : number
 *   }
 *
 * Invariant: no unsigned data is ever accepted anywhere in the system.
 */

// ── Encoding ──────────────────────────────────────────────────────────────

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// ── SHA-256 ───────────────────────────────────────────────────────────────

export async function sha256(input) {
  const data = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : input instanceof Uint8Array ? input : new Uint8Array(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(buf)
}

export async function sha256hex(input) {
  return bytesToHex(await sha256(input))
}

// ── Key generation ────────────────────────────────────────────────────────

const ALGO = { name: 'ECDSA', namedCurve: 'P-256' }

export class Identity {
  // Static factory — the only way to create an Identity
  static async generate() {
    const kp = await crypto.subtle.generateKey(ALGO, true, ['sign', 'verify'])
    return Identity._fromCryptoKeyPair(kp)
  }

  // ── Re-hydrate from stored bytes ─────────────────────────────────────────
  static async fromBytes(publicKeyBytes, privateKeyBytes) {
    const [_pub, _priv] = await Promise.all([
      crypto.subtle.importKey('spki',  publicKeyBytes,  ALGO, true, ['verify']),
      crypto.subtle.importKey('pkcs8', privateKeyBytes, ALGO, true, ['sign']),
    ])
    return Identity._build(publicKeyBytes, privateKeyBytes, _pub, _priv)
  }

  // ── Internal builder ─────────────────────────────────────────────────────
  static async _fromCryptoKeyPair(kp) {
    const [spki, pkcs8] = await Promise.all([
      crypto.subtle.exportKey('spki',  kp.publicKey),
      crypto.subtle.exportKey('pkcs8', kp.privateKey),
    ])
    return Identity._build(new Uint8Array(spki), new Uint8Array(pkcs8), kp.publicKey, kp.privateKey)
  }

  static async _build(publicKey, privateKey, _pub, _priv) {
    const nodeId = await sha256hex(publicKey)
    return Object.freeze({
      nodeId,
      did:        `did:snr:${nodeId}`,
      algo:       'ECDSA-P256',
      publicKey,   // Uint8Array — safe to share/store
      privateKey,  // Uint8Array — store encrypted in prod
      _pub,        // CryptoKey  — ephemeral, in-memory only
      _priv,       // CryptoKey  — ephemeral, in-memory only
      createdAt:  Date.now(),
    })
  }

  // ── Sign ─────────────────────────────────────────────────────────────────

  /**
   * Sign arbitrary data with the identity's private key.
   * Accepts: string | Uint8Array | object (will be JSON-stringified)
   * Returns: hex string
   */
  static async sign(data, identity) {
    const bytes = _toBytes(data)
    const sig   = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      identity._priv,
      bytes
    )
    return bytesToHex(new Uint8Array(sig))
  }

  // ── Verify ────────────────────────────────────────────────────────────────

  /**
   * Verify a signature against a public key.
   * publicKey: Uint8Array | hex string | CryptoKey
   * signature: hex string | Uint8Array
   */
  static async verify(data, signature, publicKey) {
    const bytes  = _toBytes(data)
    const sigBuf = typeof signature === 'string' ? hexToBytes(signature) : signature
    let cryptoKey = publicKey
    if (!(publicKey instanceof CryptoKey)) {
      const raw = typeof publicKey === 'string' ? hexToBytes(publicKey) : publicKey
      cryptoKey = await crypto.subtle.importKey('spki', raw, ALGO, false, ['verify'])
    }
    try {
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        cryptoKey,
        sigBuf,
        bytes
      )
    } catch {
      return false
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────

function _toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (typeof data === 'string')   return new TextEncoder().encode(data)
  return new TextEncoder().encode(JSON.stringify(data))
}
