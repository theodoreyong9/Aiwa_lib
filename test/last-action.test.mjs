import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOLANA_INCINERATOR_ADDRESS, assessMining } from 'aiwa-core';
import { AIWA } from '../src/wallet.js';
import { collectAncestors } from '../src/ancestors.js';

// "Last action" mining through the wallet: T is chosen at the burn and costs a share of it, a burn replaces the
// position and pays the previous one, and a deployment with a fixed epoch gets progression anyone can verify.
const base = { alpha: 1.1, beta: 2.2, gamma: 3, C: Math.pow(33, 3), minQ: 1 };
const EI = 150;
const succinct = { ...base, epochIterations: EI };
const VDF_ITERATIONS = 20;

function solana(known) {
  return {
    getTransaction: async (signature) => {
      const burn = known[signature];
      if (!burn) return null;
      const spent = burn.lamports + 5000;
      return {
        slot: 7,
        transaction: { message: { accountKeys: [burn.payer.address, SOLANA_INCINERATOR_ADDRESS, '11111111111111111111111111111111'] } },
        meta: { err: null, fee: 5000, preBalances: [50e9, 0, 1], postBalances: [50e9 - spent, burn.lamports, 1] },
      };
    },
  };
}
async function wallet(rewardParams) {
  const aiwa = new AIWA({ rewardParams });
  await aiwa.connect();
  return aiwa;
}

test('T is checked before anything is broadcast: a burn is irreversible, a refusal after it is too late', async () => {
  const aiwa = await wallet(base);
  let asked = 0;
  const connection = { getTransaction: async () => { asked++; return null; } };
  await assert.rejects(aiwa.burn(1e9, connection, { T: 0.9 }), /between 0 and 0.4/);
  await assert.rejects(aiwa.burn(1e9, connection, { T: -0.1 }), /between 0 and 0.4/);
  assert.equal(asked, 0);
});

test('T costs a share of the burn: b = burned x (1 - T), and the same burn cannot back more', async () => {
  const aiwa = await wallet(base);
  const connection = solana({ s1: { payer: aiwa, lamports: 1e9 } });
  await aiwa.recordBurn('s1', connection);
  await assert.rejects(aiwa.recordCommitment({ b: 0.61, T: 0.4 }), /not covered by the burns confirmed/);
  await aiwa.recordCommitment({ b: 0.6, T: 0.4 });
  const mining = await aiwa.mining();
  assert.equal(mining.capital, 0.6);
  assert.equal(mining.T, 0.4);
  await assert.rejects(aiwa.recordCommitment({ b: 0.1 }), /0 are left/, 'the burn is spent');
});

test('a burn pays what the previous one accrued: the claimable is not lost', async () => {
  const aiwa = await wallet({ ...base, commitmentBacking: 'none' });
  await aiwa.recordCommitment({ b: 10 });
  for (let i = 0; i < 6; i++) await aiwa.advanceProgress({ vdfIterations: VDF_ITERATIONS });
  const accrued = await aiwa.claimable();
  assert.ok(Number(accrued) > 0);
  await aiwa.recordCommitment({ b: 10, T: 0.2 });
  assert.equal(await aiwa.claimable(), '0', 'the clock restarted');
  assert.equal(await aiwa.spendableBalance(), accrued, 'and what had accrued is spendable, as a real claim');
  assert.equal((await aiwa.mining()).T, 0.2);
  assert.equal((await aiwa.ranking()).laps, 1);
});

test('with a fixed epoch, advanceProgress does the work, k epochs at once, with a proof', async () => {
  const aiwa = await wallet({ ...succinct, commitmentBacking: 'none' });
  await aiwa.recordCommitment({ b: 5 });
  const one = await aiwa.advanceProgress();
  assert.equal(one.epoch, 1);
  const three = await aiwa.advanceProgress({ epochs: 3 });
  assert.equal(three.epoch, 4);
  const event = await aiwa.log.get(three.eventId);
  assert.equal(event.payload.vdfIterations, 3 * EI);
  assert.ok(event.payload.vdfProof.pi && event.payload.vdfProof.l);
  assert.ok(Number(await aiwa.claimable()) > 0);
  assert.equal((await aiwa.mining()).epoch, 4);
});

test('a validator turns the exported events into the same mining state — it does not need the wallet', async () => {
  const aiwa = await wallet(succinct);
  const connection = solana({ s1: { payer: aiwa, lamports: 2e9 } });
  await aiwa.recordBurn('s1', connection);
  await aiwa.recordCommitment({ b: 1.5, T: 0.25 });
  await aiwa.advanceProgress({ epochs: 2 });
  await aiwa.advanceProgress();
  const events = await aiwa.exportMiningEvents();
  assert.deepEqual([...new Set(events.map((e) => e.type))].sort(), ['accrual', 'burn-record', 'progression']);

  const record = await (await import('aiwa-core')).fetchBurnRecord(connection, 's1'); // the validator asks Solana itself
  const result = await assessMining({ rewardParams: succinct, events, burnRecords: { s1: record }, domain: aiwa.identity.id });
  assert.deepEqual(result.rejections, []);
  const own = await aiwa.mining();
  assert.equal(result.mining.epoch, own.epoch);
  assert.equal(result.mining.T, own.T);
  assert.equal(result.mining.capital, own.capital);
  assert.equal(result.mining.claimable, own.claimable);
  // the same events, minus the epochs a validator already holds
  const later = await aiwa.exportMiningEvents({ afterEpoch: 2 });
  assert.ok(later.length < events.length);
});

test('pruning to a checkpoint does not take the history a validator needs: it is set aside first', async () => {
  const aiwa = await wallet({ ...succinct, commitmentBacking: 'none' });
  await aiwa.recordCommitment({ b: 5 });
  for (let i = 0; i < 4; i++) await aiwa.advanceProgress();
  await aiwa.checkpoint();
  const removed = await aiwa.pruneToLastCheckpoint();
  assert.ok(removed > 0);
  const progression = (await collectAncestors(aiwa.log, await aiwa.log.head()).catch(() => [])).filter((e) => e.type === 'progression');
  assert.ok(progression.length < 4, 'the log itself no longer holds them');
  const exported = await aiwa.exportMiningEvents();
  assert.equal(exported.filter((e) => e.type === 'progression').length, 4, 'but the export does');
  const result = await assessMining({ rewardParams: { ...succinct, commitmentBacking: 'none' }, events: exported, domain: aiwa.identity.id });
  assert.equal(result.mining.epoch, 4);
});

test('keepMiningHistory: false opts out — the history then stops at the last checkpoint', async () => {
  const aiwa = new AIWA({ rewardParams: { ...succinct, commitmentBacking: 'none' }, keepMiningHistory: false });
  await aiwa.connect();
  await aiwa.recordCommitment({ b: 5 });
  for (let i = 0; i < 3; i++) await aiwa.advanceProgress();
  await aiwa.checkpoint();
  await aiwa.pruneToLastCheckpoint();
  const exported = await aiwa.exportMiningEvents();
  assert.ok(exported.filter((e) => e.type === 'progression').length < 3);
});

test('the progress loop never runs two ticks at once, however slow the device', async () => {
  const aiwa = await wallet({ ...base, commitmentBacking: 'none' });
  let running = 0;
  let overlapped = false;
  aiwa.advanceProgress = async () => {
    running++;
    if (running > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 60));
    running--;
  };
  aiwa.startProgressLoop({ intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 200));
  aiwa.stopProgressLoop();
  assert.equal(overlapped, false);
});
