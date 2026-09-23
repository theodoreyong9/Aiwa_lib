// The real, developer-facing AIWA wallet facade: composes aiwa-core's
// already-existing identity/wallet/accrual/conservation reducers and
// aiwa-platform's already-existing transport/replicator into the
// handful of calls a wallet UI actually needs — connect/disconnect,
// address, balance, claimable, claim, send, receive, plus a fully
// offline send/receive path (QR/NFC/Bluetooth — no network at all).
//
// This is deliberately thin: every real financial rule (reward curve,
// conservation, double-spend prevention) lives in aiwa-core, unchanged
// and independently tested there. This file only orchestrates real
// calls into it — it never reimplements or approximates the math.
//
// A single real Ed25519 keypair serves as BOTH your Solana address and
// your AIWA identity (same curve — see aiwa-core's own toIdentity()).
// "Connect"/"disconnect" here means unlocking/clearing that keypair in
// memory; it is a SEPARATE concept from joinNetwork()/leaveNetwork()
// (a live P2P session) — your own already-synced local data (address,
// balance, claimable) is always available fully offline, whether or
// not a network session is active, exactly as a real wallet's own
// local state should be.
//
// HONEST LIMIT: `rewardParams` ({alpha, beta, gamma, C, minQ}) is a
// real deployment's own chosen economic parameters — this file never
// invents a default for them. HONEST LIMIT: `claimable()` reflects
// real elapsed protocol epochs (aiwa-core's own progression.js, driven
// by real VDF proofs) — a domain that has never had a real progression
// event recorded stays at epoch 0 and never accrues anything to claim,
// regardless of how much real wall-clock time passes; wiring a real,
// continuous VDF-computing loop is a separate, not-yet-built piece
// (see this repo's own README).

import {
  EventLog, createMemoryBackend, createIndexedDbBackend, createEvent, toReducerEvents,
  initialWalletState, applyWalletEvent, materializeWallet, spendableClaims, totalBalance,
  buildSignedTransferEvent, buildSignedSplitEvent, claimableNow, toUnits, fromUnits,
  generateLightweightKeypair, lightweightKeypairFromSecretKey, deriveKeypairFromPassphrase,
  deriveKeypairFromBip39Mnemonic, keypairFromSecretKey, loadSolanaWeb3, toIdentity,
  broadcastBurnTransaction, SOLANA_INCINERATOR_ADDRESS, vdfSeed, computeVdfChain,
  issueDelegation, buildSignedDelegatedTransferEvent, buildSignedDelegatedSplitEvent,
  deriveVoucherAddress, buildSignedVoucherRedeemEvent, buildSignedDelegatedVoucherRedeemEvent,
  buildSignedAccrualEvent, buildSignedClaimEvent, buildSignedDelegatedClaimEvent,
} from 'aiwa-core';

// A real, cryptographically random secret — 32 bytes, hex-encoded.
// This is what a voucher's QR code actually carries; whoever can
// reveal it first genuinely redeems the real value it hash-locks (see
// aiwa-core's own wallet.js for the full scheme).
function randomVoucherSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
import { Replicator } from 'aiwa-platform';
import { collectAncestors } from './ancestors.js';

// A real, DETERMINISTIC per-(root, peer) session key — HMAC-SHA256
// keyed by your own real root secret, so it's always recoverable
// (never a randomly-generated, potentially-lost throwaway) and unique
// per counterparty (a compromised session key for one peer's channel
// never affects any other peer's).
async function deriveSessionSeed(rootSecretKey32, peerId) {
  const key = await crypto.subtle.importKey('raw', rootSecretKey32, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`aiwa-lib-channel-session-v1:${peerId}`));
  return new Uint8Array(mac);
}

async function sessionKeypairFor(rootKeypair, peerId) {
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const seed32 = await deriveSessionSeed(rootKeypair.secretKey.slice(0, 32), peerId);
  const pub32 = ed25519.getPublicKey(seed32);
  const secretKey64 = new Uint8Array(64);
  secretKey64.set(seed32, 0);
  secretKey64.set(pub32, 32);
  return lightweightKeypairFromSecretKey(secretKey64);
}

