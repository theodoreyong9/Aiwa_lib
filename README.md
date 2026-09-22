# aiwa-lib

A generic, signature-agnostic, content-addressed event DAG plus a dual-mode
P2P transport layer. The shared foundation `aiwa-core`, `aiwa-platform`, and
the YourMine stack build on — not an application in its own right.

## What's here

- **`event-dag.js`** — `EventDag`: a grow-only DAG of content-addressed
  events (`id = sha256(canonicalize(parents, payload))`). No global clock, no
  signatures, no opinion on what a payload means. `merge()` is a pure
  commutative set union, so two DAGs built independently and merged in either
  order converge to the same state. `materialize(reducer, initialState)`
  folds over a deterministic topological order. `subscribe(callback)` fires
  once per genuinely new event, for live-updating UIs or relaying to peers.
- **`weighted-median.js`** — `weightedMedian(estimates)`: the anti-Sybil
  primitive used to combine independent estimates (a timestamp, a rate, a
  price) weighted by stake/trust/whatever the caller defines, such that a
  minority of adversarial weight can't pull the result past the honest
  majority.
- **`reconciliation.js`** — `mergeEvents(dag, rawEvents)` replays a raw wire
  event list into a DAG in parents-before-children order, **never trusting a
  wire-provided id** — every event is re-added through `dag.addEvent()` so
  its id is recomputed locally. An event whose parent never arrived is
  skipped, not thrown. `exportHistory`/`importHistory` round-trip a DAG
  through a tagged JSON snapshot (`aiwa-lib-export-v1`).
- **`sync-protocol.js`** — `attachSyncProtocol(dag, channel, onSyncEvent)`:
  wires a DAG to any duck-typed `{send, onMessage}` channel — sends the full
  history on attach, subscribes to relay new local events, merges anything
  received. Transport-agnostic by design.
- **`transport/trystero-room.js`** — `joinRoom(...)` / `RoomRegistry`: a
  relay-discovered room, one `send`/multiple independent `onMessage`
  listeners (a Trystero room action only exposes a single overwritable
  handler; a `Set` of listeners here, each optionally scoped to one peer via
  `channelTo(peerId)`, fixes that without callers stepping on each other).
  `RoomRegistry` refcounts a shared room per `(appId, roomId)` key so
  multiple independent consumers in the same process can join once.
- **`transport/manual-webrtc.js`** + **`transport/signaling-codec.js`** — a
  relay-free fallback: raw WebRTC with a hand-copied offer/answer exchange.
  `ManualConnection` only opens a channel; it hands the opened
  `{send, onMessage}` to the caller via `onChannelOpen` rather than assuming
  what to do with it.

## Why the transport is two composable pieces, not one opinionated pattern

Two P2P usage patterns already exist across this portfolio:

1. **Full DAG sync on connect** — join a channel, immediately exchange and
   merge complete history, then live-relay new events (`sync-protocol.js`
   attached to a channel).
2. **Point-to-point routing with no DAG at all** — send and receive
   application messages addressed to specific peers, with nothing being
   synced or merged.

Rather than pick one and force the other to fit, the room/channel layer
(`trystero-room.js`, `manual-webrtc.js`) only opens connections and exposes
`send`/`onMessage`. Whether a DAG rides on top is the caller's decision,
made per channel by optionally calling `attachSyncProtocol(dag, channel)` —
or not.

## Why `reconciliation.js` doesn't include reception commitments

The original source this was ported from also signs a receipt for imported
events (`buildReceptionCommitment`/`canonicalReceptionMessage`). That's
Ed25519-specific and belongs to a concrete identity model, not a generic
library — it stays out of `aiwa-lib` and moves to `aiwa-core`, which is
where this portfolio's canonical identity model lives.

## Honest limits

`transport/trystero-room.js` and `transport/manual-webrtc.js` need a real
browser (`RTCPeerConnection`, a Trystero relay) to exercise end to end —
there's no meaningful Node-side simulation of a WebRTC handshake, so they
have no unit tests here. `event-dag.js`, `weighted-median.js`, and
`reconciliation.js` are pure and fully covered by `node --test`.

## Status

Pre-publish. This is a plain git dependency for now — `aiwa-core` and the
rest of the stack pull it by path/git URL. npm publication is a later step.

## Testing

```
node --test
```
