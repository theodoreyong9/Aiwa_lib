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

// --- The archive: an always-on node holds the backup, and a wallet logging in on a new device gets it back ---------------

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchiveServer } from 'aiwa-platform/archive-server';
import { loadArchiveNodes, saveArchiveNodes } from '../src/archive-nodes.js';

async function archiveNode() {
  const dir = mkdtempSync(join(tmpdir(), 'aiwa-lib-node-'));
  const server = createArchiveServer({ dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a lost device: the phrase brings the key back and the archive node brings the history back', async () => {
  const node = await archiveNode();
  try {
    const a = await minedWallet();
    const pushed = await a.archiveNow([node.url]);
    assert.equal(pushed.ok.length, 1);
    assert.equal(pushed.epoch, 5);

    const phone = await sameKey(a);                                  // a new phone: the phrase, nothing else
    assert.equal(await phone.mining(), null);
    const got = await phone.restoreFromArchive([node.url]);
    assert.deepEqual([got.found, got.restored, got.epoch], [true, true, 5]);
    assert.equal((await phone.mining()).chainHead, (await a.mining()).chainHead);
    assert.equal(await phone.spendableBalance(), await a.spendableBalance());
    await phone.advanceProgress({ epochs: 1 });
    assert.equal((await phone.mining()).epoch, 6, 'and it carries on');
  } finally { node.close(); }
});

test('the archive says plainly when there is nothing to restore from', async () => {
  const node = await archiveNode();
  try {
    const a = new AIWA({ rewardParams: params });
    await a.connect();
    await assert.rejects(a.restoreFromArchive([]), /no archive node/);
    assert.deepEqual(await a.restoreFromArchive([node.url]), { found: false }, 'a node that holds nothing for this identity');
    assert.deepEqual(await a.archiveNow([]), { ok: [], failed: [], skipped: true });
    const down = await a.archiveNow(['http://127.0.0.1:1']);
    assert.equal(down.failed.length, 1, 'a node that is down is reported, not thrown');
  } finally { node.close(); }
});

test('startAutoArchive keeps the node up to date while the wallet changes, and does nothing when it did not', async () => {
  const node = await archiveNode();
  try {
    const a = await minedWallet();
    const pushes = [];
    let list = [];                                                    // no node yet: nothing happens
    a.startAutoArchive({ nodes: () => list, intervalMs: 25, onArchived: (r) => pushes.push(r) });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(pushes.length, 0);
    list = [node.url];                                                // a node added later is used
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pushes.length, 1, 'one backup, then nothing while nothing changes');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(pushes.length, 1);
    await a.advanceProgress({ epochs: 1 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pushes.length, 2, 'the wallet moved: a new backup');
    assert.equal(pushes.at(-1).epoch, 6);
    a.stopAutoArchive();
  } finally { node.close(); }
});

test('the list of archive nodes is kept in the browser, checked, and shared by everything that reads it', () => {
  const store = {};
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  try {
    assert.deepEqual(loadArchiveNodes({ defaults: ['https://default.example'] }), ['https://default.example']);
    assert.deepEqual(saveArchiveNodes(['https://a.example/', 'https://a.example', 'http://192.168.1.5:8787/x']), ['https://a.example', 'http://192.168.1.5:8787']);
    assert.deepEqual(loadArchiveNodes(), ['https://a.example', 'http://192.168.1.5:8787']);
    assert.throws(() => saveArchiveNodes(['http://example.com']), /https/);
    store['aiwa-archive-nodes'] = JSON.stringify(['https://ok.example', 'garbage', 'http://example.com']);
    assert.deepEqual(loadArchiveNodes(), ['https://ok.example'], 'invalid entries are dropped when read');
  } finally { delete globalThis.localStorage; }
});