export { fromUnits, toUnits, SOLANA_INCINERATOR_ADDRESS };

export class AIWA {
  constructor({ rewardParams, logDomain = 'aiwa', dbName, backend } = {}) {
    if (!rewardParams) {
      throw new Error('AIWA: rewardParams ({alpha, beta, gamma, C, minQ}) is required — this library never invents a deployment\'s own economic parameters.');
    }
    this.rewardParams = rewardParams;
    this.logDomain = logDomain;
    this.log = new EventLog(backend ?? (dbName ? createIndexedDbBackend(dbName) : createMemoryBackend()));
    this._keypair = null;
    this.identity = null;
    this.replicator = null;
  }

  // --- Wallet unlock (identity), fully offline -----------------------

  /** Derives or generates the real keypair this wallet signs with. Fully offline — no network, no @solana/web3.js load. */
  async connect({ mnemonic, passphrase, secretKeyBytes } = {}) {
    let keypair;
    if (secretKeyBytes) keypair = await lightweightKeypairFromSecretKey(secretKeyBytes);
    else if (mnemonic) keypair = await deriveKeypairFromBip39Mnemonic(mnemonic);
    else if (passphrase) keypair = await deriveKeypairFromPassphrase(passphrase);
    else keypair = await generateLightweightKeypair();
    this._keypair = keypair;
    this.identity = await toIdentity(keypair);
    return { address: this.address, identityId: this.identity.id };
  }

  /** Clears the real keypair from memory. Already-synced local data (this.log) is untouched and stays fully readable. */
  async disconnect() {
    await this.leaveNetwork();
    this.stopProgressLoop();
    this._keypair = null;
    this.identity = null;
  }

  get connected() { return !!this.identity; }
  get address() { return this._keypair ? this._keypair.publicKey.toBase58() : null; }
  _requireConnected() { if (!this.identity) throw new Error('AIWA: not connected — call connect() first.'); }

  // --- Real Solana chain operations (need a real Connection) ---------

  /** The real solanaWeb3.Keypair, for a real on-chain call — lazily loads @solana/web3.js only when actually needed. */
  async solanaKeypair() {
    this._requireConnected();
    const solanaWeb3 = await loadSolanaWeb3();
    return keypairFromSecretKey(solanaWeb3, this._keypair.secretKey);
  }

  /** Real, on-chain SOL balance, in lamports. `connection` is a real solanaWeb3.Connection the caller provides (this library never picks an RPC endpoint for you). */
  async solBalance(connection) {
    const keypair = await this.solanaKeypair();
    return connection.getBalance(keypair.publicKey);
  }

  /**
   * A real, irreversible burn to Solana's own incinerator address — the
   * real activation cost this deployment's identity-cost.js verifies.
   * Atomically also commits the burned amount as real capital via
   * recordCommitment() (matching AIWA_chain's own original ignition.js:
   * one action, "burn & ignite" — the same key that holds SOL is the
   * key AIWA accrues to, there is no separate commit step to forget).
   * Returns the real transaction signature.
   */
  async burn(lamports, connection) {
    const solanaWeb3 = await loadSolanaWeb3();
    const keypair = await this.solanaKeypair();
    const signature = await broadcastBurnTransaction(solanaWeb3, connection, keypair, lamports);
    await this.recordCommitment({ b: lamports / 1e9 });
    return signature;
  }

  // --- Local AIWA ledger (fully offline; identical whether or not joinNetwork() is active) ---

  async _materializeWallet() {
    const heads = await this.log.head();
    const orderedEvents = await collectAncestors(this.log, heads);
    return materializeWallet(this.rewardParams, toReducerEvents(orderedEvents), null, undefined, {});
  }

