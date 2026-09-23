// A real, minimal ancestor-closure walk over a local EventLog — used
// to bundle EXACTLY the events a stranger needs to append a given
// leaf event (a transfer, a split) with zero prior sync: EventLog.append()
// requires every parent to already be known, recursively, so handing
// someone a leaf event alone (e.g. in a QR code) without its real
// ancestor chain is simply not appendable on their side.

/** Every real event reachable from `eventIds` (inclusive), in an order EventLog.appendMany() can apply directly (parents before children). */
export async function collectAncestors(log, eventIds) {
  const seen = new Set();
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
