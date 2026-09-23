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
} from 'aiwa-core';
import { Replicator } from 'aiwa-platform';
import { collectAncestors } from './ancestors.js';

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

  /** A real, irreversible burn to Solana's own incinerator address — the real activation cost this deployment's identity-cost.js verifies. Returns the real transaction signature. */
  async burn(lamports, connection) {
    const solanaWeb3 = await loadSolanaWeb3();
    const keypair = await this.solanaKeypair();
    return broadcastBurnTransaction(solanaWeb3, connection, keypair, lamports);
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
    const event = await createEvent(this.identity, {
      domain: this.logDomain, parents: await this.log.head(), type: 'accrual',
      payload: { domain: this.identity.id, b, T },
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
    const event = await createEvent(this.identity, {
      domain: this.logDomain, parents: heads, type: 'claim',
      payload: { domain: this.identity.id, amount, claimId },
    });
    await this.log.append(event);
    return { claimId, eventId: event.id };
  }

  /**
   * Sends `amount` (decimal string) of already-claimed AIWA to
   * `toIdentityId`, real signature and all. Splits an existing claim
   * first if none matches the amount exactly.
   *
   * HONEST LIMIT (v1): requires a SINGLE active claim >= `amount` —
   * does not yet combine several smaller claims to reach it. Claim
   * consolidation (splitting into round denominations, or merging) is
   * a real, separate, not-yet-built convenience, not a protocol limit.
   */
  async send(toIdentityId, amount) {
    this._requireConnected();
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

    const signedTransfer = await buildSignedTransferEvent(
      { claimId: sourceClaim.id, from: this.identity.id, to: toIdentityId },
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
    );
    const transferEvent = await createEvent(this.identity, {
      domain: this.logDomain, parents: await this.log.head(), type: 'transfer', payload: signedTransfer,
    });
    await this.log.append(transferEvent);
    events.push(transferEvent);

    return { events, newClaimId: `activated:${sourceClaim.id}:${this.identity.id}:${toIdentityId}:0:identity` };
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

  /** Appends a real offline bundle (from sendOfflineBundle, or its own encodeOfflineBundle) — real signature/causal verification, identical to any other real append. */
  async receiveOfflineBundle(bundle) {
    this._requireConnected();
    await this.log.appendMany(bundle.events);
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

/** A real, compact, transportable encoding for QR/NFC/Bluetooth — the same pattern aiwa-platform's own signaling-codec.js uses. */
export function encodeOfflineBundle(bundle) {
  return btoa(encodeURIComponent(JSON.stringify(bundle)));
}

export function decodeOfflineBundle(blob) {
  return JSON.parse(decodeURIComponent(atob(blob)));
}
