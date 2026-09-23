import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendableClaims, EventLog } from 'aiwa-core';
import { LoopbackTransport } from 'aiwa-platform';
import { AIWA, encodeOfflineBundle, decodeOfflineBundle, fromUnits, toUnits } from '../src/wallet.js';

// The same real test economic parameters aiwa-core's own test suite
// uses (see wallet.test.mjs/accrual.test.mjs there) — a real
// deployment chooses its own; this file never invents one.
const rewardParams = { alpha: 1.1, beta: 2.2, gamma: 3, C: Math.pow(33, 3), minQ: 1 };
const VDF_ITERATIONS = 50; // small — a real deployment uses far more; this only needs to be a REAL, valid chain, not a slow one, for these tests

test('connect() derives a real identity and a real, displayable Solana address', async () => {
  const aiwa = new AIWA({ rewardParams });
  assert.equal(aiwa.connected, false);
  assert.equal(aiwa.address, null);
  const { address, identityId } = await aiwa.connect();
  assert.equal(aiwa.connected, true);
  assert.equal(aiwa.address, address);
  assert.ok(typeof address === 'string' && address.length > 30, 'a real base58 Solana address');
  assert.ok(typeof identityId === 'string' && identityId.length === 64, 'a real 32-byte hex SHA-256 id');
});

test('connect() is deterministic from the same secret key bytes', async () => {
  const a = new AIWA({ rewardParams });
  const { address: addr1 } = await a.connect();
  const secretKeyBytes = a._keypair.secretKey;

  const b = new AIWA({ rewardParams });
  const { address: addr2 } = await b.connect({ secretKeyBytes });
  assert.equal(addr2, addr1);
});

test('connect() from a passphrase is deterministic and reproduces the same real identity', async () => {
  const a = new AIWA({ rewardParams });
  const b = new AIWA({ rewardParams });
  const resultA = await a.connect({ passphrase: 'correct horse battery staple' });
  const resultB = await b.connect({ passphrase: 'correct horse battery staple' });
  assert.equal(resultA.address, resultB.address);
  assert.equal(resultA.identityId, resultB.identityId);
});

test('disconnect() clears the real identity but never touches already-synced local data', async () => {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  await aiwa.recordCommitment({ b: 10 });
  await aiwa.disconnect();
  assert.equal(aiwa.connected, false);
  assert.equal(aiwa.address, null);
  assert.equal(await aiwa.log.head().then((h) => h.length), 1, 'the real committed event is still in the local log');
});

test('claimable() is genuinely 0 with no real progression ever recorded — this is not a bug, see the file\'s own HONEST LIMIT', async () => {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  await aiwa.recordCommitment({ b: 10 });
  assert.equal(await aiwa.claimable(), '0');
});

test('the real accrual -> progression -> claimable -> claim -> balance pipeline', async () => {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  await aiwa.recordCommitment({ b: 10 });
  for (let i = 0; i < 5; i++) await aiwa.advanceProgress({ vdfIterations: VDF_ITERATIONS });

  const claimable = await aiwa.claimable();
  assert.ok(Number(claimable) > 0, `expected real claimable growth, got ${claimable}`);

  await aiwa.claim(claimable);
  const balance = await aiwa.balance();
  assert.equal(balance, claimable);
});

// Found via a real, live browser run of the AIWA_project wallet UI:
// balance() includes claimable() — value that has accrued but was
// never actually moved into a real, spendable claim. A UI that reads
// balance() and tries to send() that full amount hits a confusing "No
// single active claim covers..." error, since claimable value simply
// cannot be sent until claim()'d. This reproduces that exact failure,
// then confirms spendableBalance() is the real, always-correct answer
// to "how much can I actually send right now."
test('spendableBalance() is the actually-sendable amount — never inflated by claimable(), which balance() includes but cannot itself be sent', async () => {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  await aiwa.recordCommitment({ b: 10 });
  for (let i = 0; i < 5; i++) await aiwa.advanceProgress({ vdfIterations: VDF_ITERATIONS });

  // Before any claim: claimable > 0, but nothing is genuinely spendable yet.
  const claimableBefore = await aiwa.claimable();
  assert.ok(Number(claimableBefore) > 0);
  assert.equal(await aiwa.spendableBalance(), '0');
  assert.equal(await aiwa.balance(), claimableBefore, 'balance() includes not-yet-claimed value');

  // Sending the full "balance" here is exactly the mistake the real
  // browser run of the wallet UI made — it fails, since none of it is
  // actually in a real, spendable claim yet.
  await assert.rejects(aiwa.send('bob', claimableBefore), /No single active claim/);

  await aiwa.claim(claimableBefore);

  // Now it genuinely is spendable, and spendableBalance() says so.
  assert.equal(await aiwa.spendableBalance(), claimableBefore);
  await assert.doesNotReject(aiwa.send('bob', await aiwa.spendableBalance()));
});