  /** Real AIWA balance: unclaimed-but-claimable, plus already-claimed spendable claims. Decimal string, e.g. "1.5". */
  async balance() {
    this._requireConnected();
    const state = await this._materializeWallet();
    return fromUnits(totalBalance(this.rewardParams, state, this.identity.id));
  }

  /**
   * What you can actually send right now: the sum of your own already
   * -claimed, active claims. `balance()` also includes `claimable()` —
   * value that has accrued but hasn't been moved into a real, spendable
   * claim yet, and so genuinely cannot be sent until claim()'d. A UI
   * that lets someone "send" `balance()` will hit send()'s own "No
   * single active claim covers..." error the moment even a sliver of
   * new claimable has accrued since their last claim() — this is that
   * distinction, made explicit rather than discovered by a failed send.
   */
  async spendableBalance() {
    this._requireConnected();
    const state = await this._materializeWallet();
    return fromUnits(spendableClaims(state, this.identity.id).reduce((sum, c) => sum + c.amount, 0n));
  }

  /** What's currently claimable from your own real, accrued position — not yet moved into a spendable claim. Decimal string. */
  async claimable() {
    this._requireConnected();
    const state = await this._materializeWallet();
    return fromUnits(claimableNow(this.rewardParams, state.accrual, this.identity.id));
  }

  /**
   * Commits real capital `b` (a plain number — see aiwa-core's own
   * reward.js/accrual.js for what it means in this deployment's
   * economics) to your own position, so it starts earning something
   * real to claim as progression advances. Typically called once,
   * right after a real burn (see burn() above) establishes why you're
   * entitled to commit it — this file never enforces that link itself;
   * a real deployment's own identity-cost.js verification does.
   */
  async recordCommitment({ b, T = 0 } = {}) {
    this._requireConnected();
    const signedAccrual = await buildSignedAccrualEvent(
      { domain: this.identity.id, b, T },
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
    );
    const event = await createEvent(this.identity, {
      domain: this.logDomain, parents: await this.log.head(), type: 'accrual', payload: signedAccrual,
    });
    await this.log.append(event);
    return { eventId: event.id };
  }

  /**
   * Advances your own real progression epoch by exactly one real,
   * sequential VDF step (aiwa-core's own vdf.js — a real hash chain
   * bounding the RATE of advancement, not calendar time; see its own
   * header for why that's a real, different, and honestly weaker
   * guarantee than a true asymmetric VDF). This is what actually makes
   * claimable() grow — call it periodically (see startProgressLoop
   * below) while the wallet is open, the same real role
   * AIWA_chain's own vdf-worker.js played.
   */
  async advanceProgress({ vdfIterations = 100_000 } = {}) {
    this._requireConnected();
    const state = await this._materializeWallet();
    const current = state.accrual.progression.domains[this.identity.id] ?? { epoch: 0, vdfOutput: null };
    const epoch = current.epoch + 1;
    const seed = vdfSeed(this.identity.id, current.vdfOutput ?? 'genesis');
    const vdfOutput = await computeVdfChain(seed, vdfIterations);
    const event = await createEvent(this.identity, {
      domain: this.logDomain, parents: await this.log.head(), type: 'progression',
      payload: { domain: this.identity.id, epoch, vdfIterations, vdfOutput },
    });
    await this.log.append(event);
    return { epoch, eventId: event.id };
  }

  /** Calls advanceProgress() on a real timer until stopProgressLoop() — the practical way a wallet UI keeps its own claimable() genuinely growing while open. Errors are surfaced via onError rather than left to reject silently in the background. */
  startProgressLoop({ intervalMs = 30_000, vdfIterations = 100_000, onError } = {}) {
    this.stopProgressLoop();
    this._progressTimer = setInterval(() => {
      this.advanceProgress({ vdfIterations }).catch((err) => onError?.(err));
    }, intervalMs);
  }

