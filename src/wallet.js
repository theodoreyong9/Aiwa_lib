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
  EventLog, createMemoryBackend, createIndexedDbBackend, createEvent, deriveId,
  initialWalletState, applyWalletEvent, materializeWalletFromWireEvents, spendableClaims, totalBalance,
  buildSignedTransferEvent, buildSignedSplitEvent, claimableNow, toUnits, fromUnits,
  generateLightweightKeypair, lightweightKeypairFromSecretKey, deriveKeypairFromPassphrase,
  deriveKeypairFromBip39Mnemonic, generateBip39Mnemonic, keypairFromSecretKey, loadSolanaWeb3, toIdentity,
  broadcastBurnTransaction, SOLANA_INCINERATOR_ADDRESS, vdfSeed, computeVdfChain,
  issueDelegation, verifyDelegation, buildSignedDelegatedTransferEvent, buildSignedDelegatedSplitEvent,
  deriveVoucherAddress, buildSignedVoucherRedeemEvent, buildSignedDelegatedVoucherRedeemEvent,
  buildSignedAccrualEvent, buildSignedClaimEvent, buildSignedDelegatedClaimEvent,
  buildCheckpointEvent, findLatestCheckpoint, checkpointWalletState, progressionParents, buildSignedProgressionEvent,
  buildReceptionCommitment, assessPosition, identityCostFromCommitments, identityCostFromBurns,
  fetchBurnRecord, verifyBurnRecordFor, withConfirmedBurns,
  computeSuccinctEpochs, commitmentPriceLamports, MAX_PATIENCE_RATE, miningState, rankingFigure,
  miningChainHead, progressionSeed,
} from 'aiwa-core';
import { readWorld, observations, heldProgressions, nextReceptionEpoch } from './observation.js';

// A real, cryptographically random secret — 32 bytes, hex-encoded.
// This is what a voucher's QR code actually carries; whoever can
// reveal it first genuinely redeems the real value it hash-locks (see
// aiwa-core's own wallet.js for the full scheme).
function randomVoucherSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Order-independent comparison of two real head sets — used to decide whether the materialization cache is still current. */
function sameHeadSet(a, b) {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((id) => setA.has(id));
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

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// The real consent step a channel needs — see AIWA.requestChannel()'s
// own header for why a unilateral delegation alone was never enough.
// Only `requestId`/`from`/`accepting`/`timestamp` are signed here: the
// request's own delegation is ALREADY a complete, independently
// verifiable proof (verifyDelegation) of who's asking and for which
// session key, so there's nothing to duplicate — this signature exists
// purely to prove the ACCEPTING side's real, deliberate consent, tied
// to one specific request by its id.
function canonicalChannelAcceptMessage({ requestId, from, accepting, timestamp }) {
  return JSON.stringify({ requestId, from, accepting, timestamp });
}

export { fromUnits, toUnits, SOLANA_INCINERATOR_ADDRESS };

// Every event still in the log that is reachable from `ids`: unlike collectAncestors() it does not stop at an event
// that was pruned (a checkpoint's own parents are gone by design).
async function knownAncestors(log, ids) {
  const seen = new Set();
  const out = [];
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const event = await log.get(id);
    if (!event) continue;
    out.push(event);
    stack.push(...event.parents);
  }
  return out;
}

const MINING_TYPES = new Set(['burn-record', 'progression', 'accrual', 'claim']);
function isMiningEvent(event, domain) {
  return MINING_TYPES.has(event.type) && event.author === domain;
}

