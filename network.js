/**
 * network.js
 * Transport layer — moves bytes between peers. No logic. No state.
 *
 * Three transports (priority order):
 *   1. Service Worker     — same origin, survives tab close, zero latency
 *   2. BroadcastChannel   — same browser, instant fallback
 *   3. WebRTC DataChannel — real P2P across browsers/devices
 *
 * Manual SDP path (cross-device, no relay server):
 *   createOffer()  → send offer string to peer out-of-band
 *   acceptOffer()  → peer gets answer string
 *   acceptAnswer() → connection finalises
 *
 * Message format (all transport layers):
 *   { type, from, id, payload, ttl?, ts }
 *
 * Invariants:
 *   - Network NEVER interprets payload or mutates state
 *   - Messages > 64 KB are dropped silently
 *   - Duplicate message ids are dropped (seen-set, max 2 000)
 *   - Kernel handles all signature verification above this layer
 */

import { Emitter } from './emitter.js'

const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
const MAX_MSG_BYTES = 65_536
const SEEN_MAX      = 2_000
const PING_INTERVAL = 15_000
const PEER_TIMEOUT  = 45_000

// ── Embedded Service Worker source ───────────────────────────────────────
// Injected as a Blob URL — no separate .js file required.

const SW_SRC = /* sw */ `
const reg = new Map() // clientId → { nodeId, name }
let routed = 0
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
async function clients() { return self.clients.matchAll({ type: 'window', includeUncontrolled: true }) }
async function prune() {
  const live = await clients()
  const ids  = new Set(live.map(c => c.id))
  for (const [cid, info] of reg)
    if (!ids.has(cid)) { reg.delete(cid); live.forEach(c => c.postMessage({ type: 'PEER_LEFT', nodeId: info.nodeId })) }
}
self.addEventListener('message', async e => {
  if (!e.source) return
  const cid = e.source.id, m = e.data
  if (!m) return
  if (m.type === 'ANNOUNCE') {
    await prune()
    reg.set(cid, { nodeId: m.nodeId, name: m.name ?? '?' })
    const all   = await clients()
    const peers = []
    for (const [id, info] of reg) if (id !== cid) peers.push({ clientId: id, ...info })
    e.source.postMessage({ type: 'REGISTRY', peers, routed })
    all.forEach(c => { if (c.id !== cid) { c.postMessage({ type: 'PEER_JOINED', clientId: cid, nodeId: m.nodeId, name: m.name ?? '?' }); routed++ } })
  } else if (m.type === 'LEAVE') {
    const info = reg.get(cid); reg.delete(cid)
    if (info) { const all = await clients(); all.forEach(c => { c.postMessage({ type: 'PEER_LEFT', nodeId: info.nodeId }); routed++ }) }
  } else if (m.type === 'PING') {
    await prune()
    const all   = await clients()
    const peers = []
    for (const [id, info] of reg) if (id !== cid) peers.push({ clientId: id, ...info })
    e.source.postMessage({ type: 'PONG', registered: reg.size, routed, peers })
  } else if (m.to) {
    const all    = await clients()
    const target = all.find(c => c.id === m.to)
    if (target) { target.postMessage({ ...m, fromClientId: cid }); routed++ }
    else e.source.postMessage({ type: 'RELAY_FAIL', to: m.to })
  }
})
`

// ── Peer record ───────────────────────────────────────────────────────────

function makePeer(nodeId, name = '?') {
  return { nodeId, name, pc: null, dc: null, state: 'connecting',
           bytesTX: 0, bytesRX: 0, lastPong: Date.now(), latency: null }
}

// ═══════════════════════════════════════════════════════════════════════════

export class Network extends Emitter {
  #nodeId   = null
  #nodeName = null

  // Transport handles
  #bc       = null  // BroadcastChannel
  #sw       = null  // ServiceWorkerRegistration
  #swReady  = false

  // Peers: nodeId → peer
  #peers    = new Map()
  // Seen message ids (dedup)
  #seen     = new Set()

  // Pending manual SDP sessions: sessionId → { pc, peer }
  #pending  = new Map()

  // ── Init ──────────────────────────────────────────────────────────────────

  async init({ nodeId, name = '?' }) {
    this.#nodeId   = nodeId
    this.#nodeName = name

    this.#initBC()

    if (location.protocol !== 'file:' && 'serviceWorker' in navigator)
      await this.#initSW().catch(e => this._log('warn', 'SW', e.message))

    window.addEventListener('beforeunload', () => this.destroy())
    this._log('ok', 'NETWORK', 'ready — nodeId: ' + nodeId.slice(0, 16) + '…')
  }

  // ── BroadcastChannel ─────────────────────────────────────────────────────

