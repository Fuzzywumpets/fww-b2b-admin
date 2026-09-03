import assert from 'node:assert/strict';
import { buildHelcimInvoiceMessage } from '../lib/helcim-invoice-message.mjs';

const message = buildHelcimInvoiceMessage({
  orderName: '#1010', invoiceNumber: 'FWW-1010', amount: 118, taxAmount: 8, amountText: '$118.00', currency: 'usd',
  paymentUrl: 'https://fuzzywumpets.myhelcim.com/order/?token=private-token',
});
assert.equal(message.subject, 'Your Fuzzywumpets invoice for order #1010');
assert.match(message.body, /Amount due: \$118\.00 USD/);
assert.match(message.body, /\[Pay your invoice securely\]\(https:\/\/fuzzywumpets\.myhelcim\.com\/order\/\?token=private-token\)/);
assert.doesNotMatch(message.body, /\nhttps:\/\//, 'payment URL must not appear as a bare customer-facing line');
assert.match(message.body, /Reply to this email/);
assert.deepEqual(message.creditCardInvoice, {
  invoiceNumber: 'FWW-1010',
  amount: 118,
  taxAmount: 8,
  currency: 'USD',
  paymentUrl: 'https://fuzzywumpets.myhelcim.com/order/?token=private-token',
});
assert.throws(
  () => buildHelcimInvoiceMessage({ orderName: '#1', invoiceNumber: 'FWW-1', amount: 1, amountText: '$1.00', currency: 'USD', paymentUrl: 'https://attacker.example/pay' }),
  /myhelcim\.com/,
);
assert.throws(
  () => buildHelcimInvoiceMessage({ orderName: '#1', invoiceNumber: 'FWW-1', amount: 0, amountText: '$0.00', currency: 'USD', paymentUrl: 'https://fuzzywumpets.myhelcim.com/pay' }),
  /positive/,
);
console.log('✓ branded Helcim invoice message contract');
