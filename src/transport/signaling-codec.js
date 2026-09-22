// WebRTC needs some channel to exchange an initial offer/answer before
// any live connection exists. With no signaling server, that exchange
// happens by hand: one blob of text, copied through whatever channel
// two peers already share.
//
// Trickle ICE is deliberately not used: candidates are gathered fully
// before the offer/answer blob is produced, so exactly one blob needs to
// move in each direction.

const FORMAT = 'aiwa-lib-signal-v1';

export function encodeSignal(kind, originId, sdp) {
  const payload = { format: FORMAT, kind, originId, sdp, createdAt: Date.now() };
  return btoa(encodeURIComponent(JSON.stringify(payload)));
}

export function decodeSignal(blob) {
  let payload;
  try {
    payload = JSON.parse(decodeURIComponent(atob(blob.trim())));
  } catch {
    throw new Error('Not a recognized connection blob.');
  }
  if (payload.format !== FORMAT) throw new Error('Not a recognized connection blob.');
  if (payload.kind !== 'offer' && payload.kind !== 'answer') throw new Error('Malformed connection blob.');
  if (typeof payload.sdp !== 'string') throw new Error('Malformed connection blob.');
  return payload;
}
