// A grow-only set of content-addressed events linked by causal parents.
// No global clock, no total order on insert — merging two DAGs is a
// pure, commutative set union. No opinion on what a payload contains or
// how (or whether) it's signed; that's the caller's concern.

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

export class EventDag {
  constructor() {
    this._events = new Map();
    this._listeners = [];
  }

  subscribe(callback) {
    this._listeners.push(callback);
    return () => { this._listeners = this._listeners.filter((cb) => cb !== callback); };
  }

  _notify(event) {
    for (const cb of this._listeners) cb(event);
  }

  async computeId(parents, payload) {
    const canonical = canonicalize({ parents: [...parents].sort(), payload });
    const data = new TextEncoder().encode(JSON.stringify(canonical));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async addEvent(parents, payload) {
    for (const p of parents) {
      if (!this._events.has(p)) throw new Error(`Unknown parent: ${p}`);
    }
    const id = await this.computeId(parents, payload);
    if (!this._events.has(id)) {
      const event = { id, parents: [...parents], payload };
      this._events.set(id, event);
      this._notify(event);
    }
    return id;
  }

  // Bulk-load path for events already verified once (at genuine creation
  // time) and now being restored from this same peer's own trusted local
  // storage — trusts the stored id rather than recomputing it. Never use
  // this for events from an external source (a received sync payload, an
  // imported file); addEvent()'s own recomputation is what makes those
  // trustworthy. Silently skips an event whose parent isn't yet present
  // rather than throwing, since restore order isn't guaranteed causal.
  loadTrusted(events) {
    for (const ev of events) {
      if (this._events.has(ev.id)) continue;
      if (!ev.parents.every((p) => this._events.has(p))) continue;
      this._events.set(ev.id, { id: ev.id, parents: [...ev.parents], payload: ev.payload });
    }
  }

  merge(otherDag) {
    for (const ev of otherDag._events.values()) {
      if (!this._events.has(ev.id)) {
        this._events.set(ev.id, ev);
        this._notify(ev);
      }
    }
  }

  topoOrder() {
    const visited = new Set();
    const order = [];
    const visit = (id) => {
      if (visited.has(id)) return;
      visited.add(id);
      const ev = this._events.get(id);
      for (const p of [...ev.parents].sort()) visit(p);
      order.push(ev);
    };
    for (const id of [...this._events.keys()].sort()) visit(id);
    return order;
  }

  materialize(reducer, initialState) {
    return this.topoOrder().reduce((state, ev) => reducer(state, ev), initialState);
  }

  get size() {
    return this._events.size;
  }
}
