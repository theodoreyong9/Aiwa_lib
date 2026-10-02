import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessSubmission } from 'aiwa-core';
import { AIWA } from '../src/wallet.js';

// A wallet's history: the key comes back from the recovery phrase, the log must come back from somewhere. A backup is a
// checkpoint (the wallet's state signed by its own key): small however long the history, and a wallet that has it is
// back where it was — able to carry on, with a chain a reader still accepts.
const params = { alpha: 1.1, beta: 2.2, gamma: 3, C: Math.pow(33, 3), minQ: 1, epochIterations: 120, commitmentBacking: 'none' };

async function minedWallet() {
  const a = new AIWA({ rewardParams: params });
  await a.connect();
  await a.recordCommitment({ b: 5 });
  await a.advanceProgress({ epochs: 3 });
  const claimable = await a.claimable();
  await a.claim(claimable);   // some AIWA to spend: it lives in the log too
  await a.advanceProgress({ epochs: 2 });
  return a;
}
async function sameKey(a) {
  const b = new AIWA({ rewardParams: params });
  await b.connect({ mnemonic: a.recoveryPhrase });
  return b;
}

test('a backup brings a wallet back: same mining, same AIWA, same chain head — and it carries on', async () => {
  const a = await minedWallet();
  const backup = await a.exportBackup();
  assert.equal(backup.kind, 'aiwa-backup');
  assert.equal(backup.domain, a.identity.id);
  assert.equal(backup.epoch, 5);
  assert.equal(backup.events.length, 1, 'one checkpoint, whatever the history');
  assert.ok(JSON.stringify(backup).length < 20_000, 'small');

  const b = await sameKey(a);                       // a new device: the key from the phrase, an empty log
  assert.equal((await b.mining()), null);
  const back = await b.importBackup(JSON.parse(JSON.stringify(backup)));   // through a file
  assert.deepEqual(back, { epoch: 5, restored: true });
  const [ma, mb] = [await a.mining(), await b.mining()];
  assert.equal(mb.epoch, ma.epoch);
  assert.equal(mb.capital, ma.capital);
  assert.equal(mb.chainHead, ma.chainHead);
  assert.equal(await b.spendableBalance(), await a.spendableBalance());

  const more = await b.advanceProgress({ epochs: 2 });
  assert.ok(more.eventId, 'it carries on');
  assert.equal((await b.mining()).epoch, 7);
});

test('a backup is not an alibi: a reader that kept the wallet\'s baseline accepts what the restored wallet does next', async () => {
  const a = await minedWallet();
  const first = await assessSubmission({ rewardParams: params, evidence: await a.submissionEvidence(), domain: a.identity.id });
  assert.equal(first.ok, true, first.reason);

  const b = await sameKey(a);
  await b.importBackup(await a.exportBackup());
  await b.recordCommitment({ b: 2, T: 0.1 });
  await b.advanceProgress({ epochs: 2 });
  const next = await assessSubmission({
    rewardParams: params, domain: b.identity.id, baseline: first.baseline,
    evidence: await b.submissionEvidence({ afterEpoch: first.baseline.epoch, after: first.baseline.head }),
  });
  assert.equal(next.ok, true, next.reason);
  assert.deepEqual(next.rejections, []);
  assert.equal(next.mining.epoch, 7);
  assert.equal(next.mining.capital, 2);
});

test('a backup of another identity, or one that is not ahead, is refused — nothing is rolled back', async () => {
  const a = await minedWallet();
  const backup = await a.exportBackup();
  const stranger = new AIWA({ rewardParams: params });
  await stranger.connect();
  await assert.rejects(stranger.importBackup(backup), /another identity/);
  await assert.rejects(a.importBackup({ kind: 'something else', events: [] }), /not an Aiwa backup/);
  await a.advanceProgress({ epochs: 3 });
  assert.deepEqual(await a.importBackup(backup), { epoch: 8, restored: false }, 'an older backup does not roll the wallet back');
  assert.equal((await a.mining()).epoch, 8);
});

test('adoptState: a registry\'s baseline (the state it derived, not the events) brings the mining back', async () => {
  const a = await minedWallet();
  const submitted = await assessSubmission({ rewardParams: params, evidence: await a.submissionEvidence(), domain: a.identity.id });
  const baseline = submitted.baseline;

  const b = await sameKey(a);
  assert.deepEqual(await b.adoptState(baseline.state), { epoch: 5, adopted: true });
  const mb = await b.mining();
  assert.equal(mb.epoch, 5);
  assert.equal(mb.chainHead, baseline.head, 'it continues exactly where the registry holds it');
  await b.advanceProgress({ epochs: 1 });
  const next = await assessSubmission({
    rewardParams: params, domain: b.identity.id, baseline,
    evidence: await b.submissionEvidence({ afterEpoch: baseline.epoch, after: baseline.head }),
  });
  assert.equal(next.ok, true, next.reason);
  assert.equal(next.mining.epoch, 6);

  assert.deepEqual(await b.adoptState(baseline.state), { epoch: 6, adopted: false }, 'never rolls a wallet back');
  const stranger = new AIWA({ rewardParams: params });
  await stranger.connect();
  await assert.rejects(stranger.adoptState(baseline.state), /nothing of this identity/);
});
