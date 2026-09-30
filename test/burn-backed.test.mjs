import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, SOLANA_INCINERATOR_ADDRESS } from 'aiwa-core';
import { AIWA } from '../src/wallet.js';
import { collectAncestors } from '../src/ancestors.js';

// The genesis commitment, enforced end to end: no capital without a burn the wallet confirmed against Solana.
// Solana is faked here by an object with getTransaction — the wallet only ever asks it that one question.
const rewardParams = { alpha: 1.1, beta: 2.2, gamma: 3, C: Math.pow(33, 3), minQ: 1 }; // commitmentBacking left out: mandatory
const VDF_ITERATIONS = 20;

async function wallet(options = {}) {
  const aiwa = new AIWA({ rewardParams, ...options });
  const { identityId } = await aiwa.connect();
  return { aiwa, id: identityId };
}
// a Solana that knows these burns: { signature: { payer: wallet, lamports, err?, spent? } }
function solana(known) {
  const asked = [];
  return {
    asked,
    getTransaction: async (signature, options) => {
      asked.push([signature, options]);
      const burn = known[signature];
      if (!burn) return null;
      const spent = burn.spent ?? burn.lamports + 5000;
      return {
        slot: 123,
        transaction: { message: { accountKeys: [burn.payer.address, SOLANA_INCINERATOR_ADDRESS, '11111111111111111111111111111111'] } },
        meta: { err: burn.err ?? null, fee: 5000, preBalances: [50e9, 0, 1], postBalances: [50e9 - spent, burn.lamports, 1] },
      };
    },
  };
}
const bundleOf = async (aiwa) => ({ events: await collectAncestors(aiwa.log, await aiwa.log.head()) });
async function advance(aiwa, times) { for (let i = 0; i < times; i++) await aiwa.advanceProgress({ vdfIterations: VDF_ITERATIONS }); }
const position = async (reader, domain) => (await reader._materializeWallet()).accrual.positions[domain];

test('MANDATORY: committing capital with no burn is refused, with the reason — and so nothing accrues', async () => {
  const { aiwa } = await wallet();
  await assert.rejects(aiwa.recordCommitment({ b: 1_000_000_000 }), /not covered by the burns confirmed/);
  await advance(aiwa, 3);
  assert.equal(await aiwa.claimable(), '0');
});

