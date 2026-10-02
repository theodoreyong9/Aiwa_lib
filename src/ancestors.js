// A real, minimal ancestor-closure walk over a local EventLog — used
// to bundle EXACTLY the events a stranger needs to append a given
// leaf event (a transfer, a split) with zero prior sync: EventLog.append()
// requires every parent to already be known, recursively, so handing
// someone a leaf event alone (e.g. in a QR code) without its real
// ancestor chain is simply not appendable on their side.
//
// The order it returns is aiwa-core's canonicalOrder: parents before children and, between events that do not know of each
// other, the smaller id first — the same for every reader holding the same events, so that a conflict (one claim spent twice)
// has the same winner everywhere instead of the one that happened to arrive first.

import { canonicalOrder } from 'aiwa-core';

/**
 * Every real event reachable from `eventIds` (inclusive), in canonical order (parents before children, so
 * EventLog.appendMany() can apply it directly).
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
export async function collectAncestors(log, eventIds, { excludeIds, tolerant = false } = {}) {
  const seen = new Set(excludeIds ?? []);
  const collected = [];
  async function visit(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const event = await log.get(id);
    // `tolerant`: a log that was pruned to a checkpoint (or restored from one) no longer holds what the checkpoint
    // covers. Reading what IS there (to look at other domains, say) must not fail on that; bundling for a stranger must.
    if (!event && tolerant) return;
    if (!event) throw new Error(`collectAncestors: event ${id} is not in this log — cannot bundle what we don't have.`);
    for (const parentId of event.parents) await visit(parentId);
    collected.push(event);
  }
  for (const id of eventIds) await visit(id);
  return canonicalOrder(collected, { placed: excludeIds });
}
