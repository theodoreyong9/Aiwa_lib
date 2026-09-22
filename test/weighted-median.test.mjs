import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weightedMedian } from '../src/weighted-median.js';

test('a single estimate returns itself', () => {
  assert.equal(weightedMedian([{ value: 42, weight: 1 }]), 42);
});

test('equal weights behaves like an ordinary median', () => {
  const estimates = [{ value: 1, weight: 1 }, { value: 2, weight: 1 }, { value: 3, weight: 1 }];
  assert.equal(weightedMedian(estimates), 2);
});

test('a heavier estimate pulls the result toward it', () => {
  const estimates = [{ value: 0, weight: 1 }, { value: 100, weight: 10 }];
  assert.equal(weightedMedian(estimates), 100);
});

test('a minority of adversarial weight cannot pull the result past the honest majority', () => {
  // Honest majority (weight 6) clustered near 10; a heavy but minority
  // adversarial estimate (weight 5, just under half of 11) tries to pull
  // toward 1000 and fails — the median stays inside the honest cluster.
  const estimates = [
    { value: 9, weight: 2 }, { value: 10, weight: 2 }, { value: 11, weight: 2 },
    { value: 1000, weight: 5 },
  ];
  const result = weightedMedian(estimates);
  assert.ok(result <= 11, `expected the honest cluster to hold, got ${result}`);
});

test('throws on empty input rather than returning a misleading number', () => {
  assert.throws(() => weightedMedian([]), /at least one estimate/);
});

test('throws when total weight is zero', () => {
  assert.throws(() => weightedMedian([{ value: 1, weight: 0 }]), /positive/);
});
