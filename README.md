# aiwa-lib

The public, developer-facing facade over the AIWA stack — not yet built.

## Status: deferred

This repo previously held a hand-rolled content-addressed event DAG and a
P2P transport layer. Both were a misclassification: transport, peers, and
replication are [`aiwa-platform`](https://github.com/theodoreyong9/Aiwa_platform)'s
job, and the event/identity substrate is better served by
[`Record`](https://github.com/theodoreyong9/record) — an existing, tested,
shared foundation already used across this portfolio — than by a fresh
reimplementation. See that repo's own README for why: self-verifying
events (the signer's public key travels inside the event, checked against
the claimed author id), a proper HELLO/EVENTS/ACK replication protocol,
and a signed-capability permissions primitive.

## What this becomes

Once [`aiwa-core`](https://github.com/theodoreyong9/Aiwa_core) (validation:
progression, VDF, reward, accrual, conservation, trust) and
[`aiwa-platform`](https://github.com/theodoreyong9/Aiwa_platform)
(distributed infra: transport, replication, permissions, storage) both
exist, `aiwa-lib` composes them into one ergonomic public API:

```js
import { AIWA } from 'aiwa-lib';

const aiwa = new AIWA(/* ... */);

await aiwa.db.get('jobs').get(jobId).put(job);
aiwa.db.get('jobs').map().on(renderJob);

const proof = await aiwa.progress.advance(state);
aiwa.progress.verify(proof);
```

A thin composition layer, built last — not before Core and Platform give
it something real to compose.
