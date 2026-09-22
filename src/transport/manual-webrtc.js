// A live peer-to-peer connection via WebRTC's native browser APIs, no
// signaling server and no external library — bootstrapping still needs
// some channel for the first offer/answer exchange (see
// signaling-codec.js), copied by hand. Never a replacement for
// trystero-room.js's automatic discovery, an additional transport for
// when no relay is wanted or reachable.
//
// Unlike a DAG-sync-specific transport, this only opens a channel —
// `onChannelOpen({send, onMessage})` hands it to the caller, who decides
// what to do with it: attach sync-protocol.js's `attachSyncProtocol` for
// a full DAG sync, or use `send`/`onMessage` directly for point-to-point
// application messages with no DAG involved at all.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    function check() {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class ManualConnection {
  /**
   * @param {string} originId carried in the signaling blob so the other
   *   side can show who they're pairing with before accepting.
   * @param {{ onStatusChange?: (status: 'connecting'|'open'|'closed') => void,
   *           onChannelOpen?: (channel: { send: (m: object) => void, onMessage: (cb: (m: object) => void) => (() => void) }) => void,
   *           dataChannelLabel?: string }} [opts]
   */
  constructor(originId, { onStatusChange, onChannelOpen, dataChannelLabel = 'aiwa-lib' } = {}) {
    this.originId = originId;
    this.onStatusChange = onStatusChange ?? (() => {});
    this.onChannelOpen = onChannelOpen ?? (() => {});
    this.dataChannelLabel = dataChannelLabel;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.channel = null;
  }

  _wireChannel(channel) {
    this.channel = channel;
    channel.onopen = () => {
      this.onStatusChange('open');
      const send = (message) => {
        if (channel.readyState === 'open') channel.send(JSON.stringify(message));
      };
      const onMessage = (cb) => {
        channel.onmessage = (e) => {
          let parsed;
          try {
            parsed = JSON.parse(e.data);
          } catch {
            return; // a malformed message — ignored, never trusted
          }
          cb(parsed);
        };
        return () => { channel.onmessage = null; };
      };
      this.onChannelOpen({ send, onMessage });
    };
    channel.onclose = () => this.onStatusChange('closed');
  }

  /** dynamic import so the encode/decode helpers are pinned to this signaling-codec.js instance, avoiding a second, incompatible codec version elsewhere */
  async _signaling() {
    return import('./signaling-codec.js');
  }

  /** The initiating side: creates a data channel and a gathered offer blob. */
  async createOffer() {
    this.onStatusChange('connecting');
    const channel = this.pc.createDataChannel(this.dataChannelLabel);
    this._wireChannel(channel);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(this.pc);
    const { encodeSignal } = await this._signaling();
    return encodeSignal('offer', this.originId, this.pc.localDescription.sdp);
  }

  /** The responding side: accepts an offer blob, produces an answer blob. */
  async acceptOfferAndCreateAnswer(offerBlob) {
    this.onStatusChange('connecting');
    const { decodeSignal, encodeSignal } = await this._signaling();
    const decoded = decodeSignal(offerBlob);
    if (decoded.kind !== 'offer') throw new Error('Expected an offer, not an answer.');
    this.pc.ondatachannel = (e) => this._wireChannel(e.channel);
    await this.pc.setRemoteDescription({ type: 'offer', sdp: decoded.sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(this.pc);
    return encodeSignal('answer', this.originId, this.pc.localDescription.sdp);
  }

  /** The initiating side: completes the connection with the answer blob. */
  async completeWithAnswer(answerBlob) {
    const { decodeSignal } = await this._signaling();
    const decoded = decodeSignal(answerBlob);
    if (decoded.kind !== 'answer') throw new Error('Expected an answer, not an offer.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: decoded.sdp });
  }

  close() {
    if (this.channel) this.channel.close();
    this.pc.close();
    this.onStatusChange('closed');
  }
}