export class AIWA {
  constructor({ rewardParams, logDomain = 'aiwa', dbName, backend, autoObserve = true, connection = null, miningArchive, keepMiningHistory = true } = {}) {
    if (!rewardParams) {
      throw new Error('AIWA: rewardParams ({alpha, beta, gamma, C, minQ}) is required — this library never invents a deployment\'s own economic parameters.');
    }
    this.rewardParams = rewardParams;
    this.logDomain = logDomain;
    this.log = new EventLog(backend ?? (dbName ? createIndexedDbBackend(dbName) : createMemoryBackend()));
    // Pruning to a checkpoint deletes old events from the log. A validator that was never given them (a registry
    // checking this domain's age, say) needs the ones that prove it: this domain's own burn-record, progression,
    // accrual and claim events. They are set aside, whole, in this archive before pruning — `keepMiningHistory: false`
    // opts out (the history then stops at the last checkpoint). Raw storage, no log semantics: nothing in it is ever
    // folded, it only feeds exportMiningEvents().
    this._miningArchive = keepMiningHistory ? (miningArchive ?? (dbName && !backend ? createIndexedDbBackend(`${dbName}-mining`) : createMemoryBackend())) : null;
    this._keypair = null;
    this.identity = null;
    this.replicator = null;
    // Incremental materialization cache — see _materializeWallet()'s
    // own header for why this exists. this._domainId (unlike
    // this.identity) deliberately survives disconnect(): a Channel can
    // still call _materializeWallet() after the root identity clears,
    // and needs to know whose checkpoint to look for.
    this._materializedState = null;
    this._materializedHeads = null;
    // Everything already folded into _materializedState, by id — NOT
    // just the last-seen heads. See _materializeWallet()'s own header
    // for the real bug that using heads alone caused: progressionParents()
    // can add a real event's own last-progression id as an EXTRA parent
    // whenever it isn't already the head, and that edge reaches straight
    // past a heads-only exclusion boundary back into already-covered
    // territory, since it doesn't run through the excluded head itself.
    // Bounded by real activity since the last checkpoint, not all-time
    // history — exactly what periodic checkpoint()/pruneToLastCheckpoint()
    // calls are for.
    this._coveredIds = new Set();
    this._domainId = null;
    // Optional, app-set: (current, total) => void, called while
    // _materializeWallet() folds a real, potentially large backlog —
    // e.g. the very first call after a reload with no checkpoint yet,
    // still a real, unbounded-time replay from genesis. Never set by
    // this library itself; a wallet UI wanting a "catching up…"
    // indicator sets `aiwa.onMaterializeProgress = (i, total) => ...`
    // once, right after connect(). Left null, materialization is
    // silent, exactly as before.
    this.onMaterializeProgress = null;
    // Auto-checkpoint timer — see startAutoCheckpoint() below.
    this._checkpointTimer = null;
    this._lastCheckpointHeads = null;
    // Mirror: when events from another domain arrive (a live sync, an offline bundle), sign a reception
    // commitment for them — see observe(). On by default, because Mirror is meant to be continuous; turn it
    // off to call observe() yourself. onObserveError, if set, hears what a background observe() could not do.
    this.autoObserve = autoObserve;
    this.onObserveError = null;
    // Burns THIS wallet has confirmed against Solana (signature -> the record fetchBurnRecord returned). A
    // commitment counts only as far as confirmed burns cover it (aiwa-core, genesis commitment), so what is in here
    // decides what the wallet credits — to itself and to every other domain. `connection`, a Solana Connection, if
    // given, lets the wallet confirm by itself when events arrive; otherwise call confirmBurns(connection).
    this._burnRecords = {};
    this.connection = connection;
    this._observing = null;
    this._observeAgain = false;
  }

  // --- Wallet unlock (identity), fully offline -----------------------

  /**
   * Derives or generates the real keypair this wallet signs with. Fully offline — no network, no @solana/web3.js load.
   * With nothing given, a NEW identity is created from a fresh 12-word recovery phrase, readable as `recoveryPhrase`
   * while connected: write it down, it is the only way to be this identity again (connect({ mnemonic }) gives the same
   * address — the same one a Solana wallet derives from those words). Connecting with a mnemonic keeps it readable the
   * same way; with a passphrase or a raw secret key there is no phrase to show (`recoveryPhrase` is null).
   */
  async connect({ mnemonic, passphrase, secretKeyBytes } = {}) {
    let keypair;
    let phrase = null;
    if (secretKeyBytes) keypair = await lightweightKeypairFromSecretKey(secretKeyBytes);
    else if (passphrase) keypair = await deriveKeypairFromPassphrase(passphrase);
    else {
      phrase = (mnemonic ? mnemonic : await generateBip39Mnemonic(12)).trim().replace(/\s+/g, ' ').toLowerCase();
      keypair = await deriveKeypairFromBip39Mnemonic(phrase);
    }
    this._recoveryPhrase = phrase;
    this._keypair = keypair;
    this.identity = await toIdentity(keypair);
    this._domainId = this.identity.id;
    return { address: this.address, identityId: this.identity.id };
  }

  /** Clears the real keypair from memory. Already-synced local data (this.log) is untouched and stays fully readable. */
  async disconnect() {
    await this.leaveNetwork();
    this.stopProgressLoop();
    this.stopAutoCheckpoint();
    this._keypair = null;
    this._recoveryPhrase = null;
    this.identity = null;
  }

  /** The recovery phrase of this identity while connected (see connect()), or null when it was not made from one. Secret: whoever has it controls the wallet. */
  get recoveryPhrase() { return this._recoveryPhrase ?? null; }

  get connected() { return !!this.identity; }
  get address() { return this._keypair ? this._keypair.publicKey.toBase58() : null; }
  _requireConnected() { if (!this.identity) throw new Error('AIWA: not connected — call connect() first.'); }

  // --- The mining chain ---
  // A deployment that fixes the work of an epoch (rewardParams.epochIterations) makes a domain's mining events —
  // progression, accrual, claim — one signed chain: each names the one it follows (`previous`), and the work of an
  // epoch starts from it (aiwa-core, README). So an action and a stretch of work must not be built from the same
  // predecessor: one at a time reads the chain's head and appends, under this lock.
  get _chained() {
    const ei = this.rewardParams.epochIterations;
    return Number.isInteger(ei) && ei > 0;
  }

  _withMiningLock(fn) {
    const next = (this._miningLock ?? Promise.resolve()).then(() => fn());
    this._miningLock = next.then(() => {}, () => {});
    return next;
  }

  /** What the next mining event must name as `previous`: the id of this domain's last one, null before the first — or undefined when the deployment does not chain them. */
  async _miningPrevious() {
    if (!this._chained) return undefined;
    const { accrual } = await this._materializeWallet();
    return miningChainHead(accrual, this.identity.id);
  }

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
  async burn(lamports, connection, { T = 0 } = {}) {
    // T is checked BEFORE anything is broadcast: a burn is irreversible, a refusal after it is too late.
    this._checkPatienceRate(T);
    const solanaWeb3 = await loadSolanaWeb3();
    const keypair = await this.solanaKeypair();
    const signature = await broadcastBurnTransaction(solanaWeb3, connection, keypair, lamports);
    const { lamports: burned } = await this.recordBurn(signature, connection);
    // "Last action" mining: this burn REPLACES the position (the previous one is paid first, by the reducer), and the
    // capital that counts is what is left of the burn after T of it is destroyed without counting.
    await this.recordCommitment({ b: Math.floor(burned * (1 - T)) / 1e9, T });
    return signature;
  }