test('send() rejects when no single active claim covers the amount (v1 limitation, not a crash)', async () => {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  await assert.rejects(aiwa.send('someone', '1.0'), /No single active claim/);
});

test('send() splits an existing claim when no exact match exists', async () => {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  await aiwa.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await aiwa.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await aiwa.claimable();
  await aiwa.claim(claimable);

  const sendAmount = (Number(claimable) / 3).toFixed(18).replace(/0+$/, '').replace(/\.$/, '.0');
  const { events } = await aiwa.send('bob-identity-id', sendAmount);
  assert.equal(events.length, 2, 'a split event, then a transfer event');
  assert.equal(events[0].type, 'split');
  assert.equal(events[1].type, 'transfer');
});

test('a full, real, fully OFFLINE transfer between two independent wallets with zero prior sync', async () => {
  const alice = new AIWA({ rewardParams });
  await alice.connect();
  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);
  assert.equal(await alice.balance(), claimable);

  const bob = new AIWA({ rewardParams }); // a genuinely separate wallet, own EventLog, own identity, zero prior sync with alice
  const { identityId: bobId } = await bob.connect();

  // The real, offline path: alice builds a self-contained bundle —
  // real signed events plus every real ancestor bob would otherwise
  // be missing — encodes it exactly as a QR code payload would be,
  // and bob decodes + appends it with NO network involved anywhere.
  const bundle = await alice.sendOfflineBundle(bobId, claimable);
  const blob = encodeOfflineBundle(bundle);
  assert.ok(typeof blob === 'string' && blob.length > 0);

  const decoded = decodeOfflineBundle(blob);
  await bob.receiveOfflineBundle(decoded);

  assert.equal(await bob.balance(), claimable);
  assert.equal(await alice.balance(), '0', "alice's own claim is now fully transferred away");
});

test('receiveOfflineBundle rejects a tampered bundle — real signature/causal verification, not trust', async () => {
  const alice = new AIWA({ rewardParams });
  await alice.connect();
  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  const bob = new AIWA({ rewardParams });
  const { identityId: bobId } = await bob.connect();
  const bundle = await alice.sendOfflineBundle(bobId, claimable);

  const tampered = { events: bundle.events.map((e) => (e.type === 'transfer' ? { ...e, payload: { ...e.payload, to: 'someone-else' } } : e)) };
  await assert.rejects(bob.receiveOfflineBundle(tampered), /verification|Verification/i);
});

test('fromUnits/toUnits round-trip a real decimal amount', () => {
  assert.equal(fromUnits(toUnits('1.5')), '1.5');
  assert.equal(fromUnits(toUnits('0.000000000000000001')), '0.000000000000000001');
});

test('openChannel() requires a live network session by default', async () => {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  await assert.rejects(aiwa.openChannel('bob-id'), /no live network session/);
});

test('"sign once, click many times": a real Channel sends repeatedly without the root key signing again', async () => {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  await aiwa.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await aiwa.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await aiwa.claimable();
  await aiwa.claim(claimable);

  const channel = await aiwa.openChannel('bob-id', { requireNetwork: false });
  assert.ok(typeof channel.address === 'string' && channel.address.length > 30);
  assert.notEqual(channel.address, aiwa.address, 'the channel\'s own session address must differ from the root address');

  const third = (Number(claimable) / 3).toString();
  await channel.send(third);
  await channel.send(third);

  const state = await aiwa._materializeWallet();
  const bobClaims = spendableClaims(state, 'bob-id');
  assert.equal(bobClaims.length, 2, 'two real, independent clicks, each its own real delegated transfer');
});

