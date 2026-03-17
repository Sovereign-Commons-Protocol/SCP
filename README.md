# SNR — Sovereign Node Runtime

**Built by James Brian Chapman aka XheCarpenXer**

---

A peer-to-peer, cryptographically sovereign coordination layer that runs entirely in the browser. No servers. No accounts. No central authority. Every node owns its identity, signs every action, and converges on the same truth independently.

This is not a chat app. This is not a demo. This is a protocol.

---

## What It Actually Is

Most distributed systems pick one thing to be good at:

- **Objective truth** — blockchains, databases. *What happened?*
- **Subjective trust** — social systems, reputation. *Who should I trust?*

SNR has both, cleanly separated.

**State** is objective. Deterministic. Replayable. Every node with the same event log reaches the same state, always.

**Integrity** is subjective. Local. Observational. Each node scores peers independently based on what it has personally witnessed. Those scores never enter consensus. They never corrupt the shared record. They exist only on the node that earned them.

That separation — truth vs trust — is the core of what makes this architecture rare and worth finishing.

---

## How It Works

### Identity

Every node generates an **ECDSA P-256 keypair** on first boot using the browser's native `WebCrypto` API. No library. No dependency. The public key is hashed to produce a `nodeId`. A `did:snr:<nodeId>` is derived from that. The identity is stored in IndexedDB and reloaded on every subsequent boot.

Every single event committed to the network is signed with this private key. Unsigned data is never accepted anywhere in the system.

### The Event Log

The log is append-only and hash-linked. Every event contains:

```
id         — SHA-256 hash of the event's content fields
prev       — id of the previous event (null for genesis)
seq        — monotonic index
timestamp  — unix milliseconds
actor      — nodeId of the signer
action     — registered action name
payload    — action-specific data
signature  — ECDSA signature of the canonical content
```

Nothing in the log is ever mutated or deleted. The log is the source of truth. Everything else derives from it.

### State

State is never mutated directly. It is always the result of replaying the event log through the action registry. Same log → same state, on every node, always. This is the determinism guarantee.

State is a flat key-value store. The registry defines pure functions that transform it:

```
(state, payload, event) → stateDelta
```

### The Registry

The registry is the smart contract layer. All business logic lives here and nowhere else. Built-in actions:

| Action | What it does |
|---|---|
| `SET` | Write a namespaced key-value pair |
| `DELETE` | Remove a key |
| `MINT` | Create token balance |
| `BURN` | Destroy token balance |
| `TRANSFER` | Move tokens between nodes |
| `REGISTER_NODE` | Record a node's identity and public key |
| `SET_KEY` | Write an arbitrary top-level key |
| `MESSAGE` | Send a signed message to the network or a peer |

Custom actions can be registered at runtime via `kernel.registerAction()`.

### Messaging

Messages are first-class events. They are signed, appended to the log, replayed deterministically, and propagated across peers like any other action. A message is not ephemeral. It is a permanent, verifiable, replayable record.

Message payload:
```js
{ text: string, to: nodeId | null }
```

`to: null` is a broadcast. `to: nodeId` is a direct message — still propagated to all peers, but addressed.

The sender's `actor` and `timestamp` come from the event envelope, not the payload. Registry handlers stay pure.

### Integrity

Integrity is a local observation system. It is never part of consensus. It is never stored in the event log. It is never replayed.

Every time an event passes validation, the sending node's valid count increments. Every time an event fails, the invalid count increments. The score is:

```js
score = Math.round((valid / total) * 100)
// 50 = no data (neutral baseline)
```

This score is stored in memory. It exists only on the node that computed it. Two nodes watching the same peer will compute different integrity scores if they observed different behavior — and that is correct. Trust is subjective. It is earned locally, not declared globally.

### Trust-Weighted Filtering

The kernel has a configurable `trustThreshold` (default: 30). Incoming `MESSAGE` events from nodes whose integrity score falls below this threshold are tagged `lowTrust: true` in state before rendering.

**Critically: the event is never rejected. The log always stores the original, unmodified event.** The annotation exists only in state — it affects how the UI presents the message, not whether the truth record contains it. Other nodes see nothing. This is your local policy, running silently on your node only.

The threshold is adjustable live from the Integrity panel. Set it to 0 to disable filtering entirely.

### Network

Three transports, in priority order:

1. **Service Worker** — same origin, survives tab close, zero-copy relay
2. **BroadcastChannel** — same browser, instant fallback, no SW required
3. **WebRTC DataChannels** — real P2P across browsers and devices

Auto-discovery works across tabs in the same browser with no configuration. Cross-device connections use manual SDP exchange — copy an offer string, send it out-of-band, paste the answer back. No relay server. No signaling server. Nothing in the middle.

Gossip propagation with TTL ensures events reach the full mesh even when nodes aren't directly connected.

### Storage

Everything that matters persists in **IndexedDB**:

- The full event log (append-only, keyed by `id`)
- The node's identity (public key + private key bytes)
- State snapshots (optional, for fast boot)

On every boot, the log is replayed in sequence order to rebuild state from scratch. This is the replayability guarantee.

---

