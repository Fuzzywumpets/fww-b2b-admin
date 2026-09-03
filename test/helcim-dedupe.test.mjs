import assert from 'node:assert/strict';
import {
  claimHelcimInvoiceCreation,
  getHelcimInvoiceMap,
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