test('openChannel() derives the SAME session key for the same peer every time — recoverable after a crash', async () => {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  const channelA = await aiwa.openChannel('bob-id', { requireNetwork: false });
  const channelB = await aiwa.openChannel('bob-id', { requireNetwork: false }); // simulates re-opening after a restart, same root identity
  assert.equal(channelA.address, channelB.address);
});

test('openChannel() derives a DIFFERENT session key for a different peer', async () => {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  const toBob = await aiwa.openChannel('bob-id', { requireNetwork: false });
  const toCarol = await aiwa.openChannel('carol-id', { requireNetwork: false });
  assert.notEqual(toBob.address, toCarol.address);
});

test('a channel sent OFFLINE bundle is independently verifiable by a stranger with zero prior sync', async () => {
  const alice = new AIWA({ rewardParams });
  await alice.connect();
  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  const bob = new AIWA({ rewardParams });
  const { identityId: bobId } = await bob.connect();

  const channel = await alice.openChannel(bobId, { requireNetwork: false });
  const bundle = await channel.sendOfflineBundle(claimable);
  await bob.receiveOfflineBundle(bundle);

  assert.equal(await bob.balance(), claimable);
});

test('SECURITY: a channel cannot move a claim the root identity does not actually own', async () => {
  const alice = new AIWA({ rewardParams });
  await alice.connect();
  const channel = await alice.openChannel('bob-id', { requireNetwork: false });
  await assert.rejects(channel.send('1.0'), /No single active claim/);
});

test('a channel keeps working — balance() AND a real split — after the owner\'s root identity disconnects', async () => {
  const alice = new AIWA({ rewardParams });
  await alice.connect();
  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  const channel = await alice.openChannel('bob-id', { requireNetwork: false });
  await alice.disconnect(); // root key + identity gone from memory — channel must not need either again

  await assert.doesNotReject(channel.balance(), 'balance() must not require aiwa.identity — it reads the owner\'s id from the delegation itself');
  assert.equal(await channel.balance(), claimable);

  // No existing claim matches this amount exactly — this MUST split,
  // and splitting must not fall back to the (now absent) root key.
  const partial = (Number(claimable) / 3).toString();
  await assert.doesNotReject(channel.send(partial));
  await assert.doesNotReject(channel.send(partial));

  const state = await alice._materializeWallet();
  const bobClaims = spendableClaims(state, 'bob-id');
  assert.equal(bobClaims.length, 2, 'two real, independent delegated sends, each needing its own real, delegate-signed split — no root key involved for either');
});

test('a real bearer voucher: "the QR can be copied, but only the first redemption succeeds"', async () => {
  const alice = new AIWA({ rewardParams });
  await alice.connect();
  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  const voucher = await alice.issueVoucher(claimable);
  assert.ok(voucher.secret.length >= 32, 'a real, long random secret — this is what goes in the QR code');

  // Encoded/decoded exactly like any other offline bundle — the same
  // compact, transportable format, zero prior sync required.
  const blob = encodeOfflineBundle(voucher);
  const decoded = decodeOfflineBundle(blob);

  const bob = new AIWA({ rewardParams });
  const { identityId: bobId } = await bob.connect();
  await bob.redeemVoucher(decoded);

  assert.equal(await bob.balance(), claimable);
  assert.equal(await bob.spendableBalance(), claimable, 'a real, immediately spendable claim — not just claimable');
});

test('SECURITY: a real "only once" property through the wallet API — two real wallets, each honestly redeeming the identical voucher offline, converge to exactly one winner once synced', async () => {
  const alice = new AIWA({ rewardParams });
  await alice.connect();
  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  const voucher = await alice.issueVoucher(claimable);
  const blob = encodeOfflineBundle(voucher);

  const bob = new AIWA({ rewardParams });
  const { identityId: bobId } = await bob.connect();
  const carol = new AIWA({ rewardParams });
  const { identityId: carolId } = await carol.connect();

  // Both scanned the identical QR, both fully offline — each locally
  // believes their own redemption succeeded (this is the SAME
  // real, documented, offline-first "detection via reconciliation, not
  // real-time prevention" limit this README already states — a real
  // conflict only surfaces once they sync, exactly like a duplicated
  // paper check). What matters is what a REAL sync between them
  // (or with alice) resolves to.
  await bob.redeemVoucher(decodeOfflineBundle(blob));
  await carol.redeemVoucher(decodeOfflineBundle(blob));

  const mergedLog = new EventLog();
  for (const log of [bob.log, carol.log]) {
    const events = await Promise.all((await log.backend.allIds()).map((id) => log.get(id)));
    await mergedLog.appendMany(events);
  }
  const merged = new AIWA({ rewardParams, backend: mergedLog.backend });
  const state = await merged._materializeWallet();

  const bobGotIt = spendableClaims(state, bobId).length === 1;
  const carolGotIt = spendableClaims(state, carolId).length === 1;
  assert.notEqual(bobGotIt, carolGotIt, 'exactly one of the two real redemptions survives a real sync — never both, never neither');
});

