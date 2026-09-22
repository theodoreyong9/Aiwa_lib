// Merge-by-replay: the only way a raw event list from an untrusted
// source (a received sync message, an imported file) is allowed into a
// DAG. Ids are always recomputed by addEvent() itself, never trusted
// from the source. Shared by every transport (see transport/) and by
// file import/export, so a new transport is never a second,
// separately-trusted path into the same DAG.
export async function mergeEvents(dag, rawEvents) {
  const before = dag.topoOrder().length;
  const byId = new Map(rawEvents.map((e) => [e.id, e]));
  const visited = new Set();
  const ordered = [];
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const ev = byId.get(id);
    if (!ev) return;
    for (const p of ev.parents) visit(p);
    ordered.push(ev);
  }
  for (const ev of rawEvents) visit(ev.id);
  for (const ev of ordered) {
    try { await dag.addEvent(ev.parents, ev.payload); } catch { /* a parent this DAG never received — skipped, not crashed on */ }
  }
  const after = dag.topoOrder().length;
  return { imported: after - before, alreadyPresent: ordered.length - (after - before) };
}

const EXPORT_FORMAT = 'aiwa-lib-export-v1';

// Whole-DAG export as a downloadable file — the fallback transport for a
// genuinely disconnected peer, carried by hand exactly like a physically
// transported drive would be. Browser-only (uses Blob/URL/document).
export function exportHistory(dag, { filenamePrefix = 'graph', originId = null } = {}) {
  const events = dag.topoOrder();
  const blob = new Blob([JSON.stringify({ format: EXPORT_FORMAT, exportedAt: Date.now(), originId, events }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenamePrefix}-${originId ? String(originId).slice(0, 10) : 'export'}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return events.length;
}

export async function importHistory(dag, file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (parsed.format !== EXPORT_FORMAT || !Array.isArray(parsed.events)) {
    throw new Error('Not a recognized export file.');
  }
  const result = await mergeEvents(dag, parsed.events);
  return { ...result, sourceOriginId: parsed.originId ?? null };
}
