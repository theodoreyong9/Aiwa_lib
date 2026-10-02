import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendableClaims, EventLog, generateIdentity } from 'aiwa-core';
import { AIWA, encodeOfflineBundle, decodeOfflineBundle } from '../src/wallet.js';
import { defineContract, Contract, signedAction, verifySignedAction } from '../src/contract.js';

// Two branches that contradict each other (one voucher redeemed by two people, one token balance spent twice) must have the
// SAME winner for every reader that holds the same events, whatever order the events reached it in — and whether it folded
// them in one go or one arrival at a time. Before aiwa-core's canonicalOrder the winner was the one that arrived first.

const rewardParams = { alpha: 1.1, beta: 2.2, gamma: 3, C: Math.pow(33, 3), minQ: 1, commitmentBacking: 'none' };
const VDF_ITERATIONS = 50;

const eventsOf = async (log) => Promise.all((await log.backend.allIds()).map((id) => log.get(id)));

// Alice claims, issues a voucher; Bob and Carol, each offline, redeem the same voucher.
async function twoRedemptions() {
  const alice = new AIWA({ rewardParams });
  await alice.connect();
  await alice.recordCommitment({ b: 100 });
  for (let i = 0; i < 5; i++) await alice.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const claimable = await alice.claimable();
  await alice.claim(claimable);
  const blob = encodeOfflineBundle(await alice.issueVoucher(claimable));
  const bob = new AIWA({ rewardParams });
  const { identityId: bobId } = await bob.connect();
  const carol = new AIWA({ rewardParams });
  const { identityId: carolId } = await carol.connect();
  await bob.redeemVoucher(decodeOfflineBundle(blob));
  await carol.redeemVoucher(decodeOfflineBundle(blob));
  return { bob, carol, bobId, carolId, bobEvents: await eventsOf(bob.log), carolEvents: await eventsOf(carol.log) };
}

const winnerOf = (state, bobId, carolId) => {
  const bobGot = spendableClaims(state, bobId).length === 1;
  const carolGot = spendableClaims(state, carolId).length === 1;
  assert.notEqual(bobGot, carolGot, 'exactly one of the two redemptions survives');
  return bobGot ? 'bob' : 'carol';
};

test('the same voucher redeemed twice: every reader picks the same winner, whatever order the logs were merged in', async () => {
  const { bobId, carolId, bobEvents, carolEvents } = await twoRedemptions();
  const winners = new Set();
  for (const order of [[bobEvents, carolEvents], [carolEvents, bobEvents]]) {
    const log = new EventLog();
    for (const events of order) await log.appendMany(events);
    const reader = new AIWA({ rewardParams, backend: log.backend });
    winners.add(winnerOf(await reader._materializeWallet(), bobId, carolId));
  }
  assert.equal(winners.size, 1, 'both merge orders give the same winner');
});

test('a reader that folds one arrival at a time (incremental) ends where one that folds everything at once does, in either arrival order', async () => {
  const { bobId, carolId, bobEvents, carolEvents } = await twoRedemptions();

  const atOnce = new EventLog();
  await atOnce.appendMany([...bobEvents, ...carolEvents]);
  const expected = winnerOf(await new AIWA({ rewardParams, backend: atOnce.backend })._materializeWallet(), bobId, carolId);

  for (const [first, second] of [[bobEvents, carolEvents], [carolEvents, bobEvents]]) {
    const log = new EventLog();
    const reader = new AIWA({ rewardParams, backend: log.backend });
    await log.appendMany(first);
    await reader._materializeWallet();          // folded with the first branch only: its redemption won, for now
    await log.appendMany(second);                // the other branch arrives, concurrent with what is folded
    assert.equal(winnerOf(await reader._materializeWallet(), bobId, carolId), expected, 'the late branch is not simply refused: the order decides, not the arrival');
  }
});

test('many random arrival orders, one event at a time with a fold after each: the same final winner every time', async () => {
  const { bobId, carolId, bobEvents, carolEvents } = await twoRedemptions();
  const all = new Map();
  for (const e of [...bobEvents, ...carolEvents]) all.set(e.id, e);
  const winners = new Set();
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let run = 0; run < 8; run++) {
    const log = new EventLog();
    const reader = new AIWA({ rewardParams, backend: log.backend });
    const waiting = [...all.values()];
    while (waiting.length > 0) {
      // a random event whose parents have all arrived (a log only takes an event once its parents are there)
      const ready = [];
      for (const e of waiting) if ((await Promise.all(e.parents.map((p) => log.has(p)))).every(Boolean)) ready.push(e);
      const next = ready[Math.floor(random() * ready.length)];
      await log.append(next);
      waiting.splice(waiting.indexOf(next), 1);
      await reader._materializeWallet();
    }
    winners.add(winnerOf(await reader._materializeWallet(), bobId, carolId));
  }
  assert.equal(winners.size, 1, 'eight different arrival orders, one winner');
});

function token({ owner }) {
  return defineContract({
    initialState: () => ({ balances: {} }),
    handlers: {
      async mint(state, event) {
        if (!(await verifySignedAction(event.payload)) || event.payload.from !== owner) return state;
        const { to, amount } = event.payload;
        return { balances: { ...state.balances, [to]: (state.balances[to] ?? 0n) + BigInt(amount) } };
      },
      async transfer(state, event) {
        if (!(await verifySignedAction(event.payload))) return state;
        const { from, to, amount } = event.payload;
        const have = state.balances[from] ?? 0n;
        if (have < BigInt(amount)) return state;
        return { balances: { ...state.balances, [from]: have - BigInt(amount), [to]: (state.balances[to] ?? 0n) + BigInt(amount) } };
      },
    },
  });
}

test('a token balance spent twice (to two people, on two branches): every reader sees the same balances', async () => {
  const owner = await generateIdentity();
  const spender = await generateIdentity();
  const y = await generateIdentity();
  const z = await generateIdentity();
  const definition = token({ owner: owner.id });
  const base = new EventLog();
  const ownerContract = new Contract({ identity: owner, log: base, domain: 't', definition });
  await ownerContract.dispatch('mint', await signedAction(owner, { from: owner.id, to: spender.id, amount: '10' }));
  const baseEvents = await eventsOf(base);

  const toY = new EventLog(); await toY.appendMany(baseEvents);
  const toZ = new EventLog(); await toZ.appendMany(baseEvents);
  await new Contract({ identity: spender, log: toY, domain: 't', definition }).dispatch('transfer', await signedAction(spender, { from: spender.id, to: y.id, amount: '10' }));
  await new Contract({ identity: spender, log: toZ, domain: 't', definition }).dispatch('transfer', await signedAction(spender, { from: spender.id, to: z.id, amount: '10' }));
  const yEvents = await eventsOf(toY);
  const zEvents = await eventsOf(toZ);

  const seen = new Set();
  for (const order of [[yEvents, zEvents], [zEvents, yEvents]]) {
    const log = new EventLog();
    for (const events of order) await log.appendMany(events);
    const state = await new Contract({ identity: owner, log, domain: 't', definition }).state();
    assert.equal((state.balances[y.id] ?? 0n) + (state.balances[z.id] ?? 0n), 10n, 'the 10 went to exactly one of them');
    seen.add(state.balances[y.id] === 10n ? 'y' : 'z');
  }
  assert.equal(seen.size, 1, 'the same one in both merge orders');
});