test('REGRESSION: send() over a live network session actually reaches an already-connected peer — it silently did not before this fix', async () => {
  const alice = new AIWA({ rewardParams });
  const aliceId = await alice.connect();
  const bob = new AIWA({ rewardParams });
  const bobId = await bob.connect();

  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  // Both join and complete their real, one-time HELLO handshake BEFORE
  // the send below — the exact ordering that exposed the real bug:
  // Replicator never re-syncs after this initial exchange on its own.
  await alice.joinNetwork(new LoopbackTransport(aliceId.identityId));
  await bob.joinNetwork(new LoopbackTransport(bobId.identityId));
  await new Promise((r) => setTimeout(r, 50)); // let the real HELLO/HELLO_ACK exchange settle

  await alice.send(bobId.identityId, claimable);
  await new Promise((r) => setTimeout(r, 50)); // let the real EVENTS/ACK round trip settle

  assert.equal(await bob.balance(), claimable, 'a send() made after the peers already connected must still reach bob — it did not before replicator.publish() was wired in');

  // LoopbackTransport keeps a real, process-wide static registry — a
  // peer that never leaveNetwork()s stays "connected" forever and
  // keeps replying to every later test's own HELLO with its own,
  // unrelated event history, corrupting log.head() for any wallet that
  // later joins the same domain. Real, found the hard way: the two
  // tests below intermittently failed once this file had enough
  // LoopbackTransport tests for that cross-talk to actually collide.
  await alice.leaveNetwork();
  await bob.leaveNetwork();
});

test('REGRESSION: a Channel send over a live network session also reaches an already-connected peer', async () => {
  const alice = new AIWA({ rewardParams });
  const aliceId = await alice.connect();
  const bob = new AIWA({ rewardParams });
  const bobId = await bob.connect();

  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  await alice.joinNetwork(new LoopbackTransport(aliceId.identityId));
  await bob.joinNetwork(new LoopbackTransport(bobId.identityId));
  await new Promise((r) => setTimeout(r, 50));

  const channel = await alice.openChannel(bobId.identityId);
  await channel.send(claimable);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(await bob.balance(), claimable, 'a channel click made after the peers already connected must still reach bob');

  await alice.leaveNetwork();
  await bob.leaveNetwork();
});

test('REGRESSION: send() still reaches a peer that connected BEFORE the sender was even funded — publishing bare new events is not enough, the full ancestor chain must go too', async () => {
  const alice = new AIWA({ rewardParams });
  const aliceId = await alice.connect();
  const bob = new AIWA({ rewardParams });
  const bobId = await bob.connect();

  // Peers connect FIRST, while both logs are still empty — the exact
  // ordering the live demo used and the second real bug this exposed:
  // the one-time initial HELLO/HELLO_ACK exchange above synced nothing
  // (both sides had nothing yet), and recordCommitment/advanceProgress/
  // claim below never call publish() themselves — so bob's log never
  // learns about alice's commitment/progression/claim history at all.
  // Publishing only the bare transfer event later is then unappendable
  // on bob's side (its parent chain is entirely unknown to him) and
  // Replicator's own message queue silently swallows that failure.
  await alice.joinNetwork(new LoopbackTransport(aliceId.identityId));
  await bob.joinNetwork(new LoopbackTransport(bobId.identityId));
  await new Promise((r) => setTimeout(r, 50));

  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  await alice.send(bobId.identityId, claimable);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(await bob.balance(), claimable, 'bob must still receive the send even though his log never independently learned alice\'s pre-send history');

  await alice.leaveNetwork();
  await bob.leaveNetwork();
});