  _checkPatienceRate(T) {
    if (!Number.isFinite(T) || T < 0 || T > MAX_PATIENCE_RATE) {
      throw new Error(`AIWA: T (the patience rate, chosen at the burn) must be between 0 and ${MAX_PATIENCE_RATE}.`);
    }
  }

  /**
   * Asks Solana for the FINALIZED transaction `signature`, checks that it is a burn paid by THIS wallet's own key,
   * and — only then — publishes it ('burn-record': the signature, nothing else) so that the capital it covers can be
   * committed. burn() does this for you; call it yourself to finish a burn whose transaction was broadcast but could
   * not be confirmed at the time (Solana did not report it finalized yet).
   */
  async recordBurn(signature, connection = this.connection) {
    this._requireConnected();
    if (!connection) throw new Error('AIWA: recordBurn needs a Solana connection.');
    const record = await fetchBurnRecord(connection, signature);
    if (!record) throw new Error(`AIWA: Solana does not report ${signature} as a finalized transaction (yet) — call recordBurn(signature, connection) again later.`);
    const check = await verifyBurnRecordFor(this.identity.id, record);
    if (!check.valid) throw new Error(`AIWA: ${signature} is not a burn by this wallet: ${check.reason}`);
    this._noteBurnRecords({ [signature]: record });
    const event = await createEvent(this.identity, {
      domain: this.logDomain, parents: await this.log.head(), type: 'burn-record',
      payload: { domain: this.identity.id, signature },
    });
    await this.log.append(event);
    if (this.replicator) await this.replicator.publish(await collectAncestors(this.log, [event.id]));
    return { eventId: event.id, lamports: record.incineratorBalanceDeltaLamports };
  }

  /**
   * Confirms against Solana the burns that events in this log point at ('burn-record' events, from any domain) and
   * this wallet has not confirmed yet. What a burn is worth is what Solana says, never what an event says. A burn
   * Solana does not know (yet) stays pending, and the commitment it would cover stays uncredited until a later call.
   * @returns {Promise<{ confirmed: string[], pending: string[] }>}
   */
  async confirmBurns(connection = this.connection) {
    if (!connection) throw new Error('AIWA: confirmBurns needs a Solana connection.');
    const wire = await collectAncestors(this.log, await this.log.head());
    const wanted = [...new Set(wire.filter((e) => e.type === 'burn-record' && typeof e.payload?.signature === 'string').map((e) => e.payload.signature))];
    const confirmed = [];
    const pending = [];
    const found = {};
    for (const signature of wanted) {
      if (this._burnRecords[signature]) continue;
      let record = null;
      try { record = await fetchBurnRecord(connection, signature); } catch { /* unreachable: stays pending */ }
      if (record) { found[signature] = record; confirmed.push(signature); } else pending.push(signature);
    }
    if (confirmed.length > 0) this._noteBurnRecords(found);
    return { confirmed, pending };
  }

  // A newly confirmed burn changes what earlier commitments were worth: fold the log again from its base.
  _noteBurnRecords(records) {
    Object.assign(this._burnRecords, records);
    this._materializedState = null;
    this._materializedHeads = null;
    this._coveredIds = new Set();
  }

  // --- What this wallet has seen of other domains (Mirror), and where they stand ---

  /**
   * Signs and appends a reception commitment for every other domain whose progression this log holds beyond
   * what this wallet already committed to having seen — the recurring, signed "I received this of X" that
   * aiwa-core's Mirror is built on, and what gives the proofs of `position()` their witnesses. Only events that
   * are trusted are cited (see observation.js). Idempotent: nothing new, nothing appended.
   * Runs by itself after a sync or an offline bundle unless `autoObserve` was turned off.
   * @returns {Promise<{ committed: Array<{ sourceDomain: string, eventId: string, epoch: number }> }>}
   */
  async observe() {
    this._requireConnected();
    const me = this.identity.id;
    const world = await readWorld(this.log);
    let sequence = nextReceptionEpoch(world.mirror, me);
    const committed = [];
    for (const found of await observations(world, me, { epochIterations: this.rewardParams.epochIterations })) {
      const payload = await buildReceptionCommitment(this._keypair, me, sequence++, found.sourceDomain, [found.eventId]);
      const event = await createEvent(this.identity, {
        domain: this.logDomain, parents: await this.log.head(), type: 'reception', payload,
      });
      await this.log.append(event);
      // The observed domain and everyone else only count this as a witness once they hold it: same push as send().
      if (this.replicator) await this.replicator.publish(await collectAncestors(this.log, [event.id]));
      committed.push(found);
    }
    return { committed };
  }

