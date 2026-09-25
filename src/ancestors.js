// A real, minimal ancestor-closure walk over a local EventLog — used
// to bundle EXACTLY the events a stranger needs to append a given
// leaf event (a transfer, a split) with zero prior sync: EventLog.append()
// requires every parent to already be known, recursively, so handing
// someone a leaf event alone (e.g. in a QR code) without its real
// ancestor chain is simply not appendable on their side.

/**
 * Every real event reachable from `eventIds` (inclusive), in an order
 * EventLog.appendMany() can apply directly (parents before children).
 *
 * `excludeIds`, if given, stops the walk the instant it reaches one of
 * them — never recursing into their own parents. Passing a domain's
 * own previous log heads here turns this from "the entire history"
 * into "exactly what's new since then": ancestors(heads at time T) is
 * always the complete known event set at time T (every event with no
 * children is, by definition, a head), so nothing before `excludeIds`
 * is ever missed by stopping there. This is what lets a caller who
 * already materialized state up to a known frontier fold only the real
 * delta on every later call, instead of paying the full replay cost
 * again each time.
 */
export async function collectAncestors(log, eventIds, { excludeIds } = {}) {
  const seen = new Set(excludeIds ?? []);
  const collected = [];
  async function visit(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const event = await log.get(id);
    if (!event) throw new Error(`collectAncestors: event ${id} is not in this log — cannot bundle what we don't have.`);
    for (const parentId of event.parents) await visit(parentId);
    collected.push(event);
  }
  for (const id of eventIds) await visit(id);
  return collected;
}