test('a burn the wallet confirmed covers a commitment up to what it burned, and accrual follows', async () => {
  const { aiwa: alice } = await wallet();
  const connection = solana({ sig1: { payer: alice, lamports: 2e9 } });
  const { lamports } = await alice.recordBurn('sig1', connection);
  assert.equal(lamports, 2e9);
  assert.deepEqual(connection.asked[0], ['sig1', { commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);

  await alice.recordCommitment({ b: 1.5 });
  await assert.rejects(alice.recordCommitment({ b: 1 }), /not covered/, '2.5 is more than the 2 burned');
  await advance(alice, 5);
  assert.ok(Number(await alice.claimable()) > 0);
});

test('a burn Solana does not report (yet) cannot be recorded, and one that is not this wallet\'s is refused', async () => {
  const { aiwa: alice } = await wallet();
  const { aiwa: bob } = await wallet();
  await assert.rejects(alice.recordBurn('nothing', solana({})), /does not report .* finalized/);
  await assert.rejects(alice.recordBurn('bobs', solana({ bobs: { payer: bob, lamports: 1e9 } })), /not a burn by this wallet/);
  await assert.rejects(alice.recordBurn('failed', solana({ failed: { payer: alice, lamports: 1e9, err: { InstructionError: [0, 'x'] } } })), /not a burn by this wallet/);
});

test('another wallet credits alice\'s commitment only once it has confirmed her burn itself', async () => {
  const { aiwa: alice, id: aliceId } = await wallet();
  const { aiwa: bob } = await wallet();
  const connection = solana({ sig1: { payer: alice, lamports: 3e9 } });
  await alice.recordBurn('sig1', connection);
  await alice.recordCommitment({ b: 3 });
  await advance(alice, 2);

  await bob.receiveOfflineBundle(await bundleOf(alice));
  assert.equal(await position(bob, aliceId), undefined, 'bob has confirmed nothing: her commitment counts for nothing in his view');

  const pendingOnly = await bob.confirmBurns(solana({}));
  assert.deepEqual(pendingOnly, { confirmed: [], pending: ['sig1'] }, 'a Solana that does not know the burn confirms nothing');
  assert.equal(await position(bob, aliceId), undefined);

  assert.deepEqual(await bob.confirmBurns(connection), { confirmed: ['sig1'], pending: [] });
  assert.equal((await position(bob, aliceId)).b, 3);
  assert.deepEqual(await bob.confirmBurns(connection), { confirmed: [], pending: [] }, 'confirmed once, not asked again');
});

test('quoting someone else\'s burn signature earns nothing — whether or not its owner has published it', async () => {
  const { aiwa: alice } = await wallet();
  const { aiwa: mallory, id: malloryId } = await wallet();
  const { aiwa: bob } = await wallet();
  // alice burned on Solana (the fake knows it) but never published a burn-record of her own
  const connection = solana({ alices: { payer: alice, lamports: 9e9 } });

  // mallory publishes a burn-record naming alice's signature for her own domain
  const quote = await createEvent(mallory.identity, { domain: mallory.logDomain, parents: await mallory.log.head(), type: 'burn-record', payload: { domain: malloryId, signature: 'alices' } });
  await mallory.log.append(quote);
  await assert.rejects(mallory.recordCommitment({ b: 1 }), /not covered/, "mallory's own wallet refuses");

  await bob.receiveOfflineBundle(await bundleOf(mallory));
  await bob.confirmBurns(connection);
  let state = await bob._materializeWallet();
  assert.equal(state.accrual.burns.covered[malloryId], undefined);
  assert.ok(state.accrual.rejections.some((r) => /not paid by this domain's own key/.test(r.reason)), 'the binding check is what refuses it');

  // and once alice does publish hers, hers counts and mallory's still does not
  await alice.recordBurn('alices', connection);
  await bob.receiveOfflineBundle(await bundleOf(alice));
  state = await bob._materializeWallet();
  assert.equal(state.accrual.burns.covered[malloryId], undefined);
  assert.equal(state.accrual.burns.covered[alice.identity.id], 9e9);
});

test('with a connection given to the wallet, burns are confirmed by themselves when events arrive', async () => {
  const { aiwa: alice, id: aliceId } = await wallet();
  const connection = solana({ sig1: { payer: alice, lamports: 1e9 } });
  const { aiwa: bob } = await wallet({ connection });
  await alice.recordBurn('sig1', connection);
  await alice.recordCommitment({ b: 1 });
  await bob.receiveOfflineBundle(await bundleOf(alice));
  await bob.settled();
  assert.equal((await position(bob, aliceId)).b, 1);
});

test('a deployment that opts out explicitly keeps the unbacked behaviour, and says so', async () => {
  const { aiwa } = await wallet({ rewardParams: { ...rewardParams, commitmentBacking: 'none' } });
  await aiwa.recordCommitment({ b: 10 });
  await advance(aiwa, 3);
  assert.ok(Number(await aiwa.claimable()) > 0);
});

test('position() weighs a witness by the burns this wallet confirmed for it', async () => {
  const { aiwa: alice, id: aliceId } = await wallet();
  const { aiwa: bob } = await wallet();
  const connection = solana({ bobs: { payer: bob, lamports: 2e9 } });
  await advance(alice, 3);
  await bob.receiveOfflineBundle(await bundleOf(alice));
  await bob.settled();
  assert.equal((await bob.position(aliceId)).estimate, null, 'bob burned nothing: a witness with no weight');
  await bob.recordBurn('bobs', connection);
  const weighted = await bob.position(aliceId);
  assert.equal(weighted.estimate.tick, 3);
  assert.equal(weighted.estimate.totalWeight, 2e9);
});