  // One background observe() at a time; a request that arrives meanwhile is folded into one more run.
  _scheduleObserve() {
    if (!this.autoObserve || !this.identity) return;
    if (this._observing) { this._observeAgain = true; return; }
    this._observing = (async () => {
      try {
        do {
          this._observeAgain = false;
          if (this.connection) await this.confirmBurns(this.connection);
          if (this.identity) await this.observe();
        } while (this._observeAgain);
      } catch (err) {
        if (this.onObserveError) this.onObserveError(err); else console.error('AIWA: observe() failed:', err);
      } finally {
        this._observing = null;
      }
    })();
  }

  /** Resolves once any background observe() has finished (tests, and apps that want to read right after a sync). */
  async settled() {
    while (this._observing) await this._observing;
  }

  /**
   * Where `domain` stands, from everything this log holds: aiwa-core's assessPosition — a position that never
   * goes below what observers provably received; a rewind or a fork, only when there is proof; the weighted
   * median as the estimate. `selfReportedEpoch`, if the domain reported one, is judged against it.
   * A witness weighs what it committed (yellow paper §13: w_i = b_i) — the burns THIS wallet confirmed for it
   * (identityCostFromBurns); for a deployment that opted out of backed commitments, the capital the domain signed
   * into its own position (identityCostFromCommitments), its own statement. Read-only: needs no unlocked key. See aiwa-core's README (“Position”)
   * for exactly what it does and does not cover.
   */
  async position(domain, { selfReportedEpoch = null, tolerance, verifyChain } = {}) {
    const world = await readWorld(this.log);
    const wallet = await this._materializeWallet();
    return assessPosition({
      mirrorState: world.mirror,
      identityCostState: this.rewardParams.commitmentBacking === 'none' ? identityCostFromCommitments(wallet.accrual.positions) : identityCostFromBurns(wallet.accrual.burns),
      orderedEvents: world.events,
      targetDomain: domain, selfReportedEpoch, epochIterations: this.rewardParams.epochIterations, ...(tolerance === undefined ? {} : { tolerance }), ...(verifyChain === undefined ? {} : { verifyChain }),
    });
  }

  // --- Local AIWA ledger (fully offline; identical whether or not joinNetwork() is active) ---

  /**
   * REAL FIX, a real regression this library reintroduced (see this
   * repo's own README): every call used to fold the ENTIRE event list
   * from genesis, every time — balance()/claimable()/send() all paid
   * that cost on every single call, growing unboundedly for a
   * long-lived domain. Fixed here by caching the last materialized
   * state, and folding only the real events appended since, tracked via
   * the GROWING _coveredIds set (not just the latest heads — a real bug
   * found via this exact scenario: aiwa-core's own progressionParents()
   * can add a domain's last progression id as an EXTRA parent whenever
   * it isn't already the head, and that edge reaches straight past a
   * heads-only exclusion boundary back into already-covered territory —
   * collectAncestors would then re-walk and re-fold an already-covered
   * event, which aiwa-core's own causal-chain check then rejects as
   * "already advanced past this epoch"). Bounded by real activity since
   * the last checkpoint, not all-time history.
   *
   * On the very first call this session (no cache yet), also checks
   * for a real, self-authored checkpoint (aiwa-core's own
   * checkpoint.js) to resume from instead of genesis — the real fix
   * for unbounded local storage, once pruneToLastCheckpoint() below has
   * actually been used.
   *
   * HONEST LIMIT: this cache is in-memory only, per AIWA instance — it
   * does not survive a page reload by itself (an app wanting that can
   * persist {heads, state} itself, e.g. to IndexedDB, and seed a fresh
   * instance's own _materializedState/_materializedHeads from it).
   * HONEST LIMIT: two overlapping, un-awaited calls can race — whichever
   * finishes last wins the cache, which can briefly leave a slightly
   * stale entry; self-correcting on the next call either way, since
   * heads are always freshly re-read and compared first.
   */
  async _materializeWallet() {
    const heads = await this.log.head();
    if (this._materializedHeads && sameHeadSet(this._materializedHeads, heads)) return this._materializedState;

    let base = this._materializedState;
    if (!base) {
      const domain = this._domainId ?? this.identity?.id;
      const checkpoint = domain ? await findLatestCheckpoint(this.log, domain) : null;
      if (checkpoint) {
        base = checkpointWalletState(checkpoint);
        this._coveredIds = new Set(checkpoint.payload.coveredHeads);
      }
    }

    // excludeIds is the GROWING set of everything already folded — not
    // just the latest heads (see the constructor's own comment on
    // _coveredIds for the real bug that distinction fixes).
    const newEvents = await collectAncestors(this.log, heads, { excludeIds: this._coveredIds });
    // materializeWalletFromWireEvents, not materializeWallet: newEvents
    // are the real, un-adapted wire events, and might include a real
    // checkpoint appended since the last call (e.g. our own checkpoint()
    // + pruneToLastCheckpoint(), still within this same session) — only
    // the wire-event form lets its real signature (event.author) verify
    // at all, and repoints progression's lastId away from whatever it
    // just pruned. See aiwa-core's own checkpoint.js for the real bug
    // this closes.
    const state = await materializeWalletFromWireEvents(this.rewardParams, newEvents, this.onMaterializeProgress, undefined, {}, withConfirmedBurns(base ?? initialWalletState(), this._burnRecords));
    for (const event of newEvents) this._coveredIds.add(event.id);
    this._materializedState = state;
    this._materializedHeads = heads;
    return state;
  }

