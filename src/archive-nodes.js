// The archive nodes a wallet uses (aiwa-platform's archive node: the always-on holder of backups): the addresses, kept in the
// browser. The same list is read by the wallet's automatic backups and by the recovery panel, in every app on this origin.

import { normalizeNodeUrl } from 'aiwa-platform';

const KEY = 'aiwa-archive-nodes';

/** The saved node addresses (valid ones only), or `defaults` when none were saved. */
export function loadArchiveNodes({ defaults = [], key = KEY } = {}) {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null');
    if (Array.isArray(saved)) return saved.filter((url) => { try { normalizeNodeUrl(url); return true; } catch { return false; } });
  } catch { /* storage blocked or unreadable: the defaults */ }
  return [...defaults];
}

/** Saves the list; each address is checked and normalised first (throws on one that is not a node address). Returns what was saved. */
export function saveArchiveNodes(nodes, { key = KEY } = {}) {
  const clean = [...new Set(nodes.map((url) => normalizeNodeUrl(url)))];
  try { globalThis.localStorage?.setItem(key, JSON.stringify(clean)); } catch { /* the list then lasts until the page closes */ }
  return clean;
}