  stopProgressLoop() {
    if (this._progressTimer) {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
  }

  /** Moves `amount` (decimal string) from claimable into a real, spendable claim you own. */
  async claim(amount) {
    this._requireConnected();
    const heads = await this.log.head();
    const claimId = crypto.randomUUID();
    const signedClaim = await buildSignedClaimEvent(
      { domain: this.identity.id, amount, claimId },
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
    );
    const event = await createEvent(this.identity, {
      domain: this.logDomain, parents: heads, type: 'claim', payload: signedClaim,
    });
    await this.log.append(event);
    return { claimId, eventId: event.id };
  }

  /**
   * Finds (or creates, via a real, owner-signed split) a single active
   * claim you own worth exactly `amount` — the shared first step
   * `send()` and a real Channel's own `send()` both need. Splitting is
   * always an owner-only operation, never delegated: real delegation
   * (see openChannel()) only ever covers TRANSFER authorization, not
   * dividing a claim into new ones.
   *
   * HONEST LIMIT (v1): requires a SINGLE active claim >= `amount` —
   * does not yet combine several smaller claims to reach it. Claim
   * consolidation (splitting into round denominations, or merging) is
   * a real, separate, not-yet-built convenience, not a protocol limit.
   */
  async _ensureSpendableClaim(amount) {
    const amountUnits = toUnits(amount);
    const state = await this._materializeWallet();
    const claims = spendableClaims(state, this.identity.id);
    const events = [];
    let sourceClaim = claims.find((c) => c.amount === amountUnits);

    if (!sourceClaim) {
      const bigEnough = claims.find((c) => c.amount > amountUnits);
      if (!bigEnough) {
        throw new Error(`No single active claim covers ${amount} AIWA (v1 limitation — consolidate claims first).`);
      }
      const firstId = crypto.randomUUID();
      const secondId = crypto.randomUUID();
      const signedSplit = await buildSignedSplitEvent(
        { claimId: bigEnough.id, owner: this.identity.id, firstAmount: amount, firstId, secondId },
        this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
      );
      const splitEvent = await createEvent(this.identity, {
        domain: this.logDomain, parents: await this.log.head(), type: 'split', payload: signedSplit,
      });
      await this.log.append(splitEvent);
      events.push(splitEvent);
      sourceClaim = { id: firstId, amount: amountUnits };
    }

    return { sourceClaim, events };
  }

  /**
   * Sends `amount` (decimal string) of already-claimed AIWA to
   * `toIdentityId`, real signature and all. Splits an existing claim
   * first if none matches the amount exactly (see _ensureSpendableClaim).
   *
   * If a live network session is active (joinNetwork()), the new
   * event(s) are also published to every currently-connected peer —
   * REAL BUG, FOUND LIVE: Replicator's own HELLO/HELLO_ACK exchange
   * only syncs once, at the moment two peers connect; nothing
   * automatically re-syncs afterward. A send() made after that initial
   * handshake, with no explicit replicator.publish() call, reached
   * nobody — the recipient's balance simply never moved, silently.
   * "Send over the network" was never actually verified end to end
   * before this was found.
   *
   * SECOND REAL BUG, FOUND THE SAME WAY: publishing only the bare new
   * event(s) still silently fails EventLog.appendMany() on the
   * recipient's side whenever their log doesn't already have this
   * event's full ancestor chain (e.g. they connected before your
   * commitment/progression/claim history existed, so the one-time
   * HELLO sync above never carried it either) — appendMany() throws
   * "unresolvable missing parents", and Replicator's own message queue
   * catches and only console.errors that, so the recipient's balance
   * again silently never moves, with no error surfaced anywhere the
   * sender can see. Publishing the full ancestor closure (the same
   * collectAncestors() bundle sendOfflineBundle() already relies on)
   * is what actually makes this appendable no matter what the
   * recipient already has; already-known ancestor events are a real
   * no-op on append (see EventLog.append()), so this is safe to do
   * every time, not just for a stranger's first sync.
   */
  async send(toIdentityId, amount) {
    this._requireConnected();
    const { sourceClaim, events } = await this._ensureSpendableClaim(amount);

    const signedTransfer = await buildSignedTransferEvent(
      { claimId: sourceClaim.id, from: this.identity.id, to: toIdentityId },
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
    );
    const transferEvent = await createEvent(this.identity, {
      domain: this.logDomain, parents: await this.log.head(), type: 'transfer', payload: signedTransfer,
    });
    await this.log.append(transferEvent);
    events.push(transferEvent);
    if (this.replicator) await this.replicator.publish(await collectAncestors(this.log, events.map((e) => e.id)));

    return { events, newClaimId: `activated:${sourceClaim.id}:${this.identity.id}:${toIdentityId}:0:identity` };
  }

  /**
   * Opens a real "sign once, click many times" channel with `peerId`
   * (see aiwa-core's own wallet.js for the underlying delegation
   * mechanism): derives a real, DETERMINISTIC per-peer session key
   * (recoverable later even after a crash — always the same key for
   * the same root identity + peerId, never randomly generated and
   * potentially lost), and signs ONE real delegation authorizing it.
   * Every subsequent Channel.send() then signs with the already-
   * unlocked session key alone — your own root key is never touched
   * again for this peer's channel.
   *
   * No funds are pre-funded or moved anywhere at open time: nothing is
   * escrowed into a separate account. The delegate only ever authorizes
   * moving what you already, genuinely own, one real transfer at a time.
   *
   * By default requires a live network session (see joinNetwork()) —
   * opening a channel with a peer you have no way to reach at all
   * isn't a real channel. Pass `{ requireNetwork: false }` to skip this
   * (e.g. for tests, or an application with its own reachability check).
   */
  async openChannel(peerId, { requireNetwork = true } = {}) {
    this._requireConnected();
    if (requireNetwork && !this.replicator) {
      throw new Error('openChannel: no live network session — call joinNetwork() first. Once open, the channel itself works fully offline.');
    }
    const sessionKeypair = await sessionKeypairFor(this._keypair, peerId);
    const sessionIdentity = await toIdentity(sessionKeypair);
    const delegation = await issueDelegation(
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(), sessionKeypair.publicKey.toBytes(),
    );
    return new Channel({ aiwa: this, peerId, sessionKeypair, sessionIdentity, delegation });
  }

  // --- Fully offline send/receive: QR code, NFC, Bluetooth, anything ---
  //
  // A recipient with ZERO prior sync needs the FULL real ancestor
  // chain for the claim(s) involved — EventLog.append() requires every
  // real parent to already be known. HONEST LIMIT: a claim with a long
  // real history bundles a correspondingly larger payload; QR codes
  // have a real, practical size ceiling (NFC/Bluetooth do not) — this
  // is why claim consolidation (see send()'s own limit) matters for
  // the QR path specifically.

  /** send() plus every real ancestor event the resulting transfer needs — a self-contained bundle a stranger can append with zero prior sync. */
  async sendOfflineBundle(toIdentityId, amount) {
    const { events, newClaimId } = await this.send(toIdentityId, amount);
    const bundle = await collectAncestors(this.log, events.map((e) => e.id));
    return { events: bundle, newClaimId };
  }

  /**
   * Appends a real offline bundle (from sendOfflineBundle, or its own
   * encodeOfflineBundle) — real signature/causal verification,
   * identical to any other real append. Deliberately NOT gated by
   * _requireConnected(): appending never signs anything with this
   * wallet's own key — every event in the bundle is already, really
   * signed by its own real sender — so receiving genuinely works
   * whether or not this wallet's own root key is currently unlocked.
   * this.log itself is created in the constructor, independent of
   * connect()/disconnect(), so it's always available regardless.
   */
  async receiveOfflineBundle(bundle) {
    await this.log.appendMany(bundle.events);
  }

  /**
   * Issues a real bearer voucher: hash-locks `amount` of your own
   * already-owned value behind a fresh, random secret (aiwa-core's own
   * deriveVoucherAddress/'voucher-redeem' — the same idea a Lightning
   * HTLC or a Bitcoin pay-to-hash-of-a-preimage script uses). Reuses
   * send() as-is — nothing here validates that a recipient is a real
   * identity, so issuing needs no new signing logic at all; the
   * voucher address is just an ordinary transfer destination nobody's
   * root key happens to control.
   *
   * Returns a real, self-contained, offline-transportable blob — put
   * `secret` (and `claimId`/`events`) in a QR code, share it, whatever:
   * whoever redeems it FIRST genuinely gets the value. The QR can be
   * copied; only the first real redemption succeeds — see aiwa-core's
   * own wallet.js for exactly why (its existing single-writer
   * conservation invariant, not new double-spend logic).
   */
  async issueVoucher(amount) {
    this._requireConnected();
    const secret = randomVoucherSecret();
    const voucherAddress = await deriveVoucherAddress(secret);
    const { events, newClaimId } = await this.send(voucherAddress, amount);
    const bundle = await collectAncestors(this.log, events.map((e) => e.id));
    return { secret, claimId: newClaimId, events: bundle };
  }

  /**
   * Redeems a real bearer voucher (from issueVoucher(), or received
   * with zero prior sync — the identical offline mechanism
   * receiveOfflineBundle() uses) into your own, real identity. Whoever
   * redeems first genuinely gets it; redeeming an already-consumed
   * voucher has no real effect.
   */
  async redeemVoucher({ secret, claimId, events }) {
    this._requireConnected();
    await this.log.appendMany(events);
    const redeem = await buildSignedVoucherRedeemEvent(
      { claimId, secret, to: this.identity.id },
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
    );
    const redeemEvent = await createEvent(this.identity, {
      domain: this.logDomain, parents: await this.log.head(), type: 'voucher-redeem', payload: redeem,
    });
    await this.log.append(redeemEvent);
    return { eventId: redeemEvent.id };
  }

  // --- Live network (separate from connect()/disconnect() above) ---

  /** Joins a real P2P session over `transport` (e.g. a real WebrtcTransport) for this wallet's own log domain. */
  async joinNetwork(transport) {
    this._requireConnected();
    this.replicator = new Replicator({ transport, log: this.log, domain: this.logDomain });
    await this.replicator.start();
  }

  async leaveNetwork() {
    if (this.replicator) {
      await this.replicator.stop();
      this.replicator = null;
    }
  }
}

/**
 * "Sign once, click many times." A real, per-peer delegated-send
 * session — see AIWA.openChannel(). Every send() signs with the
 * already-unlocked session key alone; the owner's root key (still the
 * REAL owner of every claim moved) is never touched again after the
 * channel was opened. Fully offline-capable: once the one, real
 * delegation exists, nothing here needs any network at all.
 */
export class Channel {
  constructor({ aiwa, peerId, sessionKeypair, sessionIdentity, delegation }) {
    this._aiwa = aiwa;
    this.peerId = peerId;
    this._keypair = sessionKeypair;
    this.identity = sessionIdentity;
    this._delegation = delegation;
  }

