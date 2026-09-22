// Full-sync on connect, live relay of new events, real verification via
// mergeEvents() on receipt — entirely independent of how two peers came
// to have an open channel between them. Manual WebRTC handshake,
// automatic Trystero discovery, a future transport: all of them just
// need to provide a way to send and receive JS objects. This is that
// one shared, transport-agnostic protocol, attached once per open
// channel.

import { mergeEvents } from './reconciliation.js';

/**
 * @param {import('./event-dag.js').EventDag} dag
 * @param {{ send: (message: object) => void, onMessage: (cb: (message: object) => void) => (() => void) }} channel
 *   `send` takes a plain JS object (never a raw string — each
 *   transport's own adapter handles its own serialization); `onMessage`
 *   registers a callback and returns an unsubscribe function.
 * @param {(kind: 'full-sync' | 'new-event', result: { imported: number, alreadyPresent: number }) => void} onSyncEvent
 * @returns {() => void} detaches this protocol from the dag and the channel — call on disconnect.
 */
export function attachSyncProtocol(dag, channel, onSyncEvent = () => {}) {
  channel.send({ type: 'full-sync', events: dag.topoOrder() });

  const unsubscribeDag = dag.subscribe((event) => {
    channel.send({ type: 'new-event', event });
  });

  const unsubscribeChannel = channel.onMessage(async (message) => {
    if (message?.type === 'full-sync' && Array.isArray(message.events)) {
      const result = await mergeEvents(dag, message.events);
      onSyncEvent('full-sync', result);
    } else if (message?.type === 'new-event' && message.event) {
      const result = await mergeEvents(dag, [message.event]);
      onSyncEvent('new-event', result);
    }
    // An unrecognized message shape — ignored, never trusted, never thrown on.
  });

  return () => {
    unsubscribeDag();
    unsubscribeChannel();
  };
}
