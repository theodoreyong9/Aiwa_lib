// aiwa-lib: the public, developer-facing facade over aiwa-core
// (validation, event/identity substrate) and aiwa-platform
// (distributed infra) — a real wallet API and a smart-contract/token
// authoring SDK, composed from what those two packages already prove
// out, never a reimplementation of either.

export { AIWA, encodeOfflineBundle, decodeOfflineBundle, fromUnits, toUnits, SOLANA_INCINERATOR_ADDRESS } from './wallet.js';
export { collectAncestors } from './ancestors.js';
export { defineContract, Contract } from './contract.js';