  /** This channel's own real, deterministic session address — distinct from your own root address, one per peer. */
  get address() { return this._keypair.publicKey.toBase58(); }

  /**
   * What the real owner still has available to send through this or
   * any other channel — delegation never partitions the balance, it
   * only authorizes moving it. Reads the owner's id from the
   * delegation itself, not aiwa.identity — this keeps working even
   * after the owner's root identity disconnects, exactly like send().
   */
  async balance() {
    const aiwa = this._aiwa;
    const state = await aiwa._materializeWallet();
    return fromUnits(totalBalance(aiwa.rewardParams, state, this._delegation.from));
  }

  /**
   * Splits, if needed, using the SAME delegation send() uses — a
   * delegate-signed 'delegated-split', never the owner's root key.
   * Mirrors AIWA._ensureSpendableClaim's own v1 limitation (a single
   * active claim >= amount; no consolidation yet).
   */
  async _ensureSpendableClaim(amount) {
    const aiwa = this._aiwa;
    const amountUnits = toUnits(amount);
    const state = await aiwa._materializeWallet();
    const claims = spendableClaims(state, this._delegation.from);
    const events = [];
    let sourceClaim = claims.find((c) => c.amount === amountUnits);

    if (!sourceClaim) {
      const bigEnough = claims.find((c) => c.amount > amountUnits);
      if (!bigEnough) {
        throw new Error(`No single active claim covers ${amount} AIWA (v1 limitation — consolidate claims first).`);
      }
      const firstId = crypto.randomUUID();
      const secondId = crypto.randomUUID();
      const signedSplit = await buildSignedDelegatedSplitEvent(
        this._delegation, { claimId: bigEnough.id, firstAmount: amount, firstId, secondId },
        this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
      );
      const splitEvent = await createEvent(this.identity, {
        domain: aiwa.logDomain, parents: await aiwa.log.head(), type: 'delegated-split', payload: signedSplit,
      });
      await aiwa.log.append(splitEvent);
      events.push(splitEvent);
      sourceClaim = { id: firstId, amount: amountUnits };
    }

    return { sourceClaim, events };
  }