  /**
   * A real, self-signed checkpoint of your own current materialized
   * state, appended to your own log — the basis pruneToLastCheckpoint()
   * can safely discard prior local storage against. See aiwa-core's own
   * checkpoint.js for the real, honest tradeoff this makes: a brand-new
   * peer who only ever receives your pruned log trusts this
   * checkpoint's own real signature instead of independently
   * re-deriving your history from genesis.
   */
  async checkpoint() {
    this._requireConnected();
    const state = await this._materializeWallet();
    const heads = await this.log.head();
    const event = await buildCheckpointEvent(this.identity, {
      logDomain: this.logDomain, parents: heads, coveredHeads: heads, walletState: state,
    });
    await this.log.append(event);
    return { eventId: event.id, coveredHeads: heads };
  }

  /** Physically discards local storage for everything your own latest real checkpoint already accounts for. Returns how many real events were removed, or 0 if you have never checkpointed. */
  async pruneToLastCheckpoint() {
    const domain = this._domainId ?? this.identity?.id;
    if (!domain) throw new Error('AIWA: pruneToLastCheckpoint needs to know your own domain — connect() at least once first.');
    const checkpoint = await findLatestCheckpoint(this.log, domain);
    if (!checkpoint) return 0;
    if (this._miningArchive) {
      // what the checkpoint covers is about to go: set this domain's own mining events aside first
      for (const event of await knownAncestors(this.log, checkpoint.payload.coveredHeads)) {
        if (isMiningEvent(event, domain)) await this._miningArchive.putEvent(event);
      }
    }
    return this.log.pruneBeforeCheckpoint(checkpoint.id);
  }

