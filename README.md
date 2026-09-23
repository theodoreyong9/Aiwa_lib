# aiwa-lib

The public, developer-facing facade over [`aiwa-core`](https://github.com/theodoreyong9/Aiwa_core)
(validation: identity, events, progression/VDF, reward, accrual,
conservation) and [`aiwa-platform`](https://github.com/theodoreyong9/Aiwa_platform)
(distributed infra: transport, replication, permissions, storage). Two
real things, composed from what those two packages already prove out,
never reimplemented here:

- **A real wallet API** (`AIWA`): connect/disconnect, address, real SOL
  balance, real burn, real AIWA balance, claimable, claim, send/receive
  — including a fully OFFLINE send/receive path (QR code, NFC,
  Bluetooth — no network at all).
- **A smart-contract/token authoring SDK** (`defineContract`,
  `Contract`, `signedAction`/`verifySignedAction`): define your own
  real, event-sourced contract — a token, a game's state, anything —
  without needing to understand `EventLog`/`adapt-event.js` internals
  to get real authorization right.

## The wallet API

One real Ed25519 keypair is BOTH your Solana address and your AIWA
identity (same curve — see aiwa-core's own `toIdentity()`). `connect()`/
`disconnect()` unlock/clear that keypair in memory — a SEPARATE concept
from `joinNetwork()`/`leaveNetwork()` (a live P2P session): your own
already-synced local data (address, balance, claimable) is always
available fully offline, connected to the network or not.

```js
import { AIWA } from 'aiwa-lib';

// A real deployment's own chosen economic parameters — this library
// never invents a default for them.
const rewardParams = { alpha: 1.1, beta: 2.2, gamma: 3, C: Math.pow(33, 3), minQ: 1 };

const aiwa = new AIWA({ rewardParams, dbName: 'my-wallet' }); // omit dbName for an in-memory (Node/test) log
const { address, identityId } = await aiwa.connect(); // or connect({ mnemonic }) / connect({ passphrase }) / connect({ secretKeyBytes })

// Real, on-chain Solana calls — you provide the real Connection; this
// library never picks an RPC endpoint for you.
const lamports = await aiwa.solBalance(connection);
const signature = await aiwa.burn(lamports, connection); // to Solana's own real incinerator address

// Local AIWA ledger — fully offline, identical whether or not joinNetwork() is active.
await aiwa.recordCommitment({ b: 10 }); // commits real capital, after a real burn
await aiwa.startProgressLoop(); // advances your own real progression epoch on a timer — this is what makes claimable() actually grow
const claimable = await aiwa.claimable(); // decimal string, e.g. "1.5"
await aiwa.claim(claimable);
const balance = await aiwa.balance();

// Real, live P2P sync, if you want it (see aiwa-platform's WebrtcTransport/Introducer).
await aiwa.joinNetwork(transport);
await aiwa.send(recipientIdentityId, '1.0'); // broadcasts to connected peers via aiwa-platform's Replicator

// Fully OFFLINE — QR code, NFC, Bluetooth, anything. No network involved anywhere.
const bundle = await aiwa.sendOfflineBundle(recipientIdentityId, '1.0');
const blob = encodeOfflineBundle(bundle); // a compact string — put this in a QR code
// ...recipient scans it, decodes, and appends it, offline, on their own device:
await theirAiwa.receiveOfflineBundle(decodeOfflineBundle(blob));
```

### The offline send/receive path — the real killer feature, honestly scoped

A stranger with zero prior sync needs the FULL real ancestor chain for
the claim(s) involved: `EventLog.append()` requires every real parent
to already be known. `sendOfflineBundle()` walks that chain for real
(`collectAncestors`) and bundles exactly what's needed — nothing more,
nothing less — so `receiveOfflineBundle()` can append it with real
signature and causal verification, identical to any other real append,
with genuinely zero network involved on either side.

**Honest limit, stated plainly**: this is real double-spend *detection*
via reconciliation, not real-time double-spend *prevention*. Sending
the same claim offline to two different recipients (two QR codes) will
be accepted by each locally until they sync with each other or the
sender — the conflict surfaces only then, the same way a signed paper
check or physical cash carries risk until it clears. That's a genuine,
inherent property of any offline-capable value transfer, not a bug in
this library — see aiwa-core's own `conservation.js` for the real
`deactivate`/`consume` mechanism this relies on. Fine for casual,
trust-based transfers; not a substitute for online settlement on
adversarial, high-value transfers.

**Honest limit**: `send()`/`sendOfflineBundle()` require a SINGLE
active claim covering the amount (splitting a bigger one if needed) —
they don't yet combine several smaller claims to reach it. A real,
separate convenience (claim consolidation), not a protocol limit.

**Honest limit**: a claim with a long real history bundles a
correspondingly larger offline payload. QR codes have a real, practical
size ceiling; NFC/Bluetooth do not. Keeping claim histories short
(consolidating periodically) matters specifically for the QR path.

**Honest limit**: `claimable()` reflects real elapsed protocol epochs —
aiwa-core's own `progression.js`, driven by real VDF proofs
(`vdf.js`'s sequential SHA-256 hash chain — bounds the RATE of
advancement, not calendar time; see that file's own header for why
that's an honestly weaker guarantee than a true asymmetric VDF). A
domain that never calls `advanceProgress()` (or `startProgressLoop()`)
stays at epoch 0 and never accrues anything to claim, however much real
wall-clock time passes. This is not automatic — a wallet UI has to
actually run the loop while it's open, the same real role AIWA_chain's
own `vdf-worker.js` played.

## The smart-contract/token authoring SDK

```js
import { defineContract, Contract, signedAction, verifySignedAction } from 'aiwa-lib';
import { EventLog } from 'aiwa-core';

function myToken({ owner, cap }) {
  return defineContract({
    initialState: () => ({ balances: {}, minted: 0n }),
    handlers: {
      async mint(state, event) {
        if (!(await verifySignedAction(event.payload))) return state; // forged or malformed — silent no-op
        const { from, to, amount } = event.payload;
        if (from !== owner) return state;
        const amt = BigInt(amount);
        if (state.minted + amt > cap) return state;
        return { ...state, minted: state.minted + amt, balances: { ...state.balances, [to]: (state.balances[to] ?? 0n) + amt } };
      },
      async transfer(state, event) {
        if (!(await verifySignedAction(event.payload))) return state;
        const { from, to, amount } = event.payload;
        const amt = BigInt(amount);
        if ((state.balances[from] ?? 0n) < amt) return state;
        return { ...state, balances: { ...state.balances, [from]: state.balances[from] - amt, [to]: (state.balances[to] ?? 0n) + amt } };
      },
    },
  });
}

const log = new EventLog();
const contract = new Contract({ identity: ownerIdentity, log, domain: 'my-token', definition: myToken({ owner: ownerIdentity.id, cap: 1_000_000n }) });
await contract.dispatch('mint', await signedAction(ownerIdentity, { from: ownerIdentity.id, to: recipientId, amount: '100' }));
const state = await contract.state();
```

### Why not `DataStore`

`DataStore` (aiwa-core) is a real, working projection — but its write
API is fixed to `kv.set`/`kv.delete`/`kv.transaction`, which is exactly
wrong for a contract with its own real action vocabulary (mint,
transfer, burn, or whatever the contract calls its own actions).
`Contract` dispatches real events under whatever type names the
definition itself declares handlers for.

### Why `signedAction`/`verifySignedAction` — real authorization, the only safe way

A reducer never sees who really published an event: `toReducerEvent`
(aiwa-core's own `adapt-event.js`) strips `author`/`signature` entirely
by design, so reducers stay pure, hand-testable functions of `{id,
parents, payload}` — the identical convention aiwa-core's own
`wallet.js`/`accrual.js`/`conservation.js` use. A plain `payload.from`
field is **not** a real proof of anything: `EventLog` only verifies
that an event was really signed by *someone* claiming its own outer
author id — nothing stops that real, validly-self-signed event's own
payload from claiming to be a completely different `from`.
`signedAction`/`verifySignedAction` generalize the identical, proven
pattern aiwa-core's own `wallet.js` uses for `transfer`/`split`
(a separate, embedded signature over the real claimed fields,
independently checked inside the handler) for any contract's own
custom action. Skipping this for anything holding real value is a
real, exploitable impersonation hole — confirmed the hard way while
building this: an early draft of the example above checked
`event.author` directly (which doesn't exist at the reducer level at
all) and, once fixed to check `payload.from` instead, was still
forgeable by any other real, validly-signed event claiming a false
`from` — `test/contract.test.mjs`'s own `SECURITY:` test reproduces
exactly that forgery and confirms it's now rejected.

`verifySignedAction` explicitly ignores a `type` field even if present
in the payload it's given: `Contract.state()`'s own materialization
folds the wire event's `type` into `payload` for the reducer's
convenience (same `adapt-event.js` convention) — that happens *after*
`signedAction()` already signed the real application fields, so `type`
was never part of what got signed and must never be part of what gets
verified. Found this the same way: a legitimate, correctly-signed mint
was silently rejected until this was accounted for.

## Status

16 passing `node --test` cases. Depends on `aiwa-core` and
`aiwa-platform` via their GitHub URLs (none of the three are on npm
yet).

## Testing

```
npm install
node --test
```