  /**
   * "Click to send" — a real, delegate-signed transfer of `amount` to
   * `to`. No further root-key involvement, ever — including for
   * splitting, so this keeps working after the owner's root identity
   * disconnects. If the owner still has a live network session, the
   * new event(s) are also published to connected peers — publishing
   * the FULL ancestor closure, not just the bare new event(s) (see
   * AIWA.send()'s own header for both real bugs this fixes: a click
   * made after the initial peer handshake reaching nobody, and a peer
   * whose log doesn't yet have this channel's own causal history —
   * commitment, progression, claim, the delegation itself — being
   * unable to append the transfer at all).
   *
   * Private: `to` defaults to this channel's own peer for the public
   * send() below, but the SAME real delegated-transfer mechanism has
   * no protocol-level restriction on the destination — issueVoucher()
   * below reuses it unchanged, addressed to a hash-locked voucher
   * address instead of a real identity.
   */
  async _sendTo(to, amount) {
    const aiwa = this._aiwa;
    const { sourceClaim, events } = await this._ensureSpendableClaim(amount);
    const signedTransfer = await buildSignedDelegatedTransferEvent(
      this._delegation, { claimId: sourceClaim.id, to },
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
    );
    const transferEvent = await createEvent(this.identity, {
      domain: aiwa.logDomain, parents: await aiwa.log.head(), type: 'delegated-transfer', payload: signedTransfer,
    });
    await aiwa.log.append(transferEvent);
    events.push(transferEvent);
    if (aiwa.replicator) await aiwa.replicator.publish(await collectAncestors(aiwa.log, events.map((e) => e.id)));
    return { events, newClaimId: `activated:${sourceClaim.id}:${this._delegation.from}:${to}:0:identity` };
  }

