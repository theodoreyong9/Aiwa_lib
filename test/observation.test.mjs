import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, buildSignedProgressionEvent, buildSignedAccrualEvent } from 'aiwa-core';
import { LoopbackTransport } from 'aiwa-platform';
import { AIWA } from '../src/wallet.js';
import { collectAncestors } from '../src/ancestors.js';

// Mirror, integrated: a wallet that receives another domain's events signs a reception commitment for them, and
// position() reads the result through aiwa-core's assessPosition.
// commitmentBacking: 'none' — these tests are not about the burn gate (burn-backed.test.mjs is)
const rewardParams = { alpha: 1.1, beta: 2.2, gamma: 3, C: Math.pow(33, 3), minQ: 1, commitmentBacking: 'none' };
const VDF_ITERATIONS = 20;

async function wallet(options = {}) {
  const aiwa = new AIWA({ rewardParams, ...options });
  const { identityId } = await aiwa.connect();
  return { aiwa, id: identityId };
}
const bundleOf = async (aiwa) => ({ events: await collectAncestors(aiwa.log, await aiwa.log.head()) });
const receptions = async (aiwa) => (await collectAncestors(aiwa.log, await aiwa.log.head())).filter((e) => e.type === 'reception');
async function advance(aiwa, times) { for (let i = 0; i < times; i++) await aiwa.advanceProgress({ vdfIterations: VDF_ITERATIONS }); }

test('an offline bundle from another domain is answered with a signed reception commitment, and position() proves where that domain is', async () => {
  const { aiwa: alice, id: aliceId } = await wallet();
  const { aiwa: bob, id: bobId } = await wallet();
  await advance(alice, 3);
  await bob.receiveOfflineBundle(await bundleOf(alice));
  await bob.settled();

  const mine = await receptions(bob);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].author, bobId);
  assert.equal(mine[0].payload.receivedFrom[0].sourceDomain, aliceId);

  const where = await bob.position(aliceId);
  assert.equal(where.proof.lowerBound, 3);
  assert.equal(where.position, 3);
  assert.equal(where.verification, 'chain', 'the log holds alice from epoch 1, so her chain was replayed, not just her signatures');
  assert.equal(where.forked, false);
});

test('observe() is idempotent, and follows the other domain forward with increasing commitments', async () => {
  const { aiwa: alice, id: aliceId } = await wallet();
  const { aiwa: bob } = await wallet();
  await advance(alice, 3);
  await bob.receiveOfflineBundle(await bundleOf(alice));
  await bob.settled();
  assert.deepEqual((await bob.observe()).committed, [], 'nothing new, nothing appended');
  assert.equal((await receptions(bob)).length, 1);

  await advance(alice, 2);
  await bob.receiveOfflineBundle(await bundleOf(alice));
  await bob.settled();
  const all = await receptions(bob);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((e) => e.payload.epoch).sort(), [1, 2], "bob's own sequence numbers, increasing");
  assert.equal((await bob.position(aliceId)).position, 5);
});

test('a foreign progression event that is not a real step is never cited, and position() reports it as rejected', async () => {
  const { aiwa: alice, id: aliceId } = await wallet();
  const { aiwa: bob } = await wallet();
  const { aiwa: carol } = await wallet();
  await advance(alice, 3);
  await bob.receiveOfflineBundle(await bundleOf(alice));
  await bob.settled();

  // carol writes an event that claims to be alice's epoch 999 — signed by carol's key, so it cannot be alice's
  const forgedPayload = await buildSignedProgressionEvent(
    { domain: aliceId, epoch: 999, vdfIterations: VDF_ITERATIONS, vdfOutput: 'f'.repeat(64) },
    carol._keypair.secretKey.slice(0, 32), carol._keypair.publicKey.toBytes(),
  );
  const forged = await createEvent(carol.identity, { domain: bob.logDomain, parents: await bob.log.head(), type: 'progression', payload: forgedPayload });
  await bob.log.append(forged); // the envelope verifies — that is all the log checks

  assert.deepEqual((await bob.observe()).committed, [], 'the forged event is not cited');
  const where = await bob.position(aliceId);
  assert.equal(where.position, 3);
  assert.deepEqual(where.rejectedEvents, [forged.id]);
  assert.equal(where.accuse, false);
});

test('autoObserve: false leaves the log alone until observe() is called', async () => {
  const { aiwa: alice } = await wallet();
  const { aiwa: bob } = await wallet({ autoObserve: false });
  await advance(alice, 2);
  await bob.receiveOfflineBundle(await bundleOf(alice));
  await bob.settled();
  assert.equal((await receptions(bob)).length, 0);
  assert.equal((await bob.observe()).committed.length, 1);
});

test('a witness weighs what it committed (b, signed into its own position) — and nobody else\'s statement counts for it', async () => {
  const { aiwa: alice, id: aliceId } = await wallet();
  const { aiwa: bob, id: bobId } = await wallet();
  const { aiwa: carol } = await wallet();
  await advance(alice, 3);
  await bob.receiveOfflineBundle(await bundleOf(alice));
  await bob.settled();

  assert.equal((await bob.position(aliceId)).estimate, null, 'bob has committed nothing: a witness with no weight, so the vote has nothing — the proofs still stand');
  assert.equal((await bob.position(aliceId)).position, 3);

  // carol signs an accrual commitment naming BOB's domain: only bob's own key can commit capital to bob's position
  const forged = await buildSignedAccrualEvent(
    { domain: bobId, b: 5 }, carol._keypair.secretKey.slice(0, 32), carol._keypair.publicKey.toBytes(),
  );
  await bob.log.append(await createEvent(carol.identity, { domain: bob.logDomain, parents: await bob.log.head(), type: 'accrual', payload: forged }));
  assert.equal((await bob.position(aliceId)).estimate, null, "carol's statement gives bob no weight");

  await bob.recordCommitment({ b: 2 });
  const weighted = await bob.position(aliceId);
  assert.equal(weighted.estimate.tick, 3);
  assert.equal(weighted.estimate.totalWeight, 2_000_000_000, 'b = 2 whole units = 2e9 lamports of weight');
});

test('over a live network session: commitments are made and pushed to the observed domain', async () => {
  const { aiwa: alice, id: aliceId } = await wallet();
  const { aiwa: bob, id: bobId } = await wallet();
  await advance(alice, 3);
  await alice.joinNetwork(new LoopbackTransport(aliceId));
  await bob.joinNetwork(new LoopbackTransport(bobId));
  await new Promise((r) => setTimeout(r, 120)); // the HELLO / EVENTS / ACK exchange settles
  await bob.settled();
  await new Promise((r) => setTimeout(r, 120)); // bob's commitment travels back
  await alice.settled();

  assert.equal((await bob.position(aliceId)).position, 3);
  const heldByAlice = (await receptions(alice)).filter((e) => e.author === bobId);
  assert.equal(heldByAlice.length, 1, 'alice holds bob\'s signed commitment to having received her');
  await alice.leaveNetwork();
  await bob.leaveNetwork();
});

test('position() is read-only: it works with no key unlocked', async () => {
  const { aiwa: alice, id: aliceId } = await wallet();
  const { aiwa: bob } = await wallet();
  await advance(alice, 2);
  await bob.receiveOfflineBundle(await bundleOf(alice));
  await bob.settled();
  await bob.disconnect();
  assert.equal((await bob.position(aliceId)).position, 2);
});