test('REGRESSION: a Channel send still reaches a peer that connected BEFORE the owner was even funded', async () => {
  const alice = new AIWA({ rewardParams });
  const aliceId = await alice.connect();
  const bob = new AIWA({ rewardParams });
  const bobId = await bob.connect();

  await alice.joinNetwork(new LoopbackTransport(aliceId.identityId));
  await bob.joinNetwork(new LoopbackTransport(bobId.identityId));
  await new Promise((r) => setTimeout(r, 50));

  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  const channel = await alice.openChannel(bobId.identityId);
  await channel.send(claimable);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(await bob.balance(), claimable, 'bob must still receive the channel send even though his log never independently learned alice\'s pre-open history');

  await alice.leaveNetwork();
  await bob.leaveNetwork();
});

test('receiveOfflineBundle() works on a disconnected wallet — appending never signs anything with this wallet\'s own key', async () => {
  const alice = new AIWA({ rewardParams });
  await alice.connect();
  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  const bob = new AIWA({ rewardParams });
  const bobId = await bob.connect();
  const bobSecretKeyBytes = bob._keypair.secretKey;
  await bob.disconnect(); // root key + identity gone from memory

  const bundle = await alice.sendOfflineBundle(bobId.identityId, claimable);
  await assert.doesNotReject(bob.receiveOfflineBundle(bundle), 'a disconnected wallet must still be able to receive — receiving needs no signature from this wallet at all');

  await bob.connect({ secretKeyBytes: bobSecretKeyBytes }); // reconnect with the SAME identity to confirm the log genuinely absorbed it while disconnected
  assert.equal(await bob.balance(), claimable);
});

test('a channel can claim currently-claimable value for the real owner, through a real delegated-claim, landing it under the owner\'s own identity', async () => {
  const alice = new AIWA({ rewardParams });
  const aliceId = await alice.connect();
  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();

  const channel = await alice.openChannel('bob-id', { requireNetwork: false });
  await alice.disconnect(); // root key + identity gone — the channel must not need either

  await assert.doesNotReject(channel.claim(claimable));
  assert.equal(await channel.balance(), claimable, 'the claimed value lands in the real owner\'s own position, spendable through the channel');

  const state = await alice._materializeWallet();
  assert.equal(spendableClaims(state, aliceId.identityId).length, 1, 'the real owner (not the channel\'s own session identity) owns the resulting claim');
});

test('a channel can issue a real bearer voucher — no root-key involvement — and it redeems exactly like an ordinary one', async () => {
  const alice = new AIWA({ rewardParams });
  await alice.connect();
  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);

  const channel = await alice.openChannel('bob-id', { requireNetwork: false });
  await alice.disconnect();

  const voucher = await channel.issueVoucher(claimable);
  const blob = encodeOfflineBundle(voucher);

  const bob = new AIWA({ rewardParams });
  await bob.connect();
  await bob.redeemVoucher(decodeOfflineBundle(blob));

  assert.equal(await bob.balance(), claimable);
});

test('a channel can redeem a bearer voucher for the real owner, landing the value in the owner\'s identity, never the channel\'s own session identity', async () => {
  const issuer = new AIWA({ rewardParams });
  await issuer.connect();
  await issuer.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await issuer.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await issuer.claimable();
  await issuer.claim(claimable);
  const voucher = await issuer.issueVoucher(claimable);
  const blob = encodeOfflineBundle(voucher);

  const owner = new AIWA({ rewardParams });
  const ownerId = await owner.connect();
  const channel = await owner.openChannel('someone-else-id', { requireNetwork: false });
  await owner.disconnect(); // root key + identity gone — the channel must not need either

  await assert.doesNotReject(channel.redeemVoucher(decodeOfflineBundle(blob)));

  const state = await owner._materializeWallet();
  assert.equal(spendableClaims(state, ownerId.identityId).length, 1, 'the real owner receives it');
  assert.equal(spendableClaims(state, ownerId.identityId)[0].amount, toUnits(claimable));
  assert.equal(spendableClaims(state, channel.identity.id).length, 0, 'the channel\'s own session identity never actually owns the redeemed value');
});
