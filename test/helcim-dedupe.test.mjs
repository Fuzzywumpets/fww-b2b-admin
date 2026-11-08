import assert from 'node:assert/strict';
import {
  claimHelcimInvoiceCreation,
  getHelcimInvoiceClaim,
  getHelcimInvoiceMap,
  releaseCheckedHelcimInvoiceClaim,
  releaseHelcimInvoiceClaim,
  upsertHelcimInvoiceMap,
} from '../db.mjs';

const orderId = 'gid://shopify/Order/dedupe-test';
const metadata = { invoiceNumber: 'FWW-DEDUPE-TEST', amountCents: 1234, currency: 'USD' };

const [first, second] = await Promise.all([
  Promise.resolve().then(() => claimHelcimInvoiceCreation(orderId, metadata)),
  Promise.resolve().then(() => claimHelcimInvoiceCreation(orderId, metadata)),
]);
assert.equal(Number(first.acquired) + Number(second.acquired), 1, 'only one concurrent caller may win the durable claim');
assert.equal(releaseHelcimInvoiceClaim(orderId), true, 'definitive failure can release the claim');
assert.equal(claimHelcimInvoiceCreation(orderId, metadata).acquired, true, 'released definitive failure can be retried');

upsertHelcimInvoiceMap(orderId, {
  invoiceId: 'inv-dedupe', invoiceNumber: metadata.invoiceNumber,
  token: 'private-token', url: 'https://fuzzywumpets.myhelcim.com/order/?token=private-token',
  amount: 12.34, currency: 'USD',
});
const mapped = getHelcimInvoiceMap(orderId);
assert.equal(mapped.invoice_id, 'inv-dedupe');
assert.equal(mapped.amount, 12.34);
assert.equal(claimHelcimInvoiceCreation(orderId, metadata).acquired, true, 'claim was atomically consumed with the retry-ledger write');

console.log('✓ durable Helcim claim prevents concurrent duplicate invoice creation');

// Staff unlock ("I checked Helcim, unlock", POST /orders/:id/release-helcim-claim): compare-and-delete on created_at.
const stuckId = 'gid://shopify/Order/dedupe-unlock-test';
assert.equal(getHelcimInvoiceClaim(stuckId), null, 'no claim -> null');
const stuckAt = Date.now() - 10 * 60 * 1000;
const stuck = claimHelcimInvoiceCreation(stuckId, metadata, { now: stuckAt });
assert.equal(stuck.acquired, true);
assert.equal(stuck.claim.created_at, stuckAt, 'an explicit `now` sets the claim time (MOCK test hook backdates with it)');
assert.equal(getHelcimInvoiceClaim(stuckId).invoice_number, metadata.invoiceNumber);
assert.equal(releaseCheckedHelcimInvoiceClaim(stuckId, stuckAt + 1), false, 'a different claim time is a different claim: never released');
assert.ok(getHelcimInvoiceClaim(stuckId), 'the mismatched unlock left the claim in place');
assert.equal(releaseCheckedHelcimInvoiceClaim(stuckId, stuckAt), true, 'the exact claim the staff member saw is released');
assert.equal(getHelcimInvoiceClaim(stuckId), null);
assert.equal(releaseCheckedHelcimInvoiceClaim(stuckId, stuckAt), false, 'a second unlock finds nothing');
assert.equal(claimHelcimInvoiceCreation(stuckId, metadata).acquired, true, 'after the unlock the invoice button can claim again');
releaseHelcimInvoiceClaim(stuckId);

console.log('✓ staff unlock releases only the exact stuck claim it was shown');
