import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog, generateIdentity } from 'aiwa-core';
import { defineContract, Contract, signedAction, verifySignedAction } from '../src/contract.js';

// A real, minimal custom token — the same worked example the
// smart-contract guide uses. Mint (owner-only) and transfer (real
// balance check) both authorize via a REAL, embedded signature
// (signedAction/verifySignedAction) — never a plain, unverified
// `payload.from` field, which anyone could forge in their own,
// otherwise validly self-signed event. See contract.js's own header
// for exactly why a reducer can't trust anything less than this.
function myToken({ owner, cap }) {
  return defineContract({
    initialState: () => ({ balances: {}, minted: 0n }),
    handlers: {
      async mint(state, event) {
        if (!(await verifySignedAction(event.payload))) return state; // a real, forged or malformed action — silent no-op
        const { from, to, amount } = event.payload;
        if (from !== owner) return state; // not the real owner
        const amt = BigInt(amount);
        if (state.minted + amt > cap) return state; // real supply cap enforced
        return { ...state, minted: state.minted + amt, balances: { ...state.balances, [to]: (state.balances[to] ?? 0n) + amt } };
      },
      async transfer(state, event) {
        if (!(await verifySignedAction(event.payload))) return state;
        const { from, to, amount } = event.payload;
        const amt = BigInt(amount);
        const fromBalance = state.balances[from] ?? 0n;
        if (fromBalance < amt) return state; // real, insufficient-balance rejection
        return { ...state, balances: { ...state.balances, [from]: fromBalance - amt, [to]: (state.balances[to] ?? 0n) + amt } };
      },
    },
  });
}

async function mint(contract, identity, to, amount) {
  const payload = await signedAction(identity, { from: identity.id, to, amount });
  return contract.dispatch('mint', payload);
}
async function transfer(contract, identity, to, amount) {
  const payload = await signedAction(identity, { from: identity.id, to, amount });
  return contract.dispatch('transfer', payload);
}

test('a real custom token: mint respects the real owner and the real supply cap, transfer respects real balances', async () => {
  const owner = await generateIdentity();
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const log = new EventLog();
  const definition = myToken({ owner: owner.id, cap: 1000n });

  const ownerContract = new Contract({ identity: owner, log, domain: 'my-token', definition });
  await mint(ownerContract, owner, alice.id, '600');

  let state = await ownerContract.state();
  assert.equal(state.balances[alice.id], 600n);
  assert.equal(state.minted, 600n);

  // A non-owner minting — a real, genuinely signed event, just not by
  // the owner — is a real, silent no-op, never a crash or a privilege escalation.
  const aliceContract = new Contract({ identity: alice, log, domain: 'my-token', definition });
  await mint(aliceContract, alice, alice.id, '999999');
  state = await aliceContract.state();
  assert.equal(state.balances[alice.id], 600n, 'unauthorized mint had no real effect');

  // Minting past the real cap is likewise a real no-op.
  await mint(ownerContract, owner, alice.id, '500'); // 600 + 500 > 1000 cap
  state = await ownerContract.state();
  assert.equal(state.minted, 600n, 'over-cap mint had no real effect');

  // A real transfer, alice -> bob.
  await transfer(aliceContract, alice, bob.id, '250');
  state = await ownerContract.state(); // any handle on the same real domain sees the identical real state
  assert.equal(state.balances[alice.id], 350n);
  assert.equal(state.balances[bob.id], 250n);

  // Bob overspending is a real, silent no-op.
  const bobContract = new Contract({ identity: bob, log, domain: 'my-token', definition });
  await transfer(bobContract, bob, alice.id, '999');
  state = await bobContract.state();
  assert.equal(state.balances[bob.id], 250n, 'overspend had no real effect');
});

test('SECURITY: a forged payload.from (claiming to be the owner, signed by someone else entirely) is rejected, not trusted', async () => {
  const owner = await generateIdentity();
  const attacker = await generateIdentity();
  const log = new EventLog();
  const definition = myToken({ owner: owner.id, cap: 1000n });
  const attackerContract = new Contract({ identity: attacker, log, domain: 'my-token', definition });

  // The attacker signs the action as THEMSELVES (a real, valid
  // signature) but claims `from: owner.id` in the plain fields — this
  // is exactly the forgery a naive `payload.from` check would miss.
  const forged = { from: owner.id, to: attacker.id, amount: '999', nonce: crypto.randomUUID(), timestamp: Date.now(), signerPubkey: attacker.publicKey };
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const msg = new TextEncoder().encode(JSON.stringify(forged, Object.keys(forged).sort()));
  const sigHex = await attacker.sign(msg);
  const forgedPayload = { ...forged, signature: sigHex };

  assert.equal(await verifySignedAction(forgedPayload), false, 'the signer does not really derive to the claimed `from`');
  await attackerContract.dispatch('mint', forgedPayload);
  const state = await attackerContract.state();
  assert.equal(state.minted, 0n, 'the forged mint had no real effect');
});

test('state() reflects real events dispatched by multiple independent Contract handles on the same domain', async () => {
  const owner = await generateIdentity();
  const log = new EventLog();
  const definition = myToken({ owner: owner.id, cap: 100n });
  const a = new Contract({ identity: owner, log, domain: 't', definition });
  const b = new Contract({ identity: owner, log, domain: 't', definition });
  await mint(a, owner, owner.id, '10');
  const stateFromB = await b.state();
  assert.equal(stateFromB.balances[owner.id], 10n);
});

test('signedAction/verifySignedAction round-trip for an arbitrary real action shape', async () => {
  const identity = await generateIdentity();
  const payload = await signedAction(identity, { from: identity.id, action: 'ping', value: 42 });
  assert.equal(await verifySignedAction(payload), true);
});

test('verifySignedAction rejects a tampered field even with an otherwise-real signature', async () => {
  const identity = await generateIdentity();
  const payload = await signedAction(identity, { from: identity.id, amount: '10' });
  const tampered = { ...payload, amount: '999999' };
  assert.equal(await verifySignedAction(tampered), false);
});
