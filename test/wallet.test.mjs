import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendableClaims } from 'aiwa-core';
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