  async send(amount) {
    return this._sendTo(this.peerId, amount);
  }

  /** send() plus every real ancestor event the resulting transfer needs — the identical offline mechanism AIWA.sendOfflineBundle() uses, so a channel click works over QR/NFC/Bluetooth exactly like any other send. */
  async sendOfflineBundle(amount) {
    const { events, newClaimId } = await this.send(amount);
    const bundle = await collectAncestors(this._aiwa.log, events.map((e) => e.id));
    return { events: bundle, newClaimId };
  }

  /**
   * Issues a real bearer voucher THROUGH this channel — no further
   * root-key involvement, ever, exactly like send(). Reuses _sendTo()
   * unchanged, addressed to the hash of a fresh secret instead of a
   * real identity: the identical, real mechanism AIWA.issueVoucher()
   * uses, needing no new protocol here either (see aiwa-core's own
   * wallet.js for exactly why). Returns a real, self-contained,
   * offline-transportable blob, same shape as AIWA.issueVoucher().
   */
  async issueVoucher(amount) {
    const secret = randomVoucherSecret();
    const voucherAddress = await deriveVoucherAddress(secret);
    const { events, newClaimId } = await this._sendTo(voucherAddress, amount);
    const bundle = await collectAncestors(this._aiwa.log, events.map((e) => e.id));
    return { secret, claimId: newClaimId, events: bundle };
  }