  /**
   * This domain's own burn-record, progression, accrual and claim events — what a validator (an app, a registry)
   * needs to derive its mining state without trusting it: aiwa-core's assessMining() folds exactly these. Both what
   * is still in the log and what pruning set aside, each once. Ordered by creation time; a validator orders them
   * itself anyway. A validator that already derived the state up to some point only needs the events after it.
   * @param {object} [options]
   * @param {string} [options.after] the id of the last mining event the validator holds (its baseline's `chainHead`):
   *   only the events after it are returned — the chain of progression, accrual and claim events from there, and the
   *   burn records (a validator ignores the ones it already counted)
   * @param {number} [options.afterEpoch] leave out the progression events up to this epoch (when `after` is not known)
   */
  async exportMiningEvents({ afterEpoch = 0, after = null } = {}) {
    this._requireConnected();
    const byId = new Map();
    for (const event of await knownAncestors(this.log, await this.log.head())) {
      if (isMiningEvent(event, this.identity.id)) byId.set(event.id, event);
    }
    if (this._miningArchive) {
      for (const id of await this._miningArchive.allIds()) {
        const event = await this._miningArchive.getEvent(id);
        if (event) byId.set(event.id, event);
      }
    }
    let events = [...byId.values()];
    if (after) {
      // walk the chain back from its head to `after`: what the validator does not hold yet
      const tail = new Set();
      let id = this._chained ? await this._miningPrevious() : null;
      while (id && id !== after && byId.has(id) && !tail.has(id)) {
        tail.add(id);
        id = byId.get(id).payload.previous ?? null;
      }
      events = events.filter((e) => e.type === 'burn-record' || tail.has(e.id));
    } else {
      events = events.filter((e) => e.type !== 'progression' || e.payload.epoch > afterEpoch);
    }
    return events.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * What this wallet holds of OTHER domains' mining, as evidence for a registry: for each foreign domain whose
   * progression this log holds, the highest trusted progression event — signed by that domain, which is what makes it
   * a proof. A registry that keeps it asks that domain, the next time it submits, to show a history that contains it:
   * a wallet cannot keep two histories and show only the favourable one once someone else holds the other. Nothing
   * here is signed by this wallet and nothing needs trusting it: the events are the other domain's.
   * @param {{ max?: number }} [options] at most this many domains (the ones furthest along first)
   */
  async witnesses({ max = 20 } = {}) {
    this._requireConnected();
    const world = await readWorld(this.log);
    const held = await heldProgressions(world, this.identity.id, { epochIterations: this.rewardParams.epochIterations });
    const byId = new Map(world.wire.map((e) => [e.id, e]));
    return held
      .sort((a, b) => b.epoch - a.epoch)
      .slice(0, max)
      .map((h) => byId.get(h.eventId))
      .filter(Boolean);
  }

  /**
   * The evidence an app takes (aiwa-core's `assessSubmission`): this domain's mining events since what the app already
   * holds, and the witnesses — what this wallet holds of other domains. `{ version, domain, afterEpoch, events,
   * witnesses }`, ready to be sent as is.
   * @param {object} [options]
   * @param {number} [options.afterEpoch] the epoch of the app's baseline for this domain (0 if it has none)
   * @param {string} [options.after] the chain head of that baseline (`baseline.head`): only what follows is returned
   * @param {number} [options.maxWitnesses]
   */
  async submissionEvidence({ afterEpoch = 0, after = null, maxWitnesses = 20 } = {}) {
    this._requireConnected();
    return {
      version: 1,
      domain: this.identity.id,
      afterEpoch,
      events: await this.exportMiningEvents({ afterEpoch, after }),
      witnesses: await this.witnesses({ max: maxWitnesses }),
    };
  }

  /** The mining state of this wallet: the capital that mines, T, the epoch of the last action, the age, the claimable now (aiwa-core's miningState). Null before the first burn. */
  async mining() {
    this._requireConnected();
    return miningState(this.rewardParams, await this._materializeWallet(), this.identity.id);
  }

  /** The ranking figure of this wallet — { score, laps, epoch } — what an app ranks by (aiwa-core's rankingFigure). Null before the first burn. */
  async ranking() {
    return rankingFigure(await this.mining());
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
    this._checkPatienceRate(T);
    return this._withMiningLock(() => this._recordCommitment({ b, T }));
  }

  async _recordCommitment({ b, T }) {
    // Capital is what a confirmed burn covers (aiwa-core, genesis commitment): refuse here, with the reason, rather
    // than append an event every reader would reject. A commitment costs ceil(b / (1 - T)) lamports of burn that no
    // earlier commitment used. Deployments that opted out (commitmentBacking: 'none') skip this.
    if (this.rewardParams.commitmentBacking !== 'none') {
      const { accrual } = await this._materializeWallet();
      const price = commitmentPriceLamports(b, T);
      const covered = accrual.burns?.covered?.[this.identity.id] ?? 0;
      const consumed = accrual.burns?.consumed?.[this.identity.id] ?? 0;
      if (consumed + price > covered) {
        throw new Error(`AIWA: a commitment of ${b} at T=${T} is not covered by the burns confirmed for this wallet: it costs ${price} lamports, ${covered - consumed} are left (${covered} confirmed, ${consumed} already used). Burn first — burn(lamports, connection) or recordBurn(signature, connection).`);
      }
    }
    const signedAccrual = await buildSignedAccrualEvent(
      { domain: this.identity.id, b, T, previous: await this._miningPrevious() },
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
  async advanceProgress({ vdfIterations = 100_000, epochs = 1 } = {}) {
    this._requireConnected();
    // A deployment that fixes the work of an epoch (rewardParams.epochIterations) gets the succinct kind, chained to
    // the domain's last mining event: `epochs` epochs in one event, epochs x epochIterations squarings starting from
    // that event, and ONE proof that anyone checks in milliseconds (aiwa-core's succinct-vdf.js).
    if (this._chained) return this._advanceChained({ epochs });
    // Otherwise the original: one epoch, a hash chain of `vdfIterations`.
    const state = await this._materializeWallet();
    const current = state.accrual.progression.domains[this.identity.id] ?? { epoch: 0, vdfOutput: null, lastId: null };
    const seed = vdfSeed(this.identity.id, current.vdfOutput ?? 'genesis');
    const epoch = current.epoch + 1;
    const vdfOutput = await computeVdfChain(seed, vdfIterations);
    // progressionParents(), not just log.head(): if anything else (a recordCommitment(), a checkpoint()) was
    // appended for this domain since the last progression tick, the log's real head is THAT event, not the last
    // progression event — aiwa-core's own causal chain check requires the latter as a direct parent too, or every
    // progression event from here on is silently rejected forever. Read AFTER the work: it can take a while.
    const parents = progressionParents(await this.log.head(), current.lastId);
    const signedProgression = await buildSignedProgressionEvent(
      { domain: this.identity.id, epoch, vdfIterations, vdfOutput },
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
    );
    const event = await createEvent(this.identity, {
      domain: this.logDomain, parents, type: 'progression', payload: signedProgression,
    });
    await this.log.append(event);
    return { epoch, eventId: event.id };
  }

  // The work starts from the domain's last mining event, so it is only good if that is still the last one when it
  // ends: an action made meanwhile (a burn, a claim) moves the chain on, and this work is dropped and done again
  // from the new head (a few seconds at most). `eventId: null, discarded: true` if the chain would not hold still.
  async _advanceChained({ epochs }) {
    const id = this.identity.id;
    const iterations = epochs * this.rewardParams.epochIterations;
    let epoch = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this._materializeWallet();
      const current = state.accrual.progression.domains[id] ?? { epoch: 0, vdfOutput: null, lastId: null };
      const previous = miningChainHead(state.accrual, id);
      epoch = current.epoch + epochs;
      const { vdfOutput, vdfProof } = await computeSuccinctEpochs(progressionSeed(id, current.vdfOutput, previous), iterations);
      const made = await this._withMiningLock(async () => {
        if ((await this._miningPrevious()) !== previous) return null;
        const signed = await buildSignedProgressionEvent(
          { domain: id, epoch, vdfIterations: iterations, vdfOutput, previous },
          this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
        );
        const event = await createEvent(this.identity, {
          domain: this.logDomain, parents: await this.log.head(), type: 'progression', payload: { ...signed, vdfProof },
        });
        await this.log.append(event);
        return { epoch, eventId: event.id };
      });
      if (made) return made;
    }
    return { epoch: epoch - epochs, eventId: null, discarded: true };
  }

  /** Calls advanceProgress() on a real timer until stopProgressLoop() — the practical way a wallet UI keeps its own claimable() genuinely growing while open. Errors are surfaced via onError rather than left to reject silently in the background. */
  startProgressLoop({ intervalMs = 30_000, vdfIterations = 100_000, epochs = 1, onError } = {}) {
    this.stopProgressLoop();
    this._progressTimer = setInterval(() => {
      // A slow device may still be at work when the next tick fires: never two at once (they would chain from the
      // same epoch, and one would be refused).
      if (this._progressBusy) return;
      this._progressBusy = true;
      this.advanceProgress({ vdfIterations, epochs }).catch((err) => onError?.(err)).finally(() => { this._progressBusy = false; });
    }, intervalMs);
  }

  stopProgressLoop() {
    if (this._progressTimer) {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
  }

  /**
   * Calls checkpoint() + pruneToLastCheckpoint() on a real timer until
   * stopAutoCheckpoint() — the practical way a long-lived wallet keeps
   * its OWN next cold load (a page reload, a restart) fast and bounded,
   * instead of a real, ever-growing full replay from genesis every
   * single time. Skips a real checkpoint entirely when nothing genuinely
   * changed since the last one (same real log heads) — never creates a
   * pointless, empty checkpoint just because the timer fired. Errors are
   * surfaced via onError, same as startProgressLoop().
   */
  startAutoCheckpoint({ intervalMs = 5 * 60_000, onError } = {}) {
    this.stopAutoCheckpoint();
    this._checkpointTimer = setInterval(() => {
      // One round at a time: a round that has not finished (a long archive, a slow device) must not overlap the next.
      if (this._checkpointBusy) return;
      this._checkpointBusy = true;
      this.log.head().then((heads) => {
        if (this._lastCheckpointHeads && sameHeadSet(this._lastCheckpointHeads, heads)) return;
        return this.checkpoint()
          .then(() => this.pruneToLastCheckpoint())
          .then(() => { this._lastCheckpointHeads = heads; });
      }).catch((err) => onError?.(err)).finally(() => { this._checkpointBusy = false; });
    }, intervalMs);
  }

  stopAutoCheckpoint() {
    if (this._checkpointTimer) {
      clearInterval(this._checkpointTimer);
      this._checkpointTimer = null;
    }
  }

  /** Moves `amount` (decimal string) from claimable into a real, spendable claim you own. */
  async claim(amount) {
    this._requireConnected();
    return this._withMiningLock(async () => {
      const heads = await this.log.head();
      const claimId = crypto.randomUUID();
      const signedClaim = await buildSignedClaimEvent(
        { domain: this.identity.id, amount, claimId, previous: await this._miningPrevious() },
        this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
      );
      const event = await createEvent(this.identity, {
        domain: this.logDomain, parents: heads, type: 'claim', payload: signedClaim,
      });
      await this.log.append(event);
      return { claimId, eventId: event.id };
    });
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
    // status: 'confirmed' — this real, existing path is a UNILATERAL
    // delegation, exactly as it always was: you alone decide, the peer
    // never consents to anything before it's already usable. Real
    // consent from both sides needs requestChannel()/acceptChannelRequest()
    // below instead.
    return new Channel({ aiwa: this, peerId, sessionKeypair, sessionIdentity, delegation, status: 'confirmed' });
  }

  /**
   * REAL HANDSHAKE, STEP 1 — the real fix for a real gap in openChannel()
   * above: that path is unilateral, the peer never consents to anything
   * before the channel is already usable — not a real "channel between
   * two peers" in any meaningful sense, just a delegation one side
   * issues to itself. This builds the identical session key + real
   * delegation, but returns it as a small, portable, independently
   * verifiable blob (`verifyDelegation`, aiwa-core) instead of an
   * immediately-usable Channel — hand it to `peerId` over ANY real
   * channel: a live network message, pasted text, a QR code, NFC,
   * Bluetooth. This never picks one itself, exactly like
   * sendOfflineBundle()'s own offline blob — genuinely works with both
   * sides fully disconnected from any network.
   *
   * The returned Channel is PENDING: every action on it (send, claim,
   * issueVoucher, redeemVoucher) throws until the peer's own real
   * acceptChannelRequest() response comes back and is handed to
   * `channel.confirm()` — see that method's own header for exactly what
   * "confirmed" verifies.
   */
  async requestChannel(peerId) {
    this._requireConnected();
    const sessionKeypair = await sessionKeypairFor(this._keypair, peerId);
    const sessionIdentity = await toIdentity(sessionKeypair);
    const delegation = await issueDelegation(
      this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(), sessionKeypair.publicKey.toBytes(),
    );
    const requestId = crypto.randomUUID();
    const channel = new Channel({ aiwa: this, peerId, sessionKeypair, sessionIdentity, delegation, status: 'pending', requestId });
    const request = { type: 'channel-request', requestId, peerId, delegation, timestamp: Date.now() };
    return { blob: encodeOfflineBundle(request), channel };
  }

  /**
   * REAL HANDSHAKE, STEP 2 — the peer's own side: decodes and verifies
   * a requestChannel() blob (real signature check via
   * verifyDelegation() alone — no EventLog, no state, so this works
   * fully offline too), then produces a real, signed acknowledgment
   * proving THIS identity genuinely, deliberately consents to a channel
   * with the real requester (`request.delegation.from`). Hand the
   * returned blob back to them over the identical real channel the
   * request arrived on — network, QR, NFC, Bluetooth, whatever was
   * actually available. Never appends anything or touches this
   * identity's own log: accepting a channel request is not, by itself,
   * a real economic action.
   */
  async acceptChannelRequest(requestBlob) {
    this._requireConnected();
    const request = decodeOfflineBundle(requestBlob);
    if (request?.type !== 'channel-request') throw new Error('acceptChannelRequest: not a real channel-request blob.');
    if (!(await verifyDelegation(request.delegation))) {
      throw new Error('acceptChannelRequest: the embedded delegation does not really verify — refusing to accept.');
    }
    const timestamp = Date.now();
    const accepting = request.delegation.from;
    const message = canonicalChannelAcceptMessage({ requestId: request.requestId, from: this.identity.id, accepting, timestamp });
    const signature = await this.identity.sign(new TextEncoder().encode(message));
    const accept = {
      type: 'channel-accept', requestId: request.requestId, from: this.identity.id, accepting,
      timestamp, signerPubkey: this.identity.publicKey, signature,
    };
    return encodeOfflineBundle(accept);
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
    this._scheduleObserve();
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
    this._scheduleObserve();
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
    // Events that just arrived from a peer: commit to having received them (see observe()).
    this._unsubObserve = this.replicator.onSync(({ receivedCount }) => { if (receivedCount > 0) this._scheduleObserve(); });
    await this.replicator.start();
  }

  async leaveNetwork() {
    if (this.replicator) {
      this._unsubObserve?.();
      this._unsubObserve = null;
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
  constructor({ aiwa, peerId, sessionKeypair, sessionIdentity, delegation, status = 'confirmed', requestId = null }) {
    this._aiwa = aiwa;
    this.peerId = peerId;
    this._keypair = sessionKeypair;
    this.identity = sessionIdentity;
    this._delegation = delegation;
    this.status = status; // 'pending' (from requestChannel(), needs confirm()) or 'confirmed' (usable)
    this._requestId = requestId;
  }

  /** This channel's own real, deterministic session address — distinct from your own root address, one per peer. */
  get address() { return this._keypair.publicKey.toBase58(); }

  _requireConfirmed() {
    if (this.status !== 'confirmed') {
      throw new Error('Channel: not confirmed yet — the peer has not accepted this channel request (see AIWA.requestChannel()/acceptChannelRequest(), and this channel\'s own confirm()).');
    }
  }

  /**
   * REAL HANDSHAKE, STEP 3 — verifies `acceptBlob` (from the peer's own
   * real acceptChannelRequest()) and, only if it genuinely checks out,
   * marks this channel confirmed: send()/claim()/issueVoucher()/
   * redeemVoucher() all refuse to run before this. Three real things
   * are checked, all of them load-bearing:
   *   - `accept.requestId` really matches THIS channel's own request
   *     (never some other, unrelated accept);
   *   - the signature really verifies, AND the signer really derives
   *     `accept.from` (an ordinary forged-pubkey check, same as every
   *     other signed payload in this codebase);
   *   - `accept.from` really is the peer THIS channel was opened
   *     for — without this, any third party who merely obtained the
   *     request blob (never secret; a delegation is meant to be handed
   *     over) could "accept" a channel meant for someone else,
   *     defeating the entire point of asking for real consent.
   * Works fully offline: no EventLog, no network, no state beyond this
   * one object.
   */
  async confirm(acceptBlob) {
    const accept = decodeOfflineBundle(acceptBlob);
    if (accept?.type !== 'channel-accept') throw new Error('Channel.confirm: not a real channel-accept blob.');
    if (accept.requestId !== this._requestId) throw new Error('Channel.confirm: this accept is for a different channel request.');
    if (accept.accepting !== this._delegation.from) throw new Error('Channel.confirm: this accept was not addressed to you.');
    if (accept.from !== this.peerId) throw new Error('Channel.confirm: accepted by someone other than the real peer this channel was opened for.');
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    if ((await deriveId(fromHex(accept.signerPubkey))) !== accept.from) throw new Error('Channel.confirm: the signer does not really derive the claimed identity.');
    const message = canonicalChannelAcceptMessage({ requestId: accept.requestId, from: accept.from, accepting: accept.accepting, timestamp: accept.timestamp });
    let sigValid;
    try {
      sigValid = ed25519.verify(fromHex(accept.signature), new TextEncoder().encode(message), fromHex(accept.signerPubkey));
    } catch {
      sigValid = false;
    }
    if (!sigValid) throw new Error('Channel.confirm: the real signature does not verify.');
    this.status = 'confirmed';
  }

  /** The same real EventLog the owner's own AIWA instance uses — for passing into aiwa-platform functions that take a log directly (e.g. publishBundle(channel.identity, channel.log, domain, {...})), independent of whether the owner's root identity is currently connected. */
  get log() { return this._aiwa.log; }

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
    this._requireConfirmed();
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
    this._requireConfirmed();
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
    this._requireConfirmed();
    const aiwa = this._aiwa;
    const claimId = crypto.randomUUID();
    const event = await aiwa._withMiningLock(async () => {
      const signedClaim = await buildSignedDelegatedClaimEvent(
        this._delegation, { claimId, amount, previous: await aiwa._miningPrevious() },
        this._keypair.secretKey.slice(0, 32), this._keypair.publicKey.toBytes(),
      );
      const made = await createEvent(this.identity, {
        domain: aiwa.logDomain, parents: await aiwa.log.head(), type: 'delegated-claim', payload: signedClaim,
      });
      await aiwa.log.append(made);
      return made;
    });
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
