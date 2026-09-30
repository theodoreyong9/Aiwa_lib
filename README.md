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

## Where this sits

```
       ┌────────────────────────────────────────────────┐
       │ AIWA_project                                   │
       │ one concrete deployment (a single static page, │
       │ no build step, no fixed server)                │
       └────────────────────────────────────────────────┘
                                │
                                │  imports all three, directly
                                ▼
               ┌──────────────────────────────────┐
               ▼                                  ▼
┌────────────────────────────┐      ┌───────────────────────────┐
│ aiwa-lib  <-- you are here │      │ aiwa-platform             │
│ public wallet API (AIWA),  │      │ transport, replication,   │
│ Channel, contract SDK      │      │ capability-gated storage, │
│                            │      │ bundle publishing         │
└────────────────────────────┘      └───────────────────────────┘
               │                                  │
               └────────────────┬─────────────────┘
                                ▼
        ┌──────────────────────────────────────────────┐
        │ aiwa-core                                    │
        │ the protocol itself: identity, event log,    │
        │ progression, accrual, conservation, Mirror,  │
        │ Causal Tick, contracts, delegation, vouchers │
        │                                              │
        │ depends on nothing of its own - only         │
        │ @noble/curves, @noble/hashes, @scure/bip39,  │
        │ optional @solana/web3.js                     │
        └──────────────────────────────────────────────┘
```

`aiwa-lib` never redefines what counts as a valid state transition —
that's `aiwa-core`'s job alone (see its own README). This package only
composes real primitives from the two layers below it into a
developer-facing API; `Channel` and bearer vouchers are real protocol
extensions that live in `aiwa-core` itself (not layered on here) for
exactly that reason.

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

### Scalability: incremental materialization, checkpoints, and three real bugs found closing that loop

Every wallet call (`balance()`, `claimable()`, `send()`...) used to fold
the entire event log from genesis on every single call — a real
regression this library reintroduced, growing unboundedly for a
long-lived domain. `_materializeWallet()` now caches the last
materialized state and folds only the real events appended since.
`checkpoint()` appends a real, self-signed snapshot of your own current
state (aiwa-core's own `checkpoint.js`); `pruneToLastCheckpoint()`
physically deletes everything it already covers, bounding local storage
too — see aiwa-core's own README for the explicit, honest trust
tradeoff pruning makes (a peer who only ever receives your pruned log
trusts your own signed checkpoint instead of independently re-deriving
history from genesis).

```js
await aiwa.checkpoint(); // a real, self-signed snapshot of your current state
const deleted = await aiwa.pruneToLastCheckpoint(); // physically removes what it covers
```

**Three real bugs found and fixed while closing this loop, in the order
they surfaced** (each caught the next — none was hypothetical):

1. A checkpoint's own embedded `progression.domains[domain].lastId`
   named whichever progression event was last accepted *before* the
   checkpoint — an event pruning is free to delete once the checkpoint
   exists. Fixed in aiwa-core's `checkpointWalletState()`, which now
   repoints it to the checkpoint's own real id.
2. That fix exposed a second, unrelated, pre-existing bug: aiwa-core's
   `progression.js` requires the domain's last accepted progression
   event to be a *direct* parent, but every real event builder here
   (`advanceProgress()` included) sets parents to the log's current
   heads alone — the instant anything else (`recordCommitment()`, a
   checkpoint) becomes the sole head in between, that link silently
   breaks and every later progression event is permanently rejected.
   Fixed by routing `advanceProgress()`'s parents through aiwa-core's
   new `progressionParents(heads, lastId)`.
3. That fix, in turn, revealed a *third* bug: `progressionParents()`'s
   extra parent edge can point straight past `_materializeWallet()`'s
   own heads-only incremental-exclusion boundary, back into
   already-covered territory — the same real event would get folded
   twice, and aiwa-core's own causal-chain check would reject it the
   second time as already-advanced-past. Fixed by tracking the real,
   growing set of already-covered ids (`_coveredIds`, bounded by
   activity since the last checkpoint, not all-time history) instead of
   just the latest heads. `test/wallet.test.mjs`'s own
   `advanceProgress() keeps chaining correctly across an intervening
   recordCommitment()` test reproduces the original, end-to-end failure
   this whole chain started from: `claimable()` silently stops growing
   forever the moment any other real event happens between two
   progression ticks.

**Honest limit, unchanged by any of this**: `checkpoint()`/
`pruneToLastCheckpoint()` are two separate calls, not automatic — a real
deployment decides its own cadence (matching how `startProgressLoop()`
is also opt-in, not automatic). `startAutoCheckpoint({ intervalMs })`
below is exactly that cadence, if a deployment wants it.

#### Bounding the next cold load: `startAutoCheckpoint()` and `onMaterializeProgress`

A real, previously-open question this closes: without ANY checkpoint
ever taken, a domain's very next cold load (a page reload, a fresh
device) still replays its ENTIRE real history from genesis — the exact
same real cost v2.0's own `state-snapshot.js` existed to bound, silently
reintroduced the moment nobody calls `checkpoint()` themselves.