## File Structure

```
index.html      — the entire UI. one file. no bundler. no build step.
kernel.js       — the only orchestration point. wires all layers together.
identity.js     — WebCrypto key generation, signing, verification
log.js          — append-only hash-linked event log
state.js        — deterministic state projection
registry.js     — pure action handlers (the business logic layer)
consensus.js    — event validation + fork resolution
integrity.js    — local-observed integrity scores
network.js      — BroadcastChannel + Service Worker + WebRTC transport
storage.js      — IndexedDB persistence
emitter.js      — internal event bus
```

No build step. No bundler. No framework. Open `index.html` in a browser that serves it over HTTP and it runs. The module graph is resolved natively by the browser.

> **Note:** Must be served over HTTP/HTTPS, not opened as a `file://` URL. The Service Worker transport requires a valid origin. Use any static file server — `npx serve .` works fine.

---

## Running It

```bash
cd YHWH
npx serve .
# open http://localhost:3000 in two or more tabs
```

On first load each tab generates a fresh identity and writes a genesis event. Tabs on the same browser auto-discover each other via BroadcastChannel and connect over WebRTC DataChannels. You will see peers appear in the Network panel within seconds.

---

## The Multi-Tab Test

This is the test that matters. Everything before this is theory.

Open three tabs.

**Consistency test:** Send messages from each tab. Navigate to State on all three. The `messages` object should be identical across every tab. Same keys. Same values. Same order. If it is, determinism is working.

**Integrity divergence test:** Open the browser console on one tab and inject a malformed event:

```js
NODE.network.broadcast({ type: 'EVENT', payload: {
  id: 'fake', prev: null, seq: 999,
  timestamp: Date.now(), actor: NODE.identity.nodeId,
  action: 'SET', payload: { key: 'x', value: 'y' },
  signature: 'invalidsignature'
}})
```

On the tabs that receive this: state is unchanged (invalid event rejected), but the integrity score for that nodeId drops. On the tab that sent it: nothing changes (it didn't validate its own injected payload through the inbound pipeline). 

**Result:** Same state across all nodes. Different integrity scores per node. Truth is objective. Trust is subjective. That is the goal.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` in message box | Send message |
| `Ctrl+Enter` in message box | Send message |
| `Ctrl+Enter` anywhere else | Commit the current action form |

---

## Panels

**Node** — Identity info, boot log, manual action commit form

**Network** — Peer connections, auto-discovery controls, manual SDP exchange for cross-device connections

**Messages** — Signed message feed with trust badges. Low-trust messages are visually dimmed but never hidden.

**Integrity** — Per-node integrity scores with live threshold slider. Scores are memory-only and reset on page reload.

**Log** — The raw event log. Chain verification. JSON export.

**State** — Full state snapshot derived from the log. Key lookup.

**Consensus** — Manual event validation tool. Validated/rejected counters.

**Storage** — IndexedDB ledger view, snapshot controls, identity management.

---

## Architecture Invariants

These are properties the system enforces at every layer. They are not aspirational — they are structural.

1. **Determinism** — Same log → same state, on every node, always
2. **Sovereignty** — A node can run alone, owns its identity, and can fully reconstruct state from its local log
3. **Append-only** — Nothing is mutated after write. Only extended.
4. **Verifiable** — Every action is signed by its actor and validated before entering the log
5. **Layer isolation** — No layer touches another's internals. Kernel is the only wiring point.
6. **Replay safety** — Integrity is never a function of the event log. It cannot be corrupted by replaying old events.

---

## What This Enables

Because identity is a keypair and not a "person," and because integrity is behavioral and not identity-based, the following become natural extensions of what already exists:

**Trust-weighted networks without central authority.** Each node can decide: accept this event only if `integrity(actor) > threshold`. No admin. No global ban list. Trust emerges from behavior.

**Human and agent coexistence.** An AI agent with a keypair participates in this network identically to a human node. It earns trust or loses it through its actions. Nothing in the protocol distinguishes them.

**Self-healing networks.** Bad actors don't need to be banned. They naturally lose influence as their integrity scores decay across the nodes that witnessed their behavior. Good actors gain weight automatically.

**A foundation for decentralized social infrastructure.** Messaging + identity + integrity is the irreducible core of social networks, marketplaces, and coordination systems. This is that core.

---

## What Comes Next

The protocol is correct. The foundation holds. What hasn't been built yet:

- **Integrity persistence** — scores reset on reload. Safe to persist to IDB with careful handling to avoid poisoning the integrity system with stale data.
- **Peer-weighted trust** — currently each observation counts equally. Future: weight by the observer's own integrity score.
- **Agent integration** — register agents as nodes with their own keypairs. Wire their commit/receive loop to an inference layer.
- **Off-chain message storage** — messages currently live in core state. For scale, they belong in a side-log or CRDT structure that doesn't block consensus replay.
- **BFT quorum** — phase 2 consensus. Currently: longest-chain + signature validity. Future: quorum-based agreement for high-stakes actions.

---

*A sovereign coordination layer for humans and agents.*

*— James Brian Chapman aka XheCarpenXer*