  /**
   * Redeems a real bearer voucher THROUGH this channel, landing the
   * value in the real owner's identity (this._delegation.from), never
   * this channel's own session identity — see aiwa-core's own
   * buildSignedDelegatedVoucherRedeemEvent for exactly why an ordinary
   * voucher-redeem can't do this (it requires the real signer to
   * derive the claimed destination directly, which a session key never
   * does by construction) and why the SAME delegation send() already
   * uses closes that gap here too.
   */
  async redeemVoucher({ secret, claimId, events }) {
    const aiwa = this._aiwa;
    await aiwa.log.appendMany(events);
    const redeem = await buildSignedDelegatedVoucherRedeemEvent(
      this._delegation, { claimId, secret },
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
    );
    const redeemEvent = await createEvent(this.identity, {
      domain: aiwa.logDomain, parents: await aiwa.log.head(), type: 'delegated-voucher-redeem', payload: redeem,
    });
    await aiwa.log.append(redeemEvent);
    if (aiwa.replicator) await aiwa.replicator.publish(await collectAncestors(aiwa.log, [redeemEvent.id]));
    return { eventId: redeemEvent.id };
  }

  /**
   * Claims currently-claimable value into a real, spendable claim for
   * the real owner (this._delegation.from) — through this channel,
   * with no root-key involvement. Uses aiwa-core's own
   * buildSignedDelegatedClaimEvent ('delegated-claim'): a channel's
   * session key is a fresh, deterministic keypair distinct from the
   * owner's root key (see sessionKeypairFor), so it can never satisfy
   * aiwa-core's own domain-owner signature check on a plain 'claim'
   * event (deriveId(signerPubkey) === domain) — the identical reason
   * redeemVoucher() below needs 'delegated-voucher-redeem' instead of
   * plain 'voucher-redeem'. The already-issued real delegation
   * (this._delegation) is reused, exactly like every other Channel
   * action here; the owner's root key never signs again.
   */
  async claim(amount) {
    const aiwa = this._aiwa;
    const claimId = crypto.randomUUID();
    const signedClaim = await buildSignedDelegatedClaimEvent(
      this._delegation, { claimId, amount },
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
    );
    const event = await createEvent(this.identity, {
      domain: aiwa.logDomain, parents: await aiwa.log.head(), type: 'delegated-claim', payload: signedClaim,
    });
    await aiwa.log.append(event);
    if (aiwa.replicator) await aiwa.replicator.publish(await collectAncestors(aiwa.log, [event.id]));
    return { claimId, eventId: event.id };
  }

  /**
   * No protocol action is required to close a channel: nothing was
   * ever escrowed, so there is nothing to reclaim. HONEST LIMIT: there
   * is no revocation mechanism — an issued delegation has no expiry or
   * amount cap (by explicit design, see aiwa-core's own wallet.js), so
   * it remains valid for as long as the owner keeps using this same
   * root identity. This method exists for symmetry and for an
   * application's own bookkeeping (e.g. stop showing this channel as
   * "open" in a UI); it does not change what the delegation can do.
   */
  close() {}
}

/** A real, compact, transportable encoding for QR/NFC/Bluetooth — the same pattern aiwa-platform's own signaling-codec.js uses. */
export function encodeOfflineBundle(bundle) {
  return btoa(encodeURIComponent(JSON.stringify(bundle)));
}

export function decodeOfflineBundle(blob) {
  return JSON.parse(decodeURIComponent(atob(blob)));
}
