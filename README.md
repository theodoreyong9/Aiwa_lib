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
  Bluetooth — no network at all), and a real "sign once, click as many
  times as you want" delegated-send channel (`Channel`, via
  `openChannel()`) for a single counterparty — no pre-funding, nothing
  escrowed, ever.
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
// One atomic action, matching AIWA_chain's own original ignition.js
// ("burn & ignite"): burns to Solana's own real incinerator address,
// then immediately records the exact burned amount as real committed
// capital (recordCommitment({ b: lamports / 1e9 })) — there is no
// separate commit step to forget.
const signature = await aiwa.burn(lamports, connection);

// Local AIWA ledger — fully offline, identical whether or not joinNetwork() is active.
await aiwa.startProgressLoop(); // advances your own real progression epoch on a timer — this is what makes claimable() actually grow
const claimable = await aiwa.claimable(); // decimal string, e.g. "1.5"
await aiwa.claim(claimable);
const balance = await aiwa.balance(); // includes claimable() — see spendableBalance() below for what you can actually send
const spendable = await aiwa.spendableBalance(); // what send()/openChannel().send() can actually move right now

// Real, live P2P sync, if you want it (see aiwa-platform's WebrtcTransport/Introducer).
await aiwa.joinNetwork(transport);
await aiwa.send(recipientIdentityId, '1.0'); // broadcasts to connected peers via aiwa-platform's Replicator

// Fully OFFLINE — QR code, NFC, Bluetooth, anything. No network involved anywhere.
const bundle = await aiwa.sendOfflineBundle(recipientIdentityId, '1.0');
const blob = encodeOfflineBundle(bundle); // a compact string — put this in a QR code
// ...recipient scans it, decodes, and appends it, offline, on their own device:
await theirAiwa.receiveOfflineBundle(decodeOfflineBundle(blob));

// A real BEARER voucher — unlike send*, the recipient is unknown until
// redemption time: whoever redeems first genuinely gets it, and the
// QR/blob can be freely copied, since only the first redemption
// succeeds (aiwa-core's own hash-lock: deriveVoucherAddress/
// 'voucher-redeem'). No pre-funding, no escrow account — issuing is an
// ordinary transfer to the hash of a fresh, random secret.
const voucher = await aiwa.issueVoucher('5.0');
const voucherBlob = encodeOfflineBundle(voucher); // put THIS in the withdrawal QR
// ...whoever scans it, decodes, and redeems it into THEIR OWN identity:
await someoneElsesAiwa.redeemVoucher(decodeOfflineBundle(voucherBlob));
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

**A real bug this surfaced, live, in the AIWA_project wallet UI**:
`balance()` includes `claimable()` — value that has accrued but was
never actually moved into a real, spendable claim. A UI that reads
`balance()` and tries to `send()` that full amount gets a confusing
`"No single active claim covers..."` error, since claimable value
simply cannot be sent until `claim()`'d — and if even a sliver of new
claimable has accrued since the last claim (a running
`startProgressLoop()` does this constantly), `balance()` no longer
matches any single real claim at all. `spendableBalance()` is the real
answer to "how much can I actually send right now" — the sum of your
own already-claimed, active claims, never inflated by still-growing
claimable. `test/wallet.test.mjs` reproduces the exact failure this
caused, then confirms `spendableBalance()` fixes it.

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

### Channels — "sign once, click as many times as you want"

```js
// Both parties need SOME way to reach each other to open a channel at
// all — opening requires a live network session (joinNetwork()) by
// default. Once open, the channel itself needs no further connectivity:
// a direct link between the two (a live WebRTC data channel surviving
// after both lose their wider internet access, Bluetooth, NFC, a QR
// code) is all sendOfflineBundle()/receiveOfflineBundle() ever need.
await aiwa.joinNetwork(transport);
const channel = await aiwa.openChannel(bobIdentityId); // ONE real signature — the delegation
await channel.send('0.10'); // click
await channel.send('0.10'); // click
await channel.send('0.10'); // click — the root key is never touched again
```

This is real delegation (aiwa-core's own `issueDelegation`/
`buildSignedDelegatedTransferEvent`/`buildSignedDelegatedSplitEvent`),
**not** a pre-funded escrow account: `openChannel()` moves zero funds.
It derives a real, deterministic session key for this exact (your
identity, this peer) pair — always the same key, recoverable even
after a crash, never a randomly-generated throwaway you could lose
track of — and signs ONE real delegation authorizing it. Every
`channel.send()` afterward is a fresh, independent, delegate-signed
real transfer of whatever you currently, genuinely own; the delegate
can never move more than that, and a compromised session key only ever
threatens funds you actually hold, for this one peer, same as your
root key already could.

The channel is genuinely self-sufficient once opened, including its
own splitting: the same one-time delegation also authorizes the
delegate to split an existing claim into the exact amount a send
needs, via a real, delegate-signed `'delegated-split'` — the owner's
root key is never touched again for ANY amount, not just ones that
happen to match an existing claim exactly. `channel.balance()` reads
the owner's id from the delegation itself, not from `aiwa.identity`.
Concretely: `aiwa.disconnect()` (clearing the root identity from
memory) does not stop an already-open channel from sending, splitting,
or reporting its balance — see the "keeps working... after the owner's
root identity disconnects" test in this repo's own test suite.

**Honest limit, by explicit design**: no amount cap, no expiry, no
revocation. An issued delegation is valid for as long as you keep using
the same root identity with that peer. A deployment wanting either
bound layers it into its own `contractVerifiers` via aiwa-core's
`'contract-payout'` extension point instead of forcing it on every
caller here — `close()` exists for an application's own bookkeeping
(e.g. stop showing a channel as "open" in a UI), not because it changes
what the delegation can do.

### Bearer vouchers — a real QR you can hand to a stranger

```js
const voucher = await aiwa.issueVoucher('5.0'); // hash-locks 5.0 behind a fresh, random secret — zero pre-funding, zero escrow
const blob = encodeOfflineBundle(voucher); // this is the QR code
await theirAiwa.redeemVoucher(decodeOfflineBundle(blob)); // whoever scans it first genuinely gets it
```

Unlike `send*`/`Channel`, the recipient is unknown until redemption —
issuing is an ordinary, already-existing signed transfer to the hash
of a secret (`aiwa-core`'s own `deriveVoucherAddress`), never a real
identity, so it needs no new protocol at all. "The QR can be copied,
but only the first redemption succeeds" isn't new double-spend logic
either — it falls straight out of `conservation.js`'s own existing
single-writer invariant (a second redemption's `deactivate()` throws
on an already-consumed claim, rejected exactly like a replayed
transfer).

**Honest limit, stated plainly, same as `sendOfflineBundle`**: this is
real double-spend *detection* via reconciliation, not real-time
*prevention*. Two people can each honestly, offline, redeem the
identical voucher — both believe they succeeded until their logs sync
with each other or the issuer; the conflict resolves only then, to
exactly one winner. Verified directly in this repo's own test suite
("two real wallets, each honestly redeeming the identical voucher
offline, converge to exactly one winner once synced").

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

27 passing `node --test` cases. Depends on `aiwa-core` and
`aiwa-platform` via their GitHub URLs (none of the three are on npm
yet).

## Testing

```
npm install
node --test
```
