import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventDag } from '../src/event-dag.js';
import { mergeEvents } from '../src/reconciliation.js';

test('mergeEvents: imports a raw event list regardless of the order it arrives in', async () => {
  const source = new EventDag();
  const root = await source.addEvent([], { n: 'root' });
  const mid = await source.addEvent([root], { n: 'mid' });
  await source.addEvent([mid], { n: 'tip' });
  const raw = source.topoOrder();

  const dest = new EventDag();
  const result = await mergeEvents(dest, [raw[2], raw[0], raw[1]]); // scrambled
  assert.equal(result.imported, 3);
  assert.equal(result.alreadyPresent, 0);
  assert.equal(dest.size, 3);
  assert.deepEqual(dest.topoOrder().map((e) => e.payload.n), ['root', 'mid', 'tip']);
});

test('mergeEvents: never trusts the wire id, recomputes it via addEvent', async () => {
  const dest = new EventDag();
  const spoofed = [{ id: 'not-the-real-hash', parents: [], payload: { n: 1 } }];
  await mergeEvents(dest, spoofed);
  const real = dest.topoOrder()[0];
  assert.notEqual(real.id, 'not-the-real-hash');
});

test('mergeEvents: skips an event whose parent never arrived, without crashing', async () => {
  const dest = new EventDag();
  const raw = [{ id: 'child', parents: ['missing-parent'], payload: { n: 1 } }];
  const result = await mergeEvents(dest, raw);
  assert.equal(result.imported, 0);
  assert.equal(dest.size, 0);
});

test('mergeEvents: re-merging the same events a second time is a no-op (alreadyPresent, not imported)', async () => {
  const source = new EventDag();
  await source.addEvent([], { n: 1 });
  const raw = source.topoOrder();

  const dest = new EventDag();
  const first = await mergeEvents(dest, raw);
  const second = await mergeEvents(dest, raw);
  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.alreadyPresent, 1);
});

test('mergeEvents: two independently-built histories converge to the same state via merge, regardless of direction', async () => {
  const a = new EventDag();
  const rootA = await a.addEvent([], { n: 'shared-root' });
  await a.addEvent([rootA], { n: 'a-only' });

  const b = new EventDag();
  const rootB = await b.addEvent([], { n: 'shared-root' }); // same content -> same id as rootA
  await b.addEvent([rootB], { n: 'b-only' });

  const aThenB = new EventDag();
  await mergeEvents(aThenB, a.topoOrder());
  await mergeEvents(aThenB, b.topoOrder());

  const bThenA = new EventDag();
  await mergeEvents(bThenA, b.topoOrder());
  await mergeEvents(bThenA, a.topoOrder());

  assert.equal(aThenB.size, 3);
  assert.deepEqual(
    new Set(aThenB.topoOrder().map((e) => e.id)),
    new Set(bThenA.topoOrder().map((e) => e.id)),
  );
});