```js
aiwa.startAutoCheckpoint({ intervalMs: 5 * 60_000 }); // real default: every 5 minutes
aiwa.onMaterializeProgress = (current, total) => updateProgressBar(current, total);
```

`startAutoCheckpoint()` calls `checkpoint()` + `pruneToLastCheckpoint()`
on a real timer, exactly like `startProgressLoop()` does for
`advanceProgress()` — skipped entirely, with zero real event created,
whenever nothing genuinely changed since the last real checkpoint (same
log heads), so an idle wallet never accumulates pointless, empty
checkpoints. `disconnect()` stops it, same as the progress loop.

`onMaterializeProgress`, set once on the `AIWA` instance, is called by
`_materializeWallet()`'s own real fold whenever there's real,
non-trivial work to report — most visibly the very first call after a
cold load with no checkpoint yet (a real, unbounded-time genesis
replay), but honestly wired for ANY real backlog, not special-cased to
"first load only". Left unset, materialization stays exactly as silent
as before — this is purely additive.

**A fourth, separate real bug, found afterward**: `progression.js`'s
own checks never verified who actually signed a `'progression'` event —
`vdfSeed`/`vdfOutput` are public, deterministic values, so anyone could
compute a domain's own next-epoch proof and advance its progression
without consent, permanently inflating its `domainAge` and reducing its
future reward per accrual (verified against the real formula: ~9x lower
at `qTotal=20000` vs. `qTotal=1`, for the same freshly-reset position —
see aiwa-core's own README). `advanceProgress()` now signs every
progression event via aiwa-core's `buildSignedProgressionEvent`, the
identical `deriveId(signerPubkey) === domain` discipline `recordCommitment()`
already uses.

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

#### The real handshake — `openChannel()` above never asked the peer anything

**A real gap, found the same way every other one in this project was:
checked against what the code actually does, not assumed.**
`openChannel()` is unilateral — you alone decide, sign, and get an
immediately-usable `Channel`; the peer never consents to anything, and
has no way to know a channel naming them even exists until money
arrives. That's a real, working delegation, but it was never a real
*channel between two peers* in any meaningful sense.

`requestChannel()`/`acceptChannelRequest()`/`Channel.confirm()` add the
missing consent step, genuinely transport-agnostic — request and accept
are small, self-contained, independently verifiable blobs (the same
`encodeOfflineBundle`/`decodeOfflineBundle` shape `sendOfflineBundle()`
already uses), so the whole handshake works precisely as well over a
live network message as over a pasted string standing in for a QR code,
NFC, or Bluetooth transfer — **both sides can be fully offline for all
three steps**, exactly like an offline payment already can be.

```js
// Alice's side — fully offline, no joinNetwork() needed for this at all.
const { blob: requestBlob, channel } = await alice.requestChannel(bobIdentityId);
channel.status; // 'pending' — every action (send, claim, issueVoucher, redeemVoucher) throws until confirmed

// ...requestBlob travels to Bob however it actually can (a live message, pasted text, a QR code, Bluetooth)...

// Bob's side — also fully offline: verifies the embedded delegation
// standalone (aiwa-core's own verifyDelegation — no EventLog, no
// state), never touches his own log just to accept.
const acceptBlob = await bob.acceptChannelRequest(requestBlob);

// ...acceptBlob travels back to Alice the same real way...

// Alice's side again.
await channel.confirm(acceptBlob); // real, independent verification — see its own header for all three checks
channel.status; // 'confirmed' — now genuinely usable
await channel.send('0.10');
```

`Channel.confirm()` checks three real things, each closing a specific
way this could otherwise be abused: the accept really answers *this*
request (`requestId`, never some unrelated one); the signature really
verifies *and* really derives the claimed signer (the same
forged-pubkey check every other signed payload in this codebase makes);
and the accepter really is the peer this channel was opened for —
without that last check, anyone who merely obtained the request blob
(never secret; a delegation is meant to be handed over) could accept a
channel meant for someone else, defeating the entire point of asking
for real consent.

`openChannel()` itself is unchanged and still available — a
`Channel` from it starts `status: 'confirmed'` (immediately usable, the
identical behavior it always had), useful for tests, internal tooling,
or a deployment that genuinely doesn't need the peer's consent. The
handshake above is what a real wallet UI should use instead for an
actual channel between two people.

**Explicitly out of scope here, on purpose**: a `Channel` still only
ever carries payment-shaped actions (`send`/`claim`/`issueVoucher`/
`redeemVoucher`) — real messages or smart-contract dispatch *through* a
confirmed channel are a real, separate piece of work, not attempted in
this pass. Likewise, no "is this transaction validated yet" status is
surfaced anywhere here — `channel.send()`'s own returned event is
already durably appended to the log the moment it resolves (see
`EventLog.append()`); whether that's a sufficient answer to "validated"
for a given deployment, or whether real sync/confirmation status needs
its own UI, is left open rather than guessed at.

#### A channel is a real, standalone wallet once open — claim, withdraw, receive, publish too

Beyond `send()`, a `Channel` also has `claim(amount)`, `issueVoucher(amount)`,
and `redeemVoucher(voucher)` — all real, all working with zero root-key
involvement after the channel was opened, exactly like `send()`. The
real cost of each differed enough that they're worth being precise
about, rather than assuming delegation covers everything uniformly:

- **`channel.claim(amount)`** was first built on a real, then-existing
  gap: aiwa-core's own `'claim'` events were not signer-scoped at the
  reducer level (`adapt-event.js` strips `author` before any reducer
  ever sees an event, and neither `applyWalletEvent` nor
  `applyAccrualEvent` checked `payload.domain` against who actually
  signed), so a channel's ordinary, validly-signed outer envelope was
  already everything aiwa-core required. **That gap is now closed** —
  aiwa-core's `accrual.js` requires a real signature proving the signer
  controls the named domain (see its own README, "Honest limits") — so
  `channel.claim()` now uses aiwa-core's new
  `buildSignedDelegatedClaimEvent`/`'delegated-claim'` instead: the
  identical delegation mechanism `redeemVoucher()` below already uses,
  reusing the same already-issued `this._delegation`. The claimed value
  still lands in the real owner's own position
  (`this._delegation.from`), never the channel's own session identity.
- **`channel.issueVoucher(amount)`** reuses the identical delegated-
  transfer mechanism `send()` already uses, just addressed to a
  hash-locked voucher address instead of a real identity — a small,
  internal refactor (`send()`'s destination generalized into a private
  `_sendTo(to, amount)`), no new aiwa-core protocol needed either.
- **`channel.redeemVoucher(voucher)`** is the one that genuinely needed
  new protocol: an ordinary `voucher-redeem` requires the real signer
  to derive the claimed destination directly, which a channel's
  session key never does by construction (a fresh, deterministic
  keypair, not the owner's). aiwa-core's new
  `buildSignedDelegatedVoucherRedeemEvent`/`'delegated-voucher-redeem'`
  closes that gap with the identical two-signature composition
  `delegated-transfer` already established — see aiwa-core's own
  README for the full mechanism.
- **Receiving** (`aiwa.receiveOfflineBundle()`) needed no channel
  involvement at all, and no longer requires being connected either —
  appending an already-signed incoming bundle never signs anything
  with your own key, so the `_requireConnected()` guard on it was
  simply unnecessary and has been removed.
- **Publishing a contract through a channel** needs almost no new
  aiwa-lib surface: `channel.identity` is already a real, complete
  `Identity` — pass it directly to `aiwa-platform`'s
  `publishBundle(channel.identity, channel.log, domain, {...})`
  exactly as you would `aiwa.identity`/`aiwa.log`. The one real
  addition is `channel.log` itself (a thin getter over the same
  `EventLog` the owner's own `AIWA` instance uses) — needed because
  `aiwa.log` genuinely stops being reachable once the app's own
  reference to a disconnected `AIWA` instance is dropped, even though
  the underlying log itself was never tied to connection state (see
  `receiveOfflineBundle()`'s own note above).
  **Honest limit, verified directly**: the resulting bundle's real,
  cryptographic author is the channel's own session identity, not the
  owner's root id — discoverable by address (the domain string
  convention can still embed the owner's real id, e.g.
  `contract:<owner id>:<name>`), but NOT via
  `listBundlesByAuthor(log, ownerRootId)`, since that queries the real,
  cryptographic `event.author`, which genuinely is the delegate here.
  A full "delegated publish, attributed to the real owner" mechanism
  (mirroring the delegated-voucher-redeem pattern) is real, separate,
  not-yet-built work.

```js
// All four, through the same open channel, after aiwa.disconnect():
await channel.claim('2.5');
const voucher = await channel.issueVoucher('1.0');
await channel.redeemVoucher(someOtherVoucher);
await publishBundle(channel.identity, channel.log, `contract:${ownerId}:my-token`, { name: 'my-token', version: '1.0.0', files: [...] });
```

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

### Capital is what a confirmed burn covers (mandatory)

aiwa-core now enforces the genesis commitment (its README: “The genesis commitment is backed by a burn”): a domain's
committed capital `b` may not exceed what burns **this reader confirmed** for it. Until then a wallet could sign
`b = 1 000 000 000` with no burn and accrue on it. In this wallet:

- **`burn(lamports, connection)`** broadcasts the burn, then `recordBurn(signature, connection)` asks Solana for the
  **finalized** transaction, checks it is a burn paid by *this wallet's own key*, publishes a `'burn-record'` event
  (the signature and nothing else), and only then calls `recordCommitment({ b })`. If Solana does not report the
  transaction finalized yet, `recordBurn` says so and can simply be called again later with the signature.
- **`recordCommitment({ b })`** refuses, with the reason, when the total would exceed what confirmed burns cover —
  instead of appending an event every reader would reject.
- **`confirmBurns(connection)`** does the same for other domains' `'burn-record'` events in the log: it asks Solana
  about each signature it has not confirmed and keeps what Solana says (never what an event says). Until a wallet has
  confirmed a burn, it credits **nobody's** commitment to that burn — that is the paper's one external dependency,
  not a new one. Give the wallet a `connection` (`new AIWA({ rewardParams, connection })`) and it confirms by itself
  whenever events arrive; without one, call `confirmBurns` when online. A burn Solana does not know stays pending.
  A domain quoting someone else's signature earns nothing (the payer must be the domain's own key and must really
  have spent what was burned).
- **Opt out, explicitly**: `rewardParams.commitmentBacking: 'none'` (tests, demos, private economies). Leaving it out
  means mandatory. This repo's own pre-existing tests say so in one line.
- `position()` weighs a witness by the burns this wallet confirmed for it (`identityCostFromBurns`).

**Not covered:** a burn is confirmed against whichever Solana endpoint the wallet is given — a dishonest endpoint is
the wallet owner's problem; a wallet that has never been online credits no one's commitment. Checked with a fake
Solana (`test/burn-backed.test.mjs`): no burn, no commitment; a burn covers up to what it burned and accrual follows;
another wallet credits the commitment only after confirming the burn itself; an unknown burn stays pending; quoting
someone else's burn earns nothing; automatic confirmation with a `connection`. **Not checked against a real Solana
endpoint** — only its `getTransaction` shape, as aiwa-core reads it.

### Other domains: Mirror, and `position()`

`aiwa-core` has the pieces — Mirror (a domain's own signed commitments about what it received from others),
identity cost (what a domain burned) and `assessPosition` (proofs plus the weighted median) — but until now
nothing produced their inputs: no component signed a reception commitment when peers synced, and the wallet never
rebuilt Mirror state. This is that half (`src/observation.js`, plus three methods on `AIWA`):

- **`observe()`** signs and appends one `'reception'` event per other domain whose progression this log holds
  beyond what this wallet already committed to having seen, and pushes it to connected peers (the observed domain
  only counts it as a witness once it holds it). Idempotent: nothing new, nothing appended. **It runs by itself**
  after a live sync (`Replicator.onSync`), after `receiveOfflineBundle()` and after `redeemVoucher()`, unless the
  wallet was built with `autoObserve: false`; `onObserveError` hears what a background run could not do and
  `await aiwa.settled()` waits for it.
- **What it cites.** Only a progression event that can be trusted: the highest one the domain's own chain
  *accepts* (aiwa-core's `replayProgression`: epoch + 1, chained, signed by the domain's key, sequential proof
  verified) — or, when the log does not hold that domain from epoch 1 and the chain cannot be replayed, the
  highest one whose signature is genuine. A forged one is never cited: it would make this wallet claim an epoch
  that does not exist, and every honest commitment after it would "go backwards" and be rejected.
- **`position(domain, { selfReportedEpoch })`** hands everything this log holds to `assessPosition`: a position
  that never goes below what observers provably received; a rewind or a fork only with proof; the weighted median
  as the estimate; `verification: 'chain' | 'signature'` saying which check it could make; `rejectedEvents`.
  Read-only — needs no unlocked key. See aiwa-core's README (“Position”) for exactly what it does and does not cover.
- **Who weighs what.** A witness weighs what it committed (yellow paper §13: `w_i = b_i`): the capital `b` each domain
  signed into its own accrual position — `recordCommitment()`, and `burn()` which calls it — which the wallet's
  materialization already holds (aiwa-core's `identityCostFromCommitments`). An observer that committed nothing weighs
  nothing in the estimate (the proofs do not need weight), and nobody can commit capital to someone else's position
  (the accrual reducer checks the signature). **Honest limit:** `b` is the domain's own signed statement; `position()`
  does not re-check it against a Solana burn.

Costs and limits, stated: `position()` and `observe()` read the log's ancestors and replay each foreign domain's
chain, so they are not free on a long log (the progression proofs are re-verified, as the wallet does when it
materializes); a pruned log (checkpoint) cannot be replayed from epoch 1 and falls back to signatures, visibly.
Checked with two real wallets exchanging events through an offline bundle and through `LoopbackTransport`
(`test/observation.test.mjs`): a bundle is answered by a signed commitment; `observe()` follows the other domain
forward with increasing commitments and is idempotent; a forged foreign progression event is never cited and is
reported as rejected; a live session makes the commitment and delivers it to the observed domain; another domain's
accrual commitment naming yours is ignored. **Not checked:** a real network beyond the loopback; a large log.

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

65 passing `node --test` cases. Depends on `aiwa-core` and
`aiwa-platform` via their GitHub URLs (none of the three are on npm
yet).

**Fixed two real, related bugs this pass** — found live, while
building a Channel-over-its-own-transport demo, by watching a real
recipient's balance simply never move:

1. `AIWA.send()` and `Channel.send()` appended the new transfer event
   to the local log but never called `aiwa-platform`'s
   `Replicator.publish(events)` — so a send made *after* a peer was
   already connected silently never reached them. `Replicator` only
   syncs automatically via a one-time `HELLO`/`HELLO_ACK` handshake at
   the moment two peers join the same room; it has no mechanism that
   re-syncs on its own afterward.
2. Even after fixing (1), publishing only the *bare* new event(s)
   still silently failed on a peer whose log didn't already have this
   event's full causal history (e.g. they connected before your
   commitment/progression/claim history existed) — `EventLog.appendMany()`
   throws "unresolvable missing parents", and `Replicator`'s own
   message queue catches and only `console.error`s that, so the
   failure is invisible to the sender too.

Both methods now publish the FULL ancestor closure of the new
event(s) (`collectAncestors()` — the same bundling
`sendOfflineBundle()` already relies on for a zero-prior-sync
stranger), not just the bare new events; already-known ancestor events
are a real no-op on append, so this is safe to do on every send.
`test/wallet.test.mjs` has four `REGRESSION:` tests (using
`aiwa-platform`'s `LoopbackTransport` for a deterministic, in-memory
two-peer connection) covering both orderings — peers connect before
funding, and peers connect after funding — for both `send()` and
`Channel.send()`.

Also found and fixed the same pass: those tests themselves leaked
`LoopbackTransport` peers into its process-wide static registry by
never calling `leaveNetwork()`, so a wallet from one test kept
"replying" to every later test's own connection handshake with its own
unrelated event history — real, intermittent test cross-talk once
enough `LoopbackTransport` tests existed in the same file. Fixed by
having every such test call `leaveNetwork()` on both peers when done.

## Testing

```
npm install
node --test
```
