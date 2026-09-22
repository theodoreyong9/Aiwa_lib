// A thin, generic wrapper around a Trystero room: automatic peer
// discovery (Nostr relays by default), a broadcast/targeted send, and a
// message dispatcher that supports any number of independent listeners
// — not the single, shared `onMessage` Trystero's own `action` object
// exposes, which silently drops a previous listener the moment a second
// one is registered on the same action. `channelTo(peerId)` adapts that
// into sync-protocol.js's `{send, onMessage}` shape, scoped to one peer,
// for attaching a DAG sync per connection; `onMessage`/`send` used
// directly instead give plain point-to-point message routing with no
// DAG involved at all — both are the same underlying room.
//
// Loads `trystero` lazily (dynamic import) so a CDN hiccup only disables
// P2P, not whatever else imports this module.

export async function joinRoom({ appId, roomId, relayUrls, actionName = 'sync' }) {
  const { joinRoom: trysteroJoinRoom } = await import('trystero');
  const room = trysteroJoinRoom(relayUrls ? { appId, relayUrls } : { appId }, roomId);
  const action = room.makeAction(actionName);

  const peers = new Set();
  const messageListeners = new Set(); // cb(payload, peerId)
  const joinListeners = new Set();    // cb(peerId)
  const leaveListeners = new Set();   // cb(peerId)

  action.onMessage = (payload, meta) => {
    for (const cb of messageListeners) cb(payload, meta.peerId);
  };

  room.onPeerJoin((peerId) => {
    peers.add(peerId);
    for (const cb of joinListeners) cb(peerId);
  });

  room.onPeerLeave((peerId) => {
    peers.delete(peerId);
    for (const cb of leaveListeners) cb(peerId);
  });

  const handle = {
    send(payload, targetPeerId) {
      action.send(payload, targetPeerId ? { target: targetPeerId } : undefined);
    },
    onMessage(cb) {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    // Replays already-connected peers to a newly-registered listener —
    // a listener attached after some peers already joined still learns
    // about them, the same as one attached from the start would.
    onPeerJoin(cb) {
      joinListeners.add(cb);
      for (const peerId of peers) cb(peerId);
      return () => joinListeners.delete(cb);
    },
    onPeerLeave(cb) {
      leaveListeners.add(cb);
      return () => leaveListeners.delete(cb);
    },
    peerIds() {
      return [...peers];
    },
    channelTo(peerId) {
      return {
        send: (message) => handle.send(message, peerId),
        onMessage: (cb) => handle.onMessage((payload, fromPeerId) => {
          if (fromPeerId === peerId) cb(payload);
        }),
      };
    },
    leave() {
      room.leave();
    },
  };
  return handle;
}

// Most apps want one real Trystero room per (appId, roomId), shared by
// every independent consumer that needs it (several local identities in
// the same namespace, several features riding the same connection) —
// joining twice would just mint a second, redundant connection. This
// keeps exactly one `joinRoom()` per key alive for as long as at least
// one named consumer is still registered, and only actually leaves once
// the last one detaches.
export class RoomRegistry {
  constructor() {
    this._entries = new Map(); // key -> { handle, consumers: Set<string>, joinPromise }
  }

  _key(appId, roomId) {
    return `${appId}\u0000${roomId}`;
  }

  // Returns the shared room handle for (appId, roomId), joining it if
  // this is the first consumer to ask for it. `consumerId` is any
  // string identifying the caller (an identity id, a feature name) —
  // the room is only actually left once every consumerId registered
  // against it has called `release()`.
  async acquire({ appId, roomId, relayUrls, actionName }, consumerId) {
    const key = this._key(appId, roomId);
    let entry = this._entries.get(key);
    if (!entry) {
      entry = { consumers: new Set(), joinPromise: joinRoom({ appId, roomId, relayUrls, actionName }) };
      this._entries.set(key, entry);
    }
    entry.consumers.add(consumerId);
    return entry.joinPromise;
  }

  async release(appId, roomId, consumerId) {
    const key = this._key(appId, roomId);
    const entry = this._entries.get(key);
    if (!entry) return;
    entry.consumers.delete(consumerId);
    if (entry.consumers.size === 0) {
      this._entries.delete(key);
      const handle = await entry.joinPromise;
      handle.leave();
    }
  }
}
