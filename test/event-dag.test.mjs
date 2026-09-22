import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventDag } from '../src/event-dag.js';

test('addEvent: identical parents+payload always yields the same id (content addressing)', async () => {
  const a = new EventDag();
  const b = new EventDag();
  const idA = await a.addEvent([], { type: 'x', n: 1 });
  const idB = await b.addEvent([], { type: 'x', n: 1 });
  assert.equal(idA, idB);
});

test('addEvent: key order in the payload does not change the id', async () => {
  const a = new EventDag();
  const b = new EventDag();
  const idA = await a.addEvent([], { type: 'x', n: 1 });
  const idB = await b.addEvent([], { n: 1, type: 'x' });
  assert.equal(idA, idB);
});

test('addEvent: a different payload yields a different id', async () => {
  const dag = new EventDag();
  const id1 = await dag.addEvent([], { n: 1 });
  const id2 = await dag.addEvent([], { n: 2 });
  assert.notEqual(id1, id2);
});

test('addEvent: re-adding the exact same event is idempotent (same id, size unchanged)', async () => {
  const dag = new EventDag();
  const id1 = await dag.addEvent([], { n: 1 });
  assert.equal(dag.size, 1);
  const id2 = await dag.addEvent([], { n: 1 });
  assert.equal(id1, id2);
  assert.equal(dag.size, 1);
});

test('addEvent: throws on an unknown parent', async () => {
  const dag = new EventDag();
  await assert.rejects(() => dag.addEvent(['nonexistent'], { n: 1 }), /Unknown parent/);
});

test('addEvent: notifies subscribers exactly once per genuinely new event', async () => {
  const dag = new EventDag();
  const seen = [];
  dag.subscribe((ev) => seen.push(ev.payload));
  const id1 = await dag.addEvent([], { n: 1 });
  await dag.addEvent([], { n: 1 }); // duplicate — should not notify again
  await dag.addEvent([id1], { n: 2 });
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
});

test('subscribe: the returned unsubscribe function stops further notifications', async () => {
  const dag = new EventDag();
  const seen = [];
  const unsubscribe = dag.subscribe((ev) => seen.push(ev.payload));
  await dag.addEvent([], { n: 1 });
  unsubscribe();
  await dag.addEvent([], { n: 2 });
  assert.deepEqual(seen, [{ n: 1 }]);
});

test('loadTrusted: restores events without recomputing their id', async () => {
  const dag = new EventDag();
  const id1 = await dag.addEvent([], { n: 1 });
  const id2 = await dag.addEvent([id1], { n: 2 });

  const restored = new EventDag();
  restored.loadTrusted([
    { id: id1, parents: [], payload: { n: 1 } },
    { id: id2, parents: [id1], payload: { n: 2 } },
  ]);
  assert.equal(restored.size, 2);
  assert.deepEqual(restored.topoOrder().map((e) => e.payload), [{ n: 1 }, { n: 2 }]);
});

test('loadTrusted: silently skips an event whose parent is not yet present', async () => {
  const dag = new EventDag();
  dag.loadTrusted([{ id: 'orphan', parents: ['missing-parent'], payload: { n: 1 } }]);
  assert.equal(dag.size, 0);
});

test('merge: is a pure, commutative set union', async () => {
  const a = new EventDag();
  const idA1 = await a.addEvent([], { n: 1 });
  await a.addEvent([idA1], { n: 2 });

  const b = new EventDag();
  const idB1 = await b.addEvent([], { n: 1 }); // same content as a's first event -> same id
  await b.addEvent([idB1], { n: 3 });

  const merged1 = new EventDag();
  merged1.merge(a);
  merged1.merge(b);

  const merged2 = new EventDag();
  merged2.merge(b);
  merged2.merge(a);

  assert.equal(merged1.size, 3); // {n:1} shared, {n:2}, {n:3} — not 4
  assert.equal(merged1.size, merged2.size);
  assert.deepEqual(
    new Set(merged1.topoOrder().map((e) => e.id)),
    new Set(merged2.topoOrder().map((e) => e.id)),
  );
});

test('merge: notifies subscribers only for events genuinely new to the receiving dag', async () => {
  const a = new EventDag();
  await a.addEvent([], { n: 1 });

  const b = new EventDag();
  const seen = [];
  b.subscribe((ev) => seen.push(ev.payload));
  await b.addEvent([], { n: 1 }); // already present in b before merge
  b.merge(a);
  assert.deepEqual(seen, [{ n: 1 }]); // not notified twice for the shared event
});

test('topoOrder: every parent appears before its children', async () => {
  const dag = new EventDag();
  const root = await dag.addEvent([], { n: 'root' });
  const left = await dag.addEvent([root], { n: 'left' });
  const right = await dag.addEvent([root], { n: 'right' });
  await dag.addEvent([left, right], { n: 'merge-point' });

  const order = dag.topoOrder();
  const indexOf = (n) => order.findIndex((e) => e.payload.n === n);
  assert.ok(indexOf('root') < indexOf('left'));
  assert.ok(indexOf('root') < indexOf('right'));
  assert.ok(indexOf('left') < indexOf('merge-point'));
  assert.ok(indexOf('right') < indexOf('merge-point'));
});

test('topoOrder: deterministic regardless of insertion order', async () => {
  // loadTrusted is single-pass (by design — see its own doc comment): it
  // tolerates siblings arriving in either order, but never a child before
  // its own parent. Swap only the two independent siblings here.
  const a = new EventDag();
  const root = await a.addEvent([], { n: 'root' });
  await a.addEvent([root], { n: 'left' });
  await a.addEvent([root], { n: 'right' });

  const b = new EventDag();
  const events = a.topoOrder();
  b.loadTrusted([events[0], events[2], events[1]]); // root first, siblings swapped
  assert.deepEqual(a.topoOrder().map((e) => e.id), b.topoOrder().map((e) => e.id));
});

test('materialize: folds a reducer over topoOrder', async () => {
  const dag = new EventDag();
  const id1 = await dag.addEvent([], { amount: 3 });
  await dag.addEvent([id1], { amount: 5 });
  const total = dag.materialize((sum, ev) => sum + ev.payload.amount, 0);
  assert.equal(total, 8);
});
