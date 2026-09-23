// The real smart-contract/token authoring SDK: the same real pattern
// wallet.js/accrual.js/conservation.js use internally (a pure reducer
// keyed by event payload.type, folded over real, ordered events),
// genericized for a THIRD PARTY's own custom logic — a token, a game's
// state, anything — without needing to understand EventLog/adapt-event
// internals to get it right.
//
// Deliberately NOT built on DataStore: DataStore's own write API is
// fixed to kv.set/kv.delete/kv.transaction, which is exactly wrong for
// a contract with its own real event vocabulary (mint/transfer/burn,
// or whatever the contract calls its own actions). A Contract instead
// dispatches real events under WHATEVER type names the definition
// itself declares handlers for.

import { createEvent, toReducerEvents, deriveId } from 'aiwa-core';
import { collectAncestors } from './ancestors.js';

// REAL AUTHORIZATION, THE ONLY SAFE WAY: a reducer never sees who
// really published an event — toReducerEvent (aiwa-core's own
// adapt-event.js) strips author/signature entirely, by design, so
// reducers stay pure, hand-testable functions of {id, parents,
// payload} (see aiwa-core's own wallet.test.mjs feeding it raw,
// hand-built events with no real envelope at all). A plain
// `payload.from` field is NOT a real proof of anything: EventLog only
// verifies that an event was really signed by SOMEONE claiming its own
// outer author id — nothing stops that real, validly-self-signed
// event's OWN payload from claiming to be a completely different
// `from`. This is exactly why aiwa-core's own wallet.js embeds a
// SEPARATE, inner signature for transfer/split, verified inside the
// reducer itself (see its canonicalTransferMessage/
// verifyTransferAuthorization) — signedAction/verifySignedAction below
// generalize that identical, proven pattern for any contract's own
// custom action. Skipping this for anything holding real value is a
// real, exploitable impersonation hole, not a style choice.

function fromHex(hex) { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
function canonicalMessage(fields) { return new TextEncoder().encode(JSON.stringify(fields, Object.keys(fields).sort())); }

/**
 * Signs `fields` (which MUST include the real, claimed `from` — your
 * own real identity id) with `identity`'s own real secret key, adding
 * a fresh nonce/timestamp so the same action can never be replayed.
 * The result is a real, self-contained, independently-verifiable
 * payload — safe to put directly on an event dispatched by ANYONE
 * (even a relay with no reason to be trusted), since its own embedded
 * signature is what a handler actually checks, not who published it.
 */
export async function signedAction(identity, fields, { now = Date.now(), nonce = crypto.randomUUID() } = {}) {
  const withMeta = { ...fields, nonce, timestamp: now };
  const signature = await identity.sign(canonicalMessage(withMeta)); // Identity.sign() itself throws for a public-only identity with no real secret key
  return { ...withMeta, signerPubkey: identity.publicKey, signature };
}

/**
 * Verifies a real signedAction() payload: the embedded signature is
 * real AND the claimed `from` really matches the signer's own derived
 * id. Returns false for any malformed or forged payload — never
 * throws. Explicitly ignores `type` even if present: Contract.state()
 * folds the wire event's own `type` into `payload` for the reducer's
 * convenience (see aiwa-core's own adapt-event.js) AFTER signedAction()
 * already signed the real application fields — `type` was never part
 * of what got signed, so it must never be part of what gets verified.
 */
export async function verifySignedAction(payload) {
  const { from, nonce, timestamp, signerPubkey, signature, type, ...fields } = payload ?? {};
  if (![from, nonce, signerPubkey, signature].every((v) => typeof v === 'string' && v)) return false;
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  let sigValid;
  try {
    sigValid = ed25519.verify(fromHex(signature), canonicalMessage({ ...fields, from, nonce, timestamp }), fromHex(signerPubkey));
  } catch {
    return false;
  }
  if (!sigValid) return false;
  return (await deriveId(fromHex(signerPubkey))) === from;
}

/**
 * @param {{ initialState: () => any, handlers: Record<string, (state: any, event: { id: string, parents: string[], payload: any }) => any | Promise<any>> }} spec
 */
export function defineContract({ initialState, handlers }) {
  return {
    initialState,
    async apply(state, event) {
      const handler = handlers[event.payload?.type];
      return handler ? await handler(state, event) : state;
    },
    async materialize(orderedEvents) {
      let state = initialState();
      for (const event of orderedEvents) state = await this.apply(state, event);
      return state;
    },
  };
}

/** A real, live handle on one contract's own domain: dispatch real actions, read the real, current materialized state. */
export class Contract {
  constructor({ identity, log, domain, definition }) {
    this.identity = identity;
    this.log = log;
    this.domain = domain;
    this.definition = definition;
  }

  /** Emits one real, signed event of `type` with `payload` — the contract's own real action vocabulary, whatever the definition's handlers recognize. */
  async dispatch(type, payload) {
    const event = await createEvent(this.identity, { domain: this.domain, parents: await this.log.head(), type, payload });
    await this.log.append(event);
    return event;
  }

  /** The real, current state — every real event ever dispatched to this domain, folded through the definition's own reducer, in real causal order. */
  async state() {
    const heads = await this.log.head();
    const orderedEvents = await collectAncestors(this.log, heads);
    return this.definition.materialize(toReducerEvents(orderedEvents));
  }
}
