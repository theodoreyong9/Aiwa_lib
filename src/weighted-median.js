// A minority of adversarial weight can't pull a weighted median
// arbitrarily, as long as its total weight stays under half — pure, no
// opinion on what "weight" represents (stake, burned capital, a trust
// score, ...).

export function weightedMedian(estimates) {
  if (estimates.length === 0) throw new Error('weightedMedian requires at least one estimate');
  const totalWeight = estimates.reduce((sum, e) => sum + e.weight, 0);
  if (!(totalWeight > 0)) throw new Error('total weight must be positive');

  const sorted = [...estimates].sort((a, b) => a.value - b.value);
  let cumulative = 0;
  for (const e of sorted) {
    cumulative += e.weight;
    if (cumulative >= totalWeight / 2) return e.value;
  }
  return sorted[sorted.length - 1].value; // unreachable in practice, a safe fallback
}