  #initBC() {
    if (typeof BroadcastChannel === 'undefined') return
    this.#bc = new BroadcastChannel('snr-net-v1')
    this.#bc.onmessage = e => this.#handleSignal(e.data)
    setTimeout(() => this.#announce(), 400)
    setInterval(() => this.#bc?.postMessage({ type: 'PING', from: this.#nodeId }), 5_000)
  }

  // ── Service Worker ────────────────────────────────────────────────────────

  async #initSW() {
    const blob = new Blob([SW_SRC], { type: 'application/javascript' })
    const url  = URL.createObjectURL(blob)
    this.#sw   = await navigator.serviceWorker.register(url, { scope: './' })
    await navigator.serviceWorker.ready
    this.#swReady = true
    navigator.serviceWorker.addEventListener('message', e => this.#onSWMsg(e.data))
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (this.#nodeId) this.#swAnnounce()
    })
    this.#swAnnounce()
    URL.revokeObjectURL(url)
    this._log('ok', 'SW', 'kernel active')
  }

  #swAnnounce() {
    if (this.#swReady && navigator.serviceWorker?.controller)
      navigator.serviceWorker.controller.postMessage({
        type: 'ANNOUNCE', nodeId: this.#nodeId, name: this.#nodeName
      })
  }

  #announce() {
    this.#swAnnounce()
    this.#bc?.postMessage({ type: 'ANNOUNCE', from: this.#nodeId, name: this.#nodeName })
  }

  #onSWMsg(m) {
    if (!m) return
    if (m.type === 'PONG' || m.type === 'REGISTRY') {
      for (const p of (m.peers ?? []))
        if (p.nodeId !== this.#nodeId && !this.#peers.has(p.nodeId))
          this.#initRTC(p.nodeId, p.clientId, p.name)
      this.emit('swReady', { peers: m.peers?.length ?? 0 })
    } else if (m.type === 'PEER_JOINED') {
      if (m.nodeId !== this.#nodeId && !this.#peers.has(m.nodeId))
        this.#initRTC(m.nodeId, m.clientId, m.name)
    } else if (m.type === 'PEER_LEFT') {
      this.#dropPeer(m.nodeId)
    } else if (m.type === 'OFFER')  { this.#handleOffer(m)  }
      else if (m.type === 'ANSWER') { this.#handleAnswer(m) }
      else if (m.type === 'ICE')    { this.#handleICE(m)    }
  }

  // ── Signal routing (BC → same handler) ───────────────────────────────────

  #handleSignal(sig) {
    if (!sig?.type || sig.from === this.#nodeId) return
    if (sig.type === 'ANNOUNCE' || sig.type === 'PING') {
      const did = sig.from
      if (did && did !== this.#nodeId && !this.#peers.has(did))
        this.#initRTC(did, null, sig.name)
      return
    }
    if (sig.to !== this.#nodeId) return
    if (sig.type === 'OFFER')  this.#handleOffer(sig)
    if (sig.type === 'ANSWER') this.#handleAnswer(sig)
    if (sig.type === 'ICE')    this.#handleICE(sig)
  }

  // ── WebRTC initiation (we send offer) ────────────────────────────────────

  async #initRTC(targetNodeId, clientId = null, name = '?') {
    if (this.#peers.has(targetNodeId) || this.#peers.size >= 16) return
    const peer = makePeer(targetNodeId, name)
    const pc   = new RTCPeerConnection(STUN)
    peer.pc = pc
    this.#peers.set(targetNodeId, peer)

    const dc = pc.createDataChannel('snr', { ordered: false, maxRetransmits: 2 })
    this.#setupDC(peer, dc)
    this.#setupPC(peer, pc, targetNodeId, clientId)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await this.#waitICE(pc)

    this.#sendSignal({
      type: 'OFFER', from: this.#nodeId,
      to: clientId ?? targetNodeId, toNodeId: targetNodeId,
      name: this.#nodeName,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    }, clientId ?? targetNodeId)
    this._log('TX', 'OFFER', targetNodeId.slice(0, 14))
  }

  // ── WebRTC: handle incoming offer (peer sends offer, we answer) ──────────

  async #handleOffer(m) {
    const nodeId = m.from
    if (this.#peers.get(nodeId)?.state === 'open') return
    const peer = makePeer(nodeId, m.name ?? '?')
    const pc   = new RTCPeerConnection(STUN)
    peer.pc = pc
    this.#peers.set(nodeId, peer)
    pc.ondatachannel = e => this.#setupDC(peer, e.channel)
    this.#setupPC(peer, pc, nodeId, m.fromClientId ?? null)
    await pc.setRemoteDescription(m.sdp)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await this.#waitICE(pc)
    this.#sendSignal({
      type: 'ANSWER', from: this.#nodeId,
      to: m.fromClientId ?? nodeId, toNodeId: nodeId,
      name: this.#nodeName,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    }, m.fromClientId ?? nodeId)
    this._log('TX', 'ANSWER', nodeId.slice(0, 14))
  }

  async #handleAnswer(m) {
    const peer = this.#peers.get(m.from) ??
      [...this.#peers.values()].find(p => p._sessionId === m.sessionId)
    if (!peer) return
    await peer.pc.setRemoteDescription(m.sdp).catch(() => {})
    this._log('RX', 'ANSWER', m.from.slice(0, 14))
  }

  async #handleICE(m) {
    const peer = this.#peers.get(m.from)
    if (!peer || !m.candidate) return
    peer.pc.addIceCandidate(m.candidate).catch(() => {})
  }

  // ── PC lifecycle ──────────────────────────────────────────────────────────

  #setupPC(peer, pc, nodeId, clientId) {
    pc.onicecandidate = e => {
      if (!e.candidate) return
      this.#sendSignal({
        type: 'ICE', from: this.#nodeId,
        to: clientId ?? nodeId, toNodeId: nodeId, candidate: e.candidate,
      }, clientId ?? nodeId)
    }
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState
      if (pc.connectionState === 'connected') {
        this._log('CONN', 'OPEN', nodeId.slice(0, 16))
        this.emit('connect', { nodeId, name: peer.name })
        this.emit('peers', this.#peerList())
        this.#heartbeat(peer)
        // Identity handshake over data channel
        this.#sendToPeer(peer, {
          type: 'HANDSHAKE', from: this.#nodeId, name: this.#nodeName,
          id: 'hs:' + Date.now(),
        })
      }
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')
        this.#dropPeer(nodeId)
      this.emit('peers', this.#peerList())
    }
  }

  // ── DataChannel lifecycle ─────────────────────────────────────────────────

  #setupDC(peer, dc) {
    peer.dc = dc
    dc.onopen  = () => { peer.state = 'open'; this.emit('peers', this.#peerList()) }
    dc.onclose = () => this.#dropPeer(peer.nodeId)
    dc.onmessage = e => {
      if (e.data.length > MAX_MSG_BYTES) {
        this._log('DROP', 'SIZE', peer.nodeId.slice(0, 14)); return
      }
      peer.bytesRX += e.data.length
      try { this.#onMsg(JSON.parse(e.data), peer) } catch {}
    }
  }

  // ── Incoming message handling ─────────────────────────────────────────────

  #onMsg(msg, fromPeer) {
    // Dedup
    if (msg.id) {
      if (this.#seen.has(msg.id)) return
      this.#seen.add(msg.id)
      if (this.#seen.size > SEEN_MAX) {
        const arr = [...this.#seen]
        for (let i = 0; i < 400; i++) this.#seen.delete(arr[i])
      }
    }

    // System messages — handled here, not passed up
    if (msg.type === 'PING') {
      this.#sendToPeer(fromPeer, { type: 'PONG', from: this.#nodeId, pingTs: msg.pingTs, id: 'pong:' + Date.now() })
      return
    }
    if (msg.type === 'PONG') {
      fromPeer.lastPong = Date.now()
      if (msg.pingTs) fromPeer.latency = Date.now() - msg.pingTs
      this.emit('peers', this.#peerList())
      return
    }
    if (msg.type === 'HANDSHAKE') {
      fromPeer.name = msg.name ?? '?'
      this.emit('peers', this.#peerList())
      return
    }

    this._log('RX', msg.type, fromPeer.nodeId.slice(0, 14))

    // Deliver to Kernel
    this.emit('message', msg)

    // Gossip relay (TTL-based)
    if (msg.ttl && msg.ttl > 0)
      this.broadcastRaw({ ...msg, ttl: msg.ttl - 1 }, fromPeer.nodeId)
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  #heartbeat(peer) {
    const iv = setInterval(() => {
      if (!this.#peers.has(peer.nodeId)) { clearInterval(iv); return }
      const now = Date.now()
      this.#sendToPeer(peer, { type: 'PING', from: this.#nodeId, pingTs: now, id: 'ping:' + now })
      if (now - peer.lastPong > PEER_TIMEOUT) { this.#dropPeer(peer.nodeId); clearInterval(iv) }
    }, PING_INTERVAL)
  }

  // ── Drop peer ─────────────────────────────────────────────────────────────

  #dropPeer(nodeId) {
    const p = this.#peers.get(nodeId)
    if (!p) return
    try { p.pc?.close() } catch {}
    this.#peers.delete(nodeId)
    this._log('CONN', 'CLOSED', nodeId.slice(0, 14))
    this.emit('disconnect', { nodeId })
    this.emit('peers', this.#peerList())
  }

  // ── ICE gathering wait ────────────────────────────────────────────────────

  #waitICE(pc, ms = 4000) {
    return new Promise(r => {
      if (pc.iceGatheringState === 'complete') { r(); return }
      const t = setTimeout(r, ms)
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); r() }
      })
    })
  }

  // ── Send helpers ──────────────────────────────────────────────────────────

  #sendToPeer(peer, msg) {
    if (peer.dc?.readyState !== 'open') return false
    try {
      const s = JSON.stringify(msg)
      peer.dc.send(s); peer.bytesTX += s.length
      return true
    } catch { return false }
  }

  /** Broadcast raw message to all open peers except one */
  broadcastRaw(msg, excludeId = null) {
    let n = 0
    for (const p of this.#peers.values())
      if (p.nodeId !== excludeId && p.state === 'open')
        if (this.#sendToPeer(p, msg)) n++
    return n
  }

  /** Broadcast a message: auto-stamps id, from, ts, ttl */
  broadcast(msg) {
    const full = {
      ...msg,
      id:   msg.id ?? ('m:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 5)),
      from: this.#nodeId,
      ts:   Date.now(),
      ttl:  msg.ttl ?? 6,
    }
    this.#seen.add(full.id)
    const n = this.broadcastRaw(full)
    if (n > 0) this._log('TX', msg.type, `→ ${n} peers`)
    return n
  }

  /** Send a signal through SW (if available) or BroadcastChannel */
  #sendSignal(msg, to) {
    if (this.#swReady && navigator.serviceWorker?.controller)
      navigator.serviceWorker.controller.postMessage(msg)
    else
      this.#bc?.postMessage(msg)
  }

  // ── Public send ───────────────────────────────────────────────────────────

  send(nodeId, msg) {
    const peer = this.#peers.get(nodeId)
    if (!peer) return false
    return this.#sendToPeer(peer, msg)
  }

  // ── Manual SDP (cross-device, no relay server) ────────────────────────────

  async createOffer() {
    const sessionId = 'manual:' + Date.now().toString(36)
    const pc    = new RTCPeerConnection(STUN)
    const peer  = makePeer(sessionId, 'manual-pending')
    peer.pc = pc; peer._sessionId = sessionId
    this.#peers.set(sessionId, peer)
    const dc = pc.createDataChannel('snr', { ordered: false, maxRetransmits: 2 })
    this.#setupDC(peer, dc)
    this.#setupPC(peer, pc, sessionId, null)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await this.#waitICE(pc)
    return JSON.stringify({
      _snr: true, sessionId, from: this.#nodeId, name: this.#nodeName,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    })
  }

  async acceptOffer(offerStr) {
    const data = JSON.parse(offerStr)
    if (!data._snr) throw new Error('not a valid SNR offer')
    const pc   = new RTCPeerConnection(STUN)
    const peer = makePeer(data.from, data.name ?? '?')
    peer.pc = pc; peer._sessionId = data.sessionId
    this.#peers.set(data.from, peer)
    pc.ondatachannel = e => this.#setupDC(peer, e.channel)
    this.#setupPC(peer, pc, data.from, null)
    await pc.setRemoteDescription(data.sdp)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await this.#waitICE(pc)
    return JSON.stringify({
      _snrAnswer: true, sessionId: data.sessionId,
      from: this.#nodeId, to: data.from, name: this.#nodeName,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    })
  }

  async acceptAnswer(answerStr) {
    const data = JSON.parse(answerStr)
    if (!data._snrAnswer) throw new Error('not a valid SNR answer')
    // Find peer by nodeId or session
    const peer = this.#peers.get(data.from)
      ?? [...this.#peers.values()].find(p => p._sessionId === data.sessionId)
    if (!peer) throw new Error('no matching peer — create offer first')
    // Re-key if needed
    if (peer.nodeId !== data.from) {
      this.#peers.delete(peer.nodeId)
      peer.nodeId = data.from
      this.#peers.set(data.from, peer)
    }
    await peer.pc.setRemoteDescription(data.sdp)
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  #peerList() {
    return [...this.#peers.values()].map(p => ({
      nodeId:  p.nodeId, name: p.name, state: p.state,
      bytesTX: p.bytesTX, bytesRX: p.bytesRX, latency: p.latency,
    }))
  }

  getPeers()   { return this.#peerList() }
  peerCount()  { return [...this.#peers.values()].filter(p => p.state === 'open').length }
  isSwReady()  { return this.#swReady }

  // ── Internal log (emits 'log' for UI) ────────────────────────────────────
  _log(dir, type, info) { this.emit('log', { dir, type, info }) }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    if (this.#swReady && navigator.serviceWorker?.controller)
      navigator.serviceWorker.controller.postMessage({ type: 'LEAVE', nodeId: this.#nodeId })
    this.#bc?.postMessage({ type: 'PEER_LEFT', nodeId: this.#nodeId })
    this.#bc?.close()
    for (const p of this.#peers.values()) try { p.pc?.close() } catch {}
    this.#peers.clear()
  }
}
