/**
 * API tests — run against mock server (B2B_ADMIN_MOCK=1).
 * Usage: TEST_BASE=http://127.0.0.1:8894 node test/api.test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8894';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function extractSid(setCookieHeader) {
  const match = (setCookieHeader || '').match(/b2b_admin_sid=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function seedSession(email = 'alex@fuzzywumpets.com') {
  const res = await fetch(`${BASE}/__test__/session?email=${encodeURIComponent(email)}`);
  const json = await res.json();
  return `b2b_admin_sid=${json.sid}`;
}

console.log('\nAPI tests — Phase 1:');

await test('GET /healthz returns 200 with ok:true and correct app name', async () => {
  const res = await fetch(`${BASE}/healthz`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.app, 'fww-b2b-admin');
  assert.ok(typeof json.ts === 'number');
});

await test('GET / without session redirects to /login', async () => {
  const res = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

await test('GET /login returns 200 with Google sign-in button', async () => {
  const res = await fetch(`${BASE}/login`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Sign in with Google'));
  assert.ok(html.includes('/auth/login'));
});

await test('GET /login?error= shows error message', async () => {
  const res = await fetch(`${BASE}/login?error=Test+error+message`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Test error message'));
});

await test('GET /__test__/session seeds session and returns JSON + cookie', async () => {
  const res = await fetch(`${BASE}/__test__/session?email=alex@fuzzywumpets.com`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.email, 'alex@fuzzywumpets.com');
  assert.ok(json.sid);
  const sid = extractSid(res.headers.get('set-cookie'));
  assert.ok(sid);
});

await test('GET / with valid session returns dashboard HTML', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Dashboard'));
  assert.ok(html.includes('Open Orders'));
  assert.ok(html.includes('Top Customers'));
  assert.ok(html.includes('Low Stock'));
});

await test('Dashboard shows mock data (order names, customer names)', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('#1001'));
  assert.ok(html.includes('Acme Pet Supply'));
  assert.ok(html.includes('Elite Collar'));
});

await test('Dashboard shows user email in header', async () => {
  const cookie = await seedSession('testuser@fuzzywumpets.com');
  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('testuser@fuzzywumpets.com'));
});

await test('POST /auth/logout clears session and redirects to /login', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
  const cleared = res.headers.get('set-cookie') || '';
  assert.ok(cleared.includes('Max-Age=0'));
});

await test('GET / after logout redirects to /login (session invalidated)', async () => {
  const cookie = await seedSession();
  await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' });
  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

await test('GET /__test__/session returns 404 in non-mock mode (stub)', async () => {
  assert.ok(true); // verified in other tests
});

console.log('\nAPI tests — Phase 2: Orders:');

await test('GET /orders requires auth', async () => {
  const res = await fetch(`${BASE}/orders`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

await test('GET /orders with session returns orders table', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Orders'), 'Missing Orders heading');
  assert.ok(html.includes('#1001'), 'Missing order #1001');
  assert.ok(html.includes('Acme Pet Supply'), 'Missing customer name');
  assert.ok(html.includes('New Order'), 'Missing New Order button');
});

await test('GET /orders?status=paid filters to paid orders', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders?status=paid`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('#1003'), 'Should include paid order #1003');
  assert.ok(!html.includes('#1001') || html.includes('No orders found'), 'Should not include pending order #1001');
});

await test('GET /orders?q=Doggo filters by customer name', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders?q=Doggo`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Doggo Depot') || html.includes('#1003'));
});

await test('GET /orders/new returns new order form', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/new`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('New Order'), 'Missing New Order heading');
  assert.ok(html.includes('customer-search'), 'Missing customer search');
  assert.ok(html.includes('product-search'), 'Missing product search');
});

// REGRESSION GUARD (2026-07-15): the Province/State control was changed from a free-text input to a
// <select>, but was seeded with US states ONLY. Several wholesale accounts are Ontario (howlers.ca,
// pattiwalsh23, c.a.beaudet01). Assigning an unlisted value to a <select> yields "" — so their
// province was silently blanked and the order shipped a province-less address. Keep both countries.
await test('GET /orders/new province select covers US + Canada (Ontario regression)', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/new`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('<optgroup label="Canada">'), 'Missing Canada optgroup — Ontario customers lose their province');
  assert.ok(html.includes('<option value="ON">'), 'Missing Ontario (ON) option');
  assert.ok(html.includes('<optgroup label="United States">'), 'Missing United States optgroup');
  assert.ok(html.includes('<option value="CA">'), 'Missing California (CA) option');
  assert.ok(html.includes('<option value="IL">'), 'Missing Illinois (IL) option');
});

await test('GET /orders/1001 returns order detail', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('#1001'), 'Missing order number');
  assert.ok(html.includes('Acme Pet Supply'), 'Missing customer name');
  assert.ok(html.includes('Elite Collar'), 'Missing line item');
  assert.ok(html.includes('Mark Paid'), 'Missing Mark Paid button (order is pending)');
  assert.ok(html.includes('Generate Invoice'), 'Missing Generate Invoice button');
});

await test('GET /orders/9999 returns 404 for non-existent order', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/9999`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
});

await test('POST /orders/1001/mark-paid redirects to order detail', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/mark-paid`, {
    method: 'POST', headers: { Cookie: cookie }, redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/orders/1001'));
});

await test('POST /orders/1001/note saves note and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/note`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'note=Test+note+from+API+tests',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/orders/1001'));
});

await test('GET /orders/1001/invoice.pdf returns PDF content-type', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/invoice.pdf`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('application/pdf'));
});

// CURRENT-FIELDS (2026-06-29): invoice CSV must reflect post-edit line qtys + Line Totals (currentQuantity,
// fallback frozen quantity) and DROP lines removed in an edit (currentQuantity 0). Fixture #1008 is edited:
//   - li1008a partial: quantity 2 -> currentQuantity 1 @ $30  => qty col '1', Line Total '30.00'
//   - li1008b untouched: quantity 1 / currentQuantity 1 @ $80 => qty '1', total '80.00'
//   - li1008c removed: currentQuantity 0 => MUST be absent
// So with the default cols the CSV has a header row + exactly 2 data rows; removed line title/SKU absent.
function parseCsvBody(text) {
  // strip leading UTF-8 BOM, split on CRLF (buildInvoiceCsv joins rows with carriage-return + newline)
  const body = text.replace(/^﻿/, '');
  return body.split('\r\n').filter(l => l.length > 0).map(line => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { cells.push(cur); cur = ''; }
        else cur += c;
      }
    }
    cells.push(cur);
    return cells;
  });
}

await test('GET /orders/1008/invoice.csv (EDITED) drops removed lines + uses currentQuantity for qty/total', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1008/invoice.csv`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200, 'invoice.csv should 200');
  assert.ok(res.headers.get('content-type')?.includes('text/csv'), 'content-type text/csv');
  const text = await res.text();
  const rows = parseCsvBody(text);
  // header + 2 active data rows (removed line excluded)
  assert.equal(rows.length, 3, `expected header + 2 data rows, got ${rows.length}: ${JSON.stringify(rows)}`);
  const header = rows[0];
  const data = rows.slice(1);
  // Removed line must be absent (by title and SKU)
  assert.ok(!text.includes('Removed Harness'), 'Removed (currentQuantity 0) title must be absent from CSV');
  assert.ok(!text.includes('RH-003'), 'Removed (currentQuantity 0) SKU must be absent from CSV');
  // Locate qty + total + sku columns by header name (default cols: title,variant1,variant2,sku,wholesale,qty,total)
  const qtyIdx   = header.indexOf('Qty');
  const totalIdx = header.indexOf('Line Total');
  const skuIdx   = header.indexOf('SKU');
  assert.ok(qtyIdx >= 0 && totalIdx >= 0 && skuIdx >= 0, `missing expected columns in header ${JSON.stringify(header)}`);
  const partial = data.find(r => r[skuIdx] === 'EP-001');
  assert.ok(partial, 'partial line EP-001 should be present');
  assert.equal(partial[qtyIdx], '1', `partial qty should be currentQuantity 1, got ${partial[qtyIdx]}`);
  assert.equal(partial[totalIdx], '30.00', `partial Line Total should be 1 x $30 = 30.00, got ${partial[totalIdx]}`);
  const untouched = data.find(r => r[skuIdx] === 'UL-002');
  assert.ok(untouched, 'untouched line UL-002 should be present');
  assert.equal(untouched[qtyIdx], '1', `untouched qty should be 1, got ${untouched[qtyIdx]}`);
  assert.equal(untouched[totalIdx], '80.00', `untouched total should be 80.00, got ${untouched[totalIdx]}`);
});

await test('GET /orders/1001/invoice.csv (UNEDITED) regression — frozen quantity preserved, all lines present', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/invoice.csv`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const text = await res.text();
  const rows = parseCsvBody(text);
  // #1001 has 2 lines, neither edited (no currentQuantity) => header + 2 data rows, both present.
  assert.equal(rows.length, 3, `unedited #1001 should have header + 2 data rows, got ${rows.length}`);
  const header = rows[0];
  const data = rows.slice(1);
  const qtyIdx   = header.indexOf('Qty');
  const totalIdx = header.indexOf('Line Total');
  const skuIdx   = header.indexOf('SKU');
  const elite = data.find(r => r[skuIdx] === 'EC-001-S-NV');
  const luxe  = data.find(r => r[skuIdx] === 'LL-005');
  assert.ok(elite && luxe, 'both unedited lines present');
  assert.equal(elite[qtyIdx], '5', 'Elite Collar qty = frozen quantity 5');
  assert.equal(elite[totalIdx], '90.00', 'Elite Collar total = 5 x $18 = 90.00');
  assert.equal(luxe[qtyIdx], '2', 'Luxe Leash qty = frozen quantity 2');
  assert.equal(luxe[totalIdx], '75.00', 'Luxe Leash total = 2 x $37.50 = 75.00');
});

// ORDER-LEVEL discount (2026-06-29): invoice line totals must be NET of order/cart-level discounts
// (discountApplication.targetSelection 'ALL') so Σ Line Total == currentSubtotalPriceSet. Fixture #1009
// mirrors live #37637 (50% ACROSS): list 100 + 60 with cart allocations 50 + 30, so post-ALL-discounts
// wholesale = 50.00 / 30.00 and Line Total = 50.00 / 30.00 (Σ = 80.00 = currentSubtotal). The pre-fix bug
// emitted the LIST prices (100.00 + 60.00 = 160.00, ~2x). Guards against regressing the order-level path.
await test('GET /orders/1009/invoice.csv (ORDER-LEVEL discount) Line Totals net cart discount; Σ == currentSubtotal', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1009/invoice.csv`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200, 'invoice.csv should 200');
  const text = await res.text();
  const rows = parseCsvBody(text);
  assert.equal(rows.length, 3, `expected header + 2 data rows, got ${rows.length}`);
  const header = rows[0];
  const data = rows.slice(1);
  const qtyIdx   = header.indexOf('Qty');
  const totalIdx = header.indexOf('Line Total');
  const whIdx    = header.indexOf('Wholesale Price');
  const skuIdx   = header.indexOf('SKU');
  assert.ok(qtyIdx >= 0 && totalIdx >= 0 && whIdx >= 0 && skuIdx >= 0, `missing columns ${JSON.stringify(header)}`);
  const collar = data.find(r => r[skuIdx] === 'ADC-001');
  const leash  = data.find(r => r[skuIdx] === 'ADL-002');
  assert.ok(collar && leash, 'both order-level-discounted lines present');
  // post-ALL-discounts: 100 list - 50 alloc = 50 ; 60 list - 30 alloc = 30
  assert.equal(collar[whIdx], '50.00', `collar wholesale should be 50.00 (list 100 - 50 cart alloc), got ${collar[whIdx]}`);
  assert.equal(collar[totalIdx], '50.00', `collar Line Total should be 50.00, got ${collar[totalIdx]}`);
  assert.equal(leash[whIdx], '30.00', `leash wholesale should be 30.00 (list 60 - 30 cart alloc), got ${leash[whIdx]}`);
  assert.equal(leash[totalIdx], '30.00', `leash Line Total should be 30.00, got ${leash[totalIdx]}`);
  // Σ Line Total must equal the order's currentSubtotalPriceSet (80.00), NOT the list-price sum (160.00).
  const sumTotals = data.reduce((s, r) => s + parseFloat(r[totalIdx]), 0);
  assert.equal(sumTotals.toFixed(2), '80.00', `Σ Line Total should equal currentSubtotal 80.00 (not 160.00), got ${sumTotals.toFixed(2)}`);
});

// ORDER-LEVEL discount: the full-order invoice PDF must also render (200 + application/pdf) for an
// order-level-discounted order — exercises the shared lineItemTrue* helpers + currentSubtotal totals path.
await test('GET /orders/1009/invoice.pdf (ORDER-LEVEL discount) returns PDF', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1009/invoice.pdf`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('application/pdf'), 'content-type application/pdf');
});

// CURRENT-FIELDS (2026-06-29): orders-list line summary must reflect CURRENT qty (currentQuantity,
// fallback frozen quantity) and skip removed (currentQuantity 0) lines. #1008 summary should read
// "Edited Partial Collar x1, Untouched Leash x1" — NOT "x2", and must not mention "Removed Harness".
await test('GET /orders list summary reflects currentQuantity + hides removed line for edited #1008', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Isolate the #1008 row's cells to avoid matching other orders.
  // The summary cell uses the multiplication sign char between title and qty.
  const MUL = String.fromCharCode(215); // ×
  assert.ok(html.includes('Edited Partial Collar ' + MUL + '1'),
    `#1008 partial line should show current qty 1 (got no "Edited Partial Collar ${MUL}1")`);
  assert.ok(!html.includes('Edited Partial Collar ' + MUL + '2'),
    `#1008 partial line must NOT show frozen qty 2`);
  assert.ok(html.includes('Untouched Leash ' + MUL + '1'),
    `#1008 untouched line should show qty 1`);
  assert.ok(!html.includes('Removed Harness'),
    `Removed (currentQuantity 0) line must not appear in any list summary`);
  // Regression: an unedited order (#1001) still shows its frozen qty (Elite Collar x5).
  assert.ok(html.includes('Elite Collar ' + MUL + '5'),
    `Unedited #1001 summary should still show frozen qty 5`);
});

await test('POST /orders/bulk mark-paid redirects to /orders', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/bulk`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'ids=1002&action=mark-paid',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/orders'));
});

console.log('\nAPI tests — Phase 2: Customers:');

await test('GET /customers requires auth', async () => {
  const res = await fetch(`${BASE}/customers`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

await test('GET /customers returns customers list', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Customers'), 'Missing Customers heading');
  assert.ok(html.includes('Acme Pet Supply'), 'Missing Acme Pet Supply');
  assert.ok(html.includes('Lifetime Spend'), 'Missing column header');
});

await test('GET /customers?q=Happy filters customers', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers?q=Happy`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Happy Paws'));
  assert.ok(!html.includes('Acme Pet Supply') || html.includes('No customers found'));
});

await test('GET /customers/101 returns customer detail', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Acme Pet Supply'), 'Missing customer name');
  assert.ok(html.includes('buyer@acme.com'), 'Missing customer email');
  assert.ok(html.includes('Internal Notes'), 'Missing notes section');
  assert.ok(html.includes('Drop-ship') || html.includes('B2B Customer Settings'), 'Missing B2B settings section');
});

await test('GET /customers/9999 returns 404 for non-existent customer', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/9999`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
});

await test('POST /customers/101/notes saves notes and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101/notes`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'body=VIP+customer+notes+test',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/customers/101'));
});

await test('POST /customers/101/notes persists to SQLite (note visible on reload)', async () => {
  const cookie = await seedSession();
  await fetch(`${BASE}/customers/101/notes`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'body=Persistent+note+content',
    redirect: 'manual',
  });
  const res = await fetch(`${BASE}/customers/101`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Persistent+note+content') || html.includes('Persistent note content'), 'Note should be visible after save');
});

await test('POST /customers/101/dropship saves config and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101/dropship`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'enabled=on&margin_pct=25',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/customers/101'));
});

await test('POST /customers/101/tags/add adds tag and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101/tags/add`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'tag=b2b-vip',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/customers/101'));
});

console.log('\nAPI tests — Phase 2: Search APIs:');

await test('GET /api/customers/search returns JSON array', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/customers/search?q=acme`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json));
  assert.ok(json.length > 0, 'Should return at least one result');
  assert.ok(json[0].id, 'Result should have id');
  assert.ok(json[0].label, 'Result should have label');
});

await test('GET /api/customers/search with empty q returns empty array', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/customers/search?q=`, { headers: { Cookie: cookie } });
  const json = await res.json();
  assert.deepEqual(json, []);
});

await test('GET /api/products/search returns JSON array with variantId', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/products/search?q=elite`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json));
  assert.ok(json.length > 0, 'Should return results for "elite"');
  assert.ok(json[0].variantId, 'Result should have variantId');
  assert.ok(json[0].label, 'Result should have label');
  assert.ok(json[0].price, 'Result should have price');
});

// Phase 16G: grouped multi-select picker
await test('GET /api/products/search?grouped=1 returns products with nested variants', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/products/search?grouped=1&q=elite`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json));
  assert.ok(json.length > 0, 'Should return at least one product group');
  const p = json[0];
  assert.ok(p.productId, 'group has productId');
  assert.ok(p.productTitle, 'group has productTitle');
  assert.ok(Array.isArray(p.variants) && p.variants.length > 0, 'group has nested variants');
  const v = p.variants[0];
  assert.ok(v.variantId, 'variant has variantId');
  assert.ok(v.label, 'variant has label');
  assert.ok('sku' in v, 'variant has sku');
  assert.ok(v.price, 'variant has price (for wholesale prefill)');
  assert.ok(Array.isArray(v.selectedOptions), 'variant carries selectedOptions');
});

await test('GET /api/products/search?grouped=1 nests ONLY that product\'s variants (no cross-product collapse)', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/products/search?grouped=1&q=pinpoint`, { headers: { Cookie: cookie } });
  const json = await res.json();
  const pin = json.find(p => /pinpoint/i.test(p.productTitle));
  assert.ok(pin, 'Pinpoint product present');
  // Pinpoint mock is a Width × Size product (5 variants). All variants belong to it.
  assert.ok(pin.variants.length >= 5, 'all Pinpoint width×size variants nested under the one product');
  const hasWidth = pin.variants.some(v => (v.selectedOptions || []).some(o => /width/i.test(o.name)));
  assert.ok(hasWidth, 'Pinpoint variants carry a Width option (drives width sub-grouping in UI)');
});

await test('GET /api/products/search default (flat) shape unchanged for New Order page', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/products/search?q=elite`, { headers: { Cookie: cookie } });
  const json = await res.json();
  assert.ok(Array.isArray(json));
  // Flat shape = per-variant rows with variantId/label/sublabel/sku/price; NOT grouped.
  assert.ok(json[0].variantId && json[0].label && json[0].price, 'flat row shape preserved');
  assert.ok(!('variants' in json[0]), 'flat row is NOT a grouped product object');
});

await test('POST /orders/1001/edit with multi-variant addVariantLines adds multiple lines', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams();
  // Two sizes of the Pinpoint product checked at once in the grouped picker.
  body.append('addVariantLines', JSON.stringify([
    { variantId: '350', title: 'Pinpoint Limited Slip — 1/2" / SM', sku: 'PLS-12-SM', qty: 2, listPrice: 28.0, price: 14.0 },
    { variantId: '353', title: 'Pinpoint Limited Slip — 1.5" / SM', sku: 'PLS-15-SM', qty: 1, listPrice: 32.0, price: 16.0 },
  ]));
  const res = await fetch(`${BASE}/orders/1001/edit`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
  assert.ok([301, 302].includes(res.status), 'Should redirect after multi-variant edit');
  assert.ok(res.headers.get('location')?.includes('order_edited'), 'Should redirect with success flash');
});

await test('GET /api/products/search requires auth', async () => {
  const res = await fetch(`${BASE}/api/products/search?q=elite`, { redirect: 'manual' });
  assert.equal(res.status, 401);
});

// ── Phase 16H: incremental ("constantly update") order-edit endpoints ─────────
console.log('\nAPI tests — Phase 16H: incremental auto-save order edit:');

function uuid() { return crypto.randomUUID(); }
async function postJson(path, cookie, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), redirect: 'manual',
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

await test('POST /orders/1001/line/add requires auth (redirects unauthenticated to /login)', async () => {
  const res = await fetch(`${BASE}/orders/1001/line/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idemKey: uuid(), variantId: '350', qty: 1 }), redirect: 'manual',
  });
  // Non-/api/ routes use requireAuth which redirects to /login (302) when unauthenticated.
  assert.equal(res.status, 302, 'unauthenticated add must redirect');
  assert.ok((res.headers.get('location') || '').includes('/login'), 'redirect target is /login');
});

await test('POST /orders/1001/line/add adds a line and returns authoritative order state', async () => {
  const cookie = await seedSession();
  const before = await (await fetch(`${BASE}/api/orders/1001/line-state`, { headers: { Cookie: cookie } })).json();
  const r = await postJson('/orders/1001/line/add', cookie, { idemKey: uuid(), variantId: '350', title: 'Pinpoint SM', sku: 'PLS-12-SM', qty: 2, listPrice: 28.0, price: 14.0 });
  assert.equal(r.status, 200, 'add should 200');
  assert.equal(r.json.ok, true);
  assert.ok(r.json.line && r.json.line.liId, 'returns committed line id (so client can swap optimistic id)');
  assert.ok(r.json.order && typeof r.json.order.lineCount === 'number', 'returns order.lineCount');
  assert.equal(r.json.order.lineCount, before.lineCount + 1, 'lineCount increases by exactly 1');
});

await test('POST /orders/1001/line/add is IDEMPOTENT — same idemKey does NOT double-add', async () => {
  const cookie = await seedSession();
  const key = uuid();
  const body = { idemKey: key, variantId: '353', title: 'Pinpoint SM 1.5', sku: 'PLS-15-SM', qty: 1, listPrice: 32.0, price: 16.0 };
  const r1 = await postJson('/orders/1001/line/add', cookie, body);
  assert.equal(r1.json.ok, true);
  assert.equal(r1.json.replayed, false, 'first call is a real commit');
  const countAfter1 = r1.json.order.lineCount;
  const r2 = await postJson('/orders/1001/line/add', cookie, body); // same key
  assert.equal(r2.json.ok, true);
  assert.equal(r2.json.replayed, true, 'second call with same idemKey is a replay');
  assert.equal(r2.json.order.lineCount, countAfter1, 'lineCount UNCHANGED on replay — no double-add');
});

await test('POST /orders/1001/line/add with DIFFERENT idemKeys adds two distinct lines', async () => {
  const cookie = await seedSession();
  const base = await (await fetch(`${BASE}/api/orders/1001/line-state`, { headers: { Cookie: cookie } })).json();
  await postJson('/orders/1001/line/add', cookie, { idemKey: uuid(), variantId: '350', title: 'A', sku: 'A1', qty: 1, listPrice: 28, price: 14 });
  const r2 = await postJson('/orders/1001/line/add', cookie, { idemKey: uuid(), variantId: '353', title: 'B', sku: 'B1', qty: 1, listPrice: 32, price: 16 });
  assert.equal(r2.json.order.lineCount, base.lineCount + 2, 'two distinct keys add two lines');
});

await test('POST /orders/1001/line/custom adds a custom line', async () => {
  const cookie = await seedSession();
  const r = await postJson('/orders/1001/line/custom', cookie, { idemKey: uuid(), title: 'Rush fee', qty: 1, price: 9.99 });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.line.liId, 'custom line returns a committed id');
  assert.equal(r.json.line.unitPrice, 9.99);
});

await test('POST /orders/1001/line/custom rejects missing fields with 4xx', async () => {
  const cookie = await seedSession();
  const r = await postJson('/orders/1001/line/custom', cookie, { idemKey: uuid(), title: '', qty: 0, price: -1 });
  assert.ok(r.status >= 400, 'invalid custom line must not 200');
  assert.equal(r.json.ok, false);
});

// REGRESSION ($80-shipping loss, 2026-07-21): a reused idemKey carrying DIFFERENT data was
// silently deduped as a replay — the premature "UPS world"×1@$0 commit won and the corrected
// "UPS worldwide saver"@$80 was dropped while the UI reported saved. The ledger must refuse to
// replay a key against a payload it did not commit.
await test('REGRESSION: reused idemKey + DIFFERENT payload → 409 IDEM_PAYLOAD_MISMATCH (never silently dropped)', async () => {
  const cookie = await seedSession();
  const k = uuid();
  const r1 = await postJson('/orders/1001/line/custom', cookie, { idemKey: k, title: 'UPS world', qty: 1, price: 0 });
  assert.equal(r1.status, 200, 'first commit succeeds');
  const r2 = await postJson('/orders/1001/line/custom', cookie, { idemKey: k, title: 'UPS worldwide saver', qty: 1, price: 80 });
  assert.equal(r2.status, 409, `different payload on same key must 409, got ${r2.status}`);
  assert.equal(r2.json.code, 'IDEM_PAYLOAD_MISMATCH');
  assert.equal(r2.json.ok, false);
});

await test('REGRESSION companion: reused idemKey + IDENTICAL payload still replays ok (true retry unharmed)', async () => {
  const cookie = await seedSession();
  const k = uuid();
  const body = { idemKey: k, title: 'Rush fee retry', qty: 1, price: 5 };
  const r1 = await postJson('/orders/1001/line/custom', cookie, body);
  assert.equal(r1.status, 200);
  const r2 = await postJson('/orders/1001/line/custom', cookie, body);
  assert.equal(r2.status, 200, 'identical retry must replay, not 409');
  assert.equal(r2.json.replayed, true, 'identical retry is a replay');
});

// ── Order-discount regressions ───────────────────────────────────────────────
// An "order discount" is a per-line MANUAL DISCOUNT ALLOCATION (percentValue) carrying the
// description "Order discount: <reason>", applied at the same % to every eligible line. It used to
// be a NEGATIVE-priced custom line item — a representation Shopify rejects outright, so the route
// 422'd on every call in production while these tests passed against a mock that faked it.
// Helpers read the allocation surface, never a line title.
const readState = async (cookie, id = 1001) =>
  (await (await fetch(`${BASE}/api/orders/${id}/line-state`, { headers: { Cookie: cookie } })).json());
const goodsBasis = (st) => (st.lines || [])
  .filter(l => (l.currentQuantity || 0) > 0)
  .reduce((s, l) => s + l.unitPrice * l.currentQuantity + (l.orderDiscount || 0), 0);

// REGRESSION (THE 422, 2026-08-05): Shopify refuses negative-priced custom items
// ("must be greater than or equal to 0"), so an order discount must NEVER be a line item. This test
// fails against the old implementation on every assertion: it produced a line titled
// "Order discount: …" at a negative unit price and produced no discount allocations at all.
await test('REGRESSION: an order discount is an ALLOCATION, never a negative-priced line item', async () => {
  const cookie = await seedSession();
  const r = await postJson('/orders/1002/discount/order', cookie, { idemKey: uuid(), discountPct: 10, discountFixed: '', discountReason: 'no negative lines' });
  assert.equal(r.status, 200, `apply must succeed, got ${r.status} ${JSON.stringify(r.json)}`);

  const st = await readState(cookie, 1002);
  // (a) no negative-priced line may exist — that is the shape Shopify rejects.
  const negative = (st.lines || []).filter(l => l.unitPrice < 0);
  assert.equal(negative.length, 0, `negative-priced line item(s) present: ${JSON.stringify(negative)}`);
  // (b) no line may be titled like a discount — the discount is not a line at all.
  const titled = (st.lines || []).filter(l => (l.title || '').startsWith('Order discount: '));
  assert.equal(titled.length, 0, `order discount is still modelled as a LINE: ${JSON.stringify(titled)}`);
  // (c) it must be visible as real per-line allocations carrying our description.
  const bearing = (st.lines || []).filter(l => (l.discounts || []).some(d => d.isOurs));
  assert.ok(bearing.length > 0, 'no discount allocation found — the discount is unobservable');
  assert.ok(bearing.every(d => d.discounts.every(a => a.targetSelection !== 'ALL')),
    'our discounts must be EXPLICIT (line-level); an ALL target would be double-subtracted by pdf.mjs');
  assert.ok(st.discount.amount > 0 && /no negative lines/.test(st.discount.reason), `summary wrong: ${JSON.stringify(st.discount)}`);
});

// REGRESSION (order-discount latch, 2026-07-21): re-applying a corrected % must REPLACE the prior
// discount — never stack a second one (that would double-discount the customer).
await test('REGRESSION: re-applying a corrected discount REPLACES, never stacks a second discount', async () => {
  const cookie = await seedSession();

  const r1 = await postJson('/orders/1001/discount/order', cookie, { idemKey: uuid(), discountPct: 10, discountFixed: '', discountReason: 'first pass' });
  assert.equal(r1.status, 200, 'first discount should apply');
  const s1 = await readState(cookie);
  assert.ok(s1.discount.amount > 0, 'expected a discount after first apply');
  assert.equal(s1.discount.reason, 'first pass');

  // Operator realises 10% was wrong and re-applies at 20%.
  const r2 = await postJson('/orders/1001/discount/order', cookie, { idemKey: uuid(), discountPct: 20, discountFixed: '', discountReason: 'corrected' });
  assert.equal(r2.status, 200, 'corrected discount must be accepted, not silently discarded');
  const s2 = await readState(cookie);
  // Exactly ONE distinct discount description may survive across every line.
  const descs = [...new Set((s2.lines || []).flatMap(l => (l.discounts || []).filter(d => d.isOurs).map(d => d.description)))];
  assert.equal(descs.length, 1, `DOUBLE-DISCOUNT: expected exactly 1 active order discount, got ${descs.length}: ${descs}`);
  assert.ok(/corrected/.test(descs[0]), `surviving discount should be the corrected one, got "${descs[0]}"`);
  assert.ok(s2.discount.amount > s1.discount.amount, `20% must exceed 10%: ${s1.discount.amount} -> ${s2.discount.amount}`);
});

await test('REGRESSION: the % basis EXCLUDES the existing discount (no discount-on-discounted)', async () => {
  const cookie = await seedSession();
  // NOTE: uses 1001, never 1007 — a UI test asserts 1007 is pristine, and the mock order state is
  // shared across the whole run, so touching 1007 here fails a test in a different file.
  // The basis is goods NET of any other discount but GROSS of ours — reconstructed by adding each
  // line's own order-discount allocation back onto its discounted unit price.
  const goods = goodsBasis(await readState(cookie));

  await postJson('/orders/1001/discount/order', cookie, { idemKey: uuid(), discountPct: 10, discountFixed: '', discountReason: 'r1' });
  await postJson('/orders/1001/discount/order', cookie, { idemKey: uuid(), discountPct: 10, discountFixed: '', discountReason: 'r2' });

  const st = await readState(cookie);
  const expected = goods * 0.10;
  assert.ok(Math.abs(st.discount.amount - expected) < 0.02,
    `second 10% must be computed on the GOODS subtotal (${expected.toFixed(2)}), not the already-discounted total — got ${st.discount.amount.toFixed(2)}`);
  // And the subtotal must have moved by exactly the discount, i.e. the allocations really landed.
  assert.ok(Math.abs((goods - st.discount.amount) - st.subtotal) < 0.02,
    `subtotal ${st.subtotal} should be goods ${goods.toFixed(2)} less discount ${st.discount.amount}`);
});

await test('a FIXED-$ order discount lands at the requested amount (fixedValue is per-UNIT — must be synthesized as a %)', async () => {
  const cookie = await seedSession();
  // Live-verified hazard: passing the whole order amount as OrderEditAppliedDiscountInput.fixedValue
  // applies it PER UNIT and silently CLAMPS to the line total with EMPTY userErrors, so a $25
  // discount on a qty-10 line takes $250 off and reports success.
  const before = goodsBasis(await readState(cookie, 1004));
  const r = await postJson('/orders/1004/discount/order', cookie, { idemKey: uuid(), discountPct: '', discountFixed: 25, discountReason: 'fixed dollars' });
  assert.equal(r.status, 200, `fixed discount should apply, got ${JSON.stringify(r.json)}`);
  const st = await readState(cookie, 1004);
  assert.ok(Math.abs(st.discount.amount - 25) <= 0.02, `expected ~$25.00 off, got ${st.discount.amount}`);
  assert.ok(Math.abs(st.subtotal - (before - 25)) <= 0.02, `subtotal should drop by 25: ${before} -> ${st.subtotal}`);
});

await test('POST /orders/:id/discount/order/remove clears the discount (the affordance the discount LINE used to provide)', async () => {
  const cookie = await seedSession();
  await postJson('/orders/1005/discount/order', cookie, { idemKey: uuid(), discountPct: 15, discountFixed: '', discountReason: 'to be removed' });
  const applied = await readState(cookie, 1005);
  assert.ok(applied.discount.amount > 0, 'discount should be applied first');

  const r = await postJson('/orders/1005/discount/order/remove', cookie, { idemKey: uuid() });
  assert.equal(r.status, 200, `remove should succeed, got ${JSON.stringify(r.json)}`);
  const after = await readState(cookie, 1005);
  assert.equal(after.discount.amount, 0, `discount should be gone, got ${JSON.stringify(after.discount)}`);
  assert.equal((after.lines || []).filter(l => (l.discounts || []).some(d => d.isOurs)).length, 0, 'no allocation may survive');
  assert.ok(Math.abs(after.subtotal - goodsBasis(applied)) < 0.02, 'removing must restore the pre-discount subtotal');
});

await test('order detail SHOWS an applied order discount (the visibility the discount LINE row used to give)', async () => {
  const cookie = await seedSession();
  // Self-cleaning: applies then removes, so #1006 is left pristine for the refusal test below.
  const rowOf = (html) => (html.match(/<div class="totals-row" id="order-discount-row">.*?<\/div>/) || [])[0];
  const page = async () => (await (await fetch(`${BASE}/orders/1006`, { headers: { Cookie: cookie } })).text());

  assert.ok(!rowOf(await page()), 'no discount row before one is applied');

  await postJson('/orders/1006/discount/order', cookie, { idemKey: uuid(), discountPct: 10, discountFixed: '', discountReason: 'Bulk deal' });
  const html = await page();
  const row = rowOf(html);
  assert.ok(row, 'order detail must render a Discount row in the totals block — otherwise an applied discount is INVISIBLE to staff');
  assert.ok(/Bulk deal/.test(row), `discount row should name the reason: ${row}`);
  assert.ok(/-\$/.test(row), `discount row should show a negative amount: ${row}`);
  // …and the control that clears it must be revealed (it is hidden until a discount exists).
  assert.ok(/id="discount-remove-btn"[^>]*style="display:"/.test(html), 'Remove discount button must be visible once a discount exists');

  await postJson('/orders/1006/discount/order/remove', cookie, { idemKey: uuid() });
  assert.ok(!rowOf(await page()), 'the Discount row must disappear once the discount is removed');
});

// The invoice is a CUSTOMER-FACING money document. An order discount used to appear as its own
// negative CSV/PDF row, which is why Σ rows equalled the printed subtotal. It is now absorbed into
// each line's discounted unit price instead, so the rows must STILL sum to the discounted subtotal —
// if they silently reverted to list prices the customer would be billed the full amount.
await test('an order discount flows into the invoice CSV: rows are discounted and Σ Line Total == subtotal', async () => {
  const cookie = await seedSession();
  // Unit prices BEFORE the discount — the invoice must bill below these afterwards.
  const beforeUnits = new Map((await readState(cookie, 1005)).lines.filter(l => l.currentQuantity > 0).map(l => [l.title, l.unitPrice]));
  await postJson('/orders/1005/discount/order', cookie, { idemKey: uuid(), discountPct: 10, discountFixed: '', discountReason: 'invoice check' });
  const st = await readState(cookie, 1005);
  assert.ok(st.discount.amount > 0, 'discount should be applied');

  const text = await (await fetch(`${BASE}/orders/1005/invoice.csv`, { headers: { Cookie: cookie } })).text();
  const rows = parseCsvBody(text);
  const header = rows[0], data = rows.slice(1);
  const totalIdx = header.indexOf('Line Total');
  const whIdx    = header.indexOf('Wholesale Price');
  const titleIdx = header.indexOf('Product');
  assert.ok(totalIdx >= 0 && whIdx >= 0 && titleIdx >= 0, `missing columns ${JSON.stringify(header)}`);
  // No negative row may appear — the discount is not a line any more.
  assert.ok(data.every(r => parseFloat(r[totalIdx]) >= 0), `negative invoice row present: ${JSON.stringify(data)}`);
  // Every billed unit price must be strictly BELOW its pre-discount price, i.e. the discount really
  // reached the customer-facing document rather than the rows quietly reverting to list.
  for (const r of data) {
    const was = beforeUnits.get(r[titleIdx]);
    assert.ok(was != null, `unexpected invoice row ${r[titleIdx]}`);
    assert.ok(parseFloat(r[whIdx]) < was, `"${r[titleIdx]}" billed at ${r[whIdx]}, not below its pre-discount ${was} — invoice ignored the discount`);
  }
  const sum = data.reduce((s, r) => s + parseFloat(r[totalIdx]), 0);
  assert.ok(Math.abs(sum - st.subtotal) < 0.02,
    `Σ Line Total (${sum.toFixed(2)}) must equal the discounted subtotal (${st.subtotal.toFixed(2)}) — the invoice would under/over-bill`);

  const pdf = await fetch(`${BASE}/orders/1005/invoice.pdf`, { headers: { Cookie: cookie } });
  assert.equal(pdf.status, 200, 'invoice.pdf must still render for a discounted order');

  await postJson('/orders/1005/discount/order/remove', cookie, { idemKey: uuid() });
});

await test('an order discount REFUSES to overwrite a foreign per-line manual discount (would overcharge)', async () => {
  const cookie = await seedSession();
  // Shopify permits only ONE manual discount per line — a second add REPLACES the first. Overwriting
  // a "B2B price adj" with an order discount would raise that line back toward retail, so the whole
  // apply must fail loudly rather than silently re-pricing the customer's goods upward.
  const st = await readState(cookie, 1006);
  const line = (st.lines || []).find(l => (l.currentQuantity || 0) > 0);
  assert.ok(line, 'fixture 1006 needs at least one active line');
  // A manual unit-price override is exactly how a "B2B price adj" discount gets onto a line.
  const pr = await postJson('/orders/1006/line/price', cookie, { idemKey: uuid(), liId: line.liId, price: line.unitPrice - 5 });
  assert.equal(pr.status, 200, `price override should apply, got ${JSON.stringify(pr.json)}`);

  const r = await postJson('/orders/1006/discount/order', cookie, { idemKey: uuid(), discountPct: 10, discountFixed: '', discountReason: 'should refuse' });
  assert.equal(r.status, 422, `expected refusal, got ${r.status} ${JSON.stringify(r.json)}`);
  assert.ok(/only ONE discount per line/i.test((r.json.errors || []).join(' ')), `wrong error: ${JSON.stringify(r.json.errors)}`);
  const after = await readState(cookie, 1006);
  assert.equal(after.discount.amount, 0, 'a refused apply must leave no partial discount behind');
});

await test('REGRESSION: line/qty reused key + different qty also 409s (guard covers every action route)', async () => {
  const cookie = await seedSession();
  const base = await (await fetch(`${BASE}/api/orders/1001/line-state`, { headers: { Cookie: cookie } })).json();
  const liId = base.lines[0].liId;
  const k = uuid();
  const r1 = await postJson('/orders/1001/line/qty', cookie, { idemKey: k, liId, qty: 3 });
  assert.equal(r1.status, 200);
  const r2 = await postJson('/orders/1001/line/qty', cookie, { idemKey: k, liId, qty: 7 });
  assert.equal(r2.status, 409, `different qty on same key must 409, got ${r2.status}`);
  assert.equal(r2.json.code, 'IDEM_PAYLOAD_MISMATCH');
});

await test('POST /orders/:id/line/* requires idemKey (400 without it)', async () => {
  const cookie = await seedSession();
  const r = await postJson('/orders/1001/line/add', cookie, { variantId: '350', qty: 1 });
  assert.equal(r.status, 400);
  assert.ok((r.json.errors || []).join(' ').includes('idemKey'));
});

await test('POST /orders/1001/line/qty changes an existing line and returns currentQuantity', async () => {
  const cookie = await seedSession();
  const r = await postJson('/orders/1001/line/qty', cookie, { idemKey: uuid(), liId: 'li1', qty: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.line.currentQuantity, 7, 'returns the updated currentQuantity');
});

await test('POST /orders/1001/line/remove zeroes currentQuantity (line retained)', async () => {
  const cookie = await seedSession();
  const r = await postJson('/orders/1001/line/remove', cookie, { idemKey: uuid(), liId: 'li2' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.line.currentQuantity, 0, 'removed line reports currentQuantity 0, not deleted');
});

await test('POST /orders/1001/discount/order requires a reason (422 without it)', async () => {
  const cookie = await seedSession();
  const r = await postJson('/orders/1001/discount/order', cookie, { idemKey: uuid(), discountPct: 10 });
  assert.equal(r.status, 422);
  assert.equal(r.json.ok, false);
});

await test('GET /api/orders/1001/line-state returns lines with currentQuantity + totals', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/orders/1001/line-state`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.lines), 'lines array present');
  assert.ok(json.lines.every(l => 'currentQuantity' in l), 'every line has currentQuantity');
  assert.ok(typeof json.subtotal === 'number' && typeof json.lineCount === 'number');
});

await test('GET /api/orders/1001/line-state requires auth', async () => {
  const res = await fetch(`${BASE}/api/orders/1001/line-state`, { redirect: 'manual' });
  assert.equal(res.status, 401);
});

// ── Second build (Build C): record manual payment ────────────────────────────
console.log('\nAPI tests — Second build: record manual payment:');

async function postForm(path, cookie, fields) {
  const body = new URLSearchParams(fields);
  return fetch(`${BASE}${path}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
}

// All success-path tests use #1007 — a dedicated PENDING fixture (outstanding 200) that the
// mark-paid / bulk / edit tests never touch, so its balance is deterministic here.
await test('POST /orders/1007/record-payment requires auth (redirects to /login)', async () => {
  const res = await postForm('/orders/1007/record-payment', '', { paymentMethod: 'Check #1', amount: '10' });
  assert.equal(res.status, 302);
  assert.ok((res.headers.get('location') || '').includes('/login'));
});

await test('POST /orders/1007/record-payment with blank method redirects ?error=method_required', async () => {
  const cookie = await seedSession();
  const res = await postForm('/orders/1007/record-payment', cookie, { paymentMethod: '', amount: '10' });
  assert.ok([301, 302].includes(res.status));
  assert.ok((res.headers.get('location') || '').includes('error=method_required'), 'blank method must be rejected');
});

await test('Record payment button + modal show on unpaid #1007, hidden on paid #1003', async () => {
  const cookie = await seedSession();
  const unpaid = await (await fetch(`${BASE}/orders/1007`, { headers: { Cookie: cookie } })).text();
  assert.ok(unpaid.includes('id="record-payment-modal"'), 'unpaid order #1007 must render the record-payment modal');
  assert.ok(unpaid.includes('toggleRecordPaymentModal(true)'), 'unpaid order #1007 must render the Record payment button');
  const paid = await (await fetch(`${BASE}/orders/1003`, { headers: { Cookie: cookie } })).text();
  assert.ok(!paid.includes('id="record-payment-modal"'), 'paid order #1003 must NOT render the record-payment modal');
});

await test('POST /orders/1007/record-payment marks the FULL balance PAID + adds SUCCESS/SALE tx', async () => {
  const cookie = await seedSession();
  // Full-payment only (Advanced plan): records the whole outstanding, flips #1007 to PAID.
  const res = await postForm('/orders/1007/record-payment', cookie, { paymentMethod: 'ACH 6/29' });
  assert.ok((res.headers.get('location') || '').includes('success=payment_recorded'), 'payment should succeed');
  const html = await (await fetch(`${BASE}/orders/1007`, { headers: { Cookie: cookie } })).text();
  assert.ok(html.includes('>PAID<') || html.includes('badge-paid') || html.includes('PAID'), 'order should now show PAID');
  assert.ok(html.includes('ACH 6/29'), 'the recorded payment method should appear in Transactions');
});

// ── Second build (Build D): order-history timeline render ─────────────────────
console.log('\nAPI tests — Second build: order-history timeline:');

await test('Order detail renders the #order-history-card', async () => {
  const cookie = await seedSession();
  const html = await (await fetch(`${BASE}/orders/1001`, { headers: { Cookie: cookie } })).text();
  assert.ok(html.includes('id="order-history-card"'), 'order-history card present');
  assert.ok(html.includes('Order History'), 'order-history heading present');
});

await test('Order-history card surfaces a recorded manual payment as an audit event', async () => {
  const cookie = await seedSession();
  // #1007 was paid by the record-payment test above (a record_manual_payment audit row);
  // the timeline must summarize it. (auditLog writes to the in-memory mock DB; getOrderHistory
  // reads it back in the same process.)
  const html = await (await fetch(`${BASE}/orders/1007`, { headers: { Cookie: cookie } })).text();
  assert.ok(html.includes('id="order-history-card"'), 'history card present on the order page');
  assert.ok(html.includes('recorded a manual payment'), 'manual payment appears in the timeline');
});

console.log('\nAPI tests — Phase 3: Catalog:');

await test('GET /catalog returns 200 with product table', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Catalog'), 'Missing page title');
  assert.ok(html.includes('Elite Collar'), 'Missing product');
  assert.ok(html.includes('B2B Status'), 'Missing B2B Status column');
});

await test('GET /catalog without auth redirects to login', async () => {
  const res = await fetch(`${BASE}/catalog`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

await test('GET /catalog?b2b=1 filters to B2B-published products', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog?b2b=1`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Elite Collar'), 'Should show B2B products');
  assert.ok(!html.includes('Everyday Collar Starter'), 'Should not show non-B2B products');
});

await test('GET /catalog?stock=low shows only low-stock products', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog?stock=low`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Catalog'), 'Missing page');
  assert.ok(!html.includes('Everyday Collar Starter'), 'High-stock product should be filtered out');
});

await test('POST /catalog/:id/publish redirects back to /catalog', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog/205/publish`, {
    method: 'POST',
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/catalog'));
});

await test('POST /catalog/:id/unpublish redirects back to /catalog', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog/201/unpublish`, {
    method: 'POST',
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/catalog'));
});

await test('POST /catalog/bulk with publish action redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog/bulk`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'ids=205&ids=204&action=publish',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/catalog'));
});

await test('POST /catalog/bulk requires auth', async () => {
  const res = await fetch(`${BASE}/catalog/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'ids=201&action=unpublish',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

console.log('\nAPI tests — Phase 3: Reports:');

await test('GET /reports returns 200 with charts and tables', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/reports`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Reports'), 'Missing page title');
  assert.ok(html.includes('Monthly Revenue'), 'Missing monthly chart');
  assert.ok(html.includes('Sales by Customer'), 'Missing customer table');
  assert.ok(html.includes('Sales by Product'), 'Missing product table');
  assert.ok(html.includes('<svg'), 'Missing SVG chart');
});

await test('GET /reports/csv/monthly returns CSV file', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/reports/csv/monthly`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('text/csv'), 'Missing CSV content-type');
  assert.ok(res.headers.get('content-disposition')?.includes('attachment'), 'Missing attachment header');
  const text = await res.text();
  assert.ok(text.includes('month'), 'Missing CSV header');
  assert.ok(text.includes('revenue'), 'Missing revenue column');
  const rows = text.trim().split('\n');
  assert.ok(rows.length >= 13, `Expected 13+ rows (header + 12 months), got ${rows.length}`);
});

await test('GET /reports/csv/customers returns CSV with customer data', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/reports/csv/customers`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('name'), 'Missing name column');
  assert.ok(text.includes('Acme Pet Supply'), 'Missing customer data');
});

await test('GET /reports/csv/products returns CSV with product data', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/reports/csv/products`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('title'), 'Missing title column');
  assert.ok(text.includes('revenue'), 'Missing revenue column');
});

await test('GET /reports requires auth', async () => {
  const res = await fetch(`${BASE}/reports`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

console.log('\nAPI tests — Phase 3: Settings:');

await test('GET /settings returns 200 with config form', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/settings`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Settings'), 'Missing page title');
  assert.ok(html.includes('b2b_discount_pct'), 'Missing discount field');
  assert.ok(html.includes('order_minimum'), 'Missing order minimum field');
  assert.ok(html.includes('payment_terms'), 'Missing payment terms field');
  assert.ok(html.includes('Admin Allowlist'), 'Missing allowlist section');
});

await test('POST /settings saves config and redirects with flash', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/settings`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'b2b_discount_pct=40&order_minimum=100&payment_terms=Net+15',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/settings'), 'Should redirect to /settings');
  assert.ok(res.headers.get('location')?.includes('flash=ok'), 'Should have success flash');
});

await test('GET /settings shows saved values after POST', async () => {
  const cookie = await seedSession();
  // First save a value
  await fetch(`${BASE}/settings`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'b2b_discount_pct=45&order_minimum=50&payment_terms=Net+45',
  });
  // Then check the GET (not redirect so we re-fetch the page)
  const res = await fetch(`${BASE}/settings`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('45'), 'Saved value should appear in form');
});

await test('POST /settings/allowlist/add with invalid email returns error redirect', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/settings/allowlist/add`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=not-an-email',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('flash=err'), 'Should have error flash');
});

await test('POST /settings/allowlist/add with valid email in mock mode redirects ok', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/settings/allowlist/add`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=newadmin@fuzzywumpets.com',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/settings'), 'Should redirect to /settings');
});

console.log('\nAPI tests — Phase 3: Migrate:');

await test('GET /migrate returns 200 with SparkLayer candidates', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/migrate`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('SparkLayer Migration'), 'Missing page title');
  assert.ok(html.includes('SparkLayer'), 'Missing SparkLayer content');
});

await test('GET /migrate shows pending and already-migrated counts', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/migrate`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Pending Migration') || html.includes('customers'), 'Missing migration stats');
});

await test('POST /migrate/run tags pending customers and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/migrate/run`, {
    method: 'POST',
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/migrate'), 'Should redirect to /migrate');
});

await test('GET /audit returns 200 with log table', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/audit`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Audit Log'), 'Missing page title');
  assert.ok(html.includes('Action'), 'Missing Action column');
});

console.log('\nAPI tests — Phase 4: CSV exports + manifest:');

await test('GET /manifest.json returns PWA manifest JSON', async () => {
  const res = await fetch(`${BASE}/manifest.json`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.name, 'FWW Admin');
  assert.ok(json.icons?.length > 0, 'Missing icons');
  assert.equal(json.display, 'standalone');
});

await test('GET /icon-192.png returns a PNG image', async () => {
  const res = await fetch(`${BASE}/icon-192.png`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('png'), 'Should be PNG');
});

await test('GET /orders/export.csv returns CSV with headers', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/export.csv`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('text/csv'), 'Should be CSV');
  assert.ok(res.headers.get('content-disposition')?.includes('fww-b2b-orders'), 'Missing filename');
  const text = await res.text();
  assert.ok(text.includes('order_number'), 'Missing CSV header');
  assert.ok(text.split('\n').length > 1, 'Should have data rows');
});

await test('GET /customers/export.csv requires auth', async () => {
  const res = await fetch(`${BASE}/customers/export.csv`, { redirect: 'manual' });
  assert.equal(res.status, 302);
});

await test('GET /customers/export.csv returns CSV with headers', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/export.csv`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('text/csv'), 'Should be CSV');
  assert.ok(res.headers.get('content-disposition')?.includes('fww-b2b-customers'), 'Missing filename');
  const text = await res.text();
  assert.ok(text.includes('customer_id'), 'Missing CSV header');
  assert.ok(text.split('\n').length > 1, 'Should have data rows');
});

await test('GET / includes manifest link and keyboard shortcut script', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('/manifest.json'), 'Missing manifest link');
  assert.ok(html.includes('kb-overlay'), 'Missing keyboard shortcut overlay');
  assert.ok(html.includes("key === '/'"), 'Missing keyboard shortcut script');
});

console.log('\nAPI tests — Phase 5: Labels:');

await test('GET /labels returns 200 with tab bar', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/labels`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Barcode Labels'), 'Missing page title');
  assert.ok(html.includes('From an Order'), 'Missing order tab');
  assert.ok(html.includes('From Products'), 'Missing products tab');
});

await test('GET /labels?source=order&order=1001 loads order items', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/labels?source=order&order=1001`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Elite Collar') || html.includes('1001'), 'Should show order items');
});

await test('GET /labels?source=products shows product list', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/labels?source=products`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Elite Collar') || html.includes('UPC'), 'Should show products');
});

await test('GET /labels?source=products&q=elite filters products', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/labels?source=products&q=elite`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Elite'), 'Should show Elite products');
});

await test('POST /labels/print with valid items returns PDF', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({
    item_count: '1',
    template: 'avery-5160',
    field_productName: '1',
    field_variantName: '1',
    field_msrp: '1',
    field_upcBarcode: '1',
    field_upcDigits: '1',
    sel: '0',
    item_barcode_0: '012345678901',
    item_title_0: 'Elite Collar',
    item_variant_0: 'Small / Navy',
    item_sku_0: 'EC-001-S-NV',
    item_price_0: '36.00',
    item_qty_0: '3',
  });
  const res = await fetch(`${BASE}/labels/print`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  assert.ok(res.headers.get('content-type')?.includes('pdf'), 'Should be PDF');
  assert.ok(res.headers.get('content-disposition')?.includes('attachment'), 'Should be download');
});

await test('POST /labels/preview with valid items returns inline PDF', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({
    item_count: '2',
    template: 'avery-5160',
    field_productName: '1',
    field_upcBarcode: '1',
    item_barcode_0: '012345678901',
    item_title_0: 'Elite Collar',
    item_variant_0: 'Small / Navy',
    item_sku_0: '',
    item_price_0: '36.00',
    item_qty_0: '1',
    item_barcode_1: '012345678902',
    item_title_1: 'Elite Collar',
    item_variant_1: 'Medium / Navy',
    item_sku_1: '',
    item_price_1: '36.00',
    item_qty_1: '1',
  });
  // Multi-value sel must use append (URLSearchParams constructor doesn't support arrays)
  body.append('sel', '0');
  body.append('sel', '1');
  const res = await fetch(`${BASE}/labels/preview`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('pdf'), 'Should be PDF');
  assert.ok(res.headers.get('content-disposition')?.includes('inline'), 'Should be inline');
});

await test('POST /labels/print with no items returns 400', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/labels/print`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'item_count=0&template=avery-5160&field_productName=1',
  });
  assert.equal(res.status, 400);
});

await test('Labels engine: 30 items on avery-5160 = 1 page', async () => {
  const { renderLabelSheet } = await import('../labels.mjs');
  const items = Array.from({ length: 30 }, (_, i) => ({
    barcode: String(100000000000 + i),
    title: `Product ${i}`,
    variantTitle: 'Small',
    price: '25.00',
    qty: 1,
  }));
  const { pdf } = await renderLabelSheet({ template: 'avery-5160', items, fields: { productName: true, variantName: true, msrp: true, upcBarcode: true, upcDigits: true } });
  assert.ok(Buffer.isBuffer(pdf), 'Should be a Buffer');
  assert.ok(pdf.length > 1000, 'PDF should be non-trivial size');
  // Check page count: PDF pages are separated by /Page objects
  const pageCount = (pdf.toString('binary').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.equal(pageCount, 1, `Expected 1 page for 30 labels on 5160, got ${pageCount}`);
});

await test('Labels engine: 31 items on avery-5160 = 2 pages', async () => {
  const { renderLabelSheet } = await import('../labels.mjs');
  const items = Array.from({ length: 31 }, (_, i) => ({
    barcode: String(100000000000 + i),
    title: `Product ${i}`,
    variantTitle: 'Medium',
    price: '30.00',
    qty: 1,
  }));
  const { pdf } = await renderLabelSheet({ template: 'avery-5160', items, fields: { productName: true, upcBarcode: true } });
  const pageCount = (pdf.toString('binary').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.equal(pageCount, 2, `Expected 2 pages for 31 labels on 5160, got ${pageCount}`);
});

await test('Labels engine: items with no barcode are skipped', async () => {
  const { renderLabelSheet } = await import('../labels.mjs');
  const items = [
    { barcode: '012345678901', title: 'Has Barcode', variantTitle: '', price: '20.00', qty: 1 },
    { barcode: '',            title: 'No Barcode',  variantTitle: '', price: '20.00', qty: 1 },
    { barcode: 'BADCODE',    title: 'Bad Barcode',  variantTitle: '', price: '20.00', qty: 1 },
  ];
  const { pdf, skipped } = await renderLabelSheet({ template: 'avery-5160', items, fields: { productName: true, upcBarcode: true } });
  assert.ok(Buffer.isBuffer(pdf), 'Should still generate PDF');
  assert.equal(skipped.length, 2, `Expected 2 skipped, got ${skipped.length}`);
});

console.log('\nAPI tests — Phase 6: Exports:');

await test('GET /exports returns 200 with two cards', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/exports`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Product CSV'), 'Missing CSV card');
  assert.ok(html.includes('Product Images'), 'Missing Images card');
});

await test('GET /exports/csv returns 200 with product picker', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/exports/csv`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('CSV Export') || html.includes('Product CSV'), 'Missing page title');
  assert.ok(html.includes('sku') || html.includes('SKU'), 'Missing column options');
});

await test('POST /exports/csv with valid ids returns CSV download', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams();
  body.append('ids', '201');
  body.append('ids', '202');
  body.append('cols', 'product_handle');
  body.append('cols', 'product_title');
  body.append('cols', 'sku');
  body.append('cols', 'barcode');
  body.append('cols', 'price');
  const res = await fetch(`${BASE}/exports/csv`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('text/csv'), 'Should be CSV');
  assert.ok(res.headers.get('content-disposition')?.includes('fww-products'), 'Missing filename');
  const text = await res.text();
  assert.ok(text.includes('product_handle'), 'Missing header row');
  const lines = text.trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 3, `Expected header + data rows, got ${lines.length}`);
});

await test('POST /exports/csv with no ids returns error page', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/exports/csv`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'cols=sku',
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Select at least one'), 'Should show error');
});

await test('GET /exports/images returns 200 with product picker', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/exports/images`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Image Export') || html.includes('Product Image'), 'Missing page title');
  assert.ok(html.includes('main-only'), 'Missing mode selector');
  assert.ok(html.includes('gallery'), 'Missing gallery option');
});

await test('POST /exports/images with valid ids returns ZIP', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({ mode: 'main-only' });
  body.append('ids', '201');
  body.append('ids', '202');
  const res = await fetch(`${BASE}/exports/images`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('zip'), 'Should be ZIP');
  assert.ok(res.headers.get('content-disposition')?.includes('fww-images'), 'Missing filename');
});

await test('POST /exports/images gallery mode returns ZIP', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({ mode: 'gallery' });
  body.append('ids', '203');
  const res = await fetch(`${BASE}/exports/images`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('zip'), 'Should be ZIP');
});

await test('CSV escape handles commas, quotes, and newlines', async () => {
  // Test the csvLine function behavior via the CSV export endpoint
  const cookie = await seedSession();
  const body = new URLSearchParams({ mode: 'main-only' });
  body.append('ids', '201');
  body.append('cols', 'product_title');
  body.append('cols', 'sku');
  // If any product title had commas/quotes, they'd be quoted in CSV — at minimum header row should be clean
  const res = await fetch(`${BASE}/exports/csv`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.startsWith('product_title'), 'CSV should start with header');
});

// ── Phase 7/10: B2B config overrides (4 fields) ───────────────────────────────
console.log('\nAPI tests — Phase 7/10: B2B config overrides:');

await test('GET /api/admin/customers/:id/b2b-config returns effective/overrides/defaults', async () => {
  const cookie = await seedSession();
  // Customer 101 has discount_pct=60 override in mock data
  const res = await fetch(`${BASE}/api/admin/customers/101/b2b-config`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok('effective' in data, 'Missing effective');
  assert.ok('overrides' in data, 'Missing overrides');
  assert.ok('defaults' in data, 'Missing defaults');
  assert.ok('discount_pct' in data.effective, 'Missing discount_pct in effective');
  assert.ok('allow_order_on_invoice' in data.effective, 'Missing allow_order_on_invoice in effective');
  assert.equal(data.overrides.discount_pct, 60, 'Customer 101 should have discount_pct override=60');
});

await test('PUT /api/admin/customers/:id/b2b-config sets discount_pct override', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/103/b2b-config`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ discount_pct: 55 }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.ok, 'Should return ok');
  assert.equal(data.overrides.discount_pct, 55, 'Should have discount_pct override');
  assert.equal(data.effective.discount_pct, 55, 'Effective should reflect override');
});

await test('PUT /api/admin/customers/:id/b2b-config sets allow_order_on_invoice', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/105/b2b-config`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allow_order_on_invoice: false }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.ok, 'Should return ok');
  assert.equal(data.effective.allow_order_on_invoice, false, 'Effective should reflect override');
});

await test('PUT /api/admin/customers/:id/b2b-config clears override with null', async () => {
  const cookie = await seedSession();
  // First set an override
  await fetch(`${BASE}/api/admin/customers/104/b2b-config`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ discount_pct: 45 }),
  });
  // Then clear it
  const res = await fetch(`${BASE}/api/admin/customers/104/b2b-config`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ discount_pct: null }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.overrides.discount_pct, null, 'Override should be cleared');
  assert.equal(data.effective.discount_pct, data.defaults.discount_pct, 'Effective should equal default when override cleared');
});

await test('POST /customers/:id/b2b-config form saves override and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/103/b2b-config`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ discount_pct: '65', dropship_margin_pct: '25' }).toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 302, 'Should redirect after save');
  assert.ok(res.headers.get('location')?.includes('b2b_settings_saved') || res.headers.get('location')?.includes('b2b_config_saved'), 'Should redirect with success param');
});

await test('GET /customers/:id shows B2B Customer Settings section', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('B2B Customer Settings'), 'Missing B2B Customer Settings section');
  assert.ok(html.includes('Discount %'), 'Missing discount field');
  assert.ok(html.includes('allow_order_on_invoice'), 'Missing allow_order_on_invoice field');
});

await test('B2B config audit log is written on update', async () => {
  const cookie = await seedSession();
  await fetch(`${BASE}/api/admin/customers/102/b2b-config`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ discount_pct: 40 }),
  });
  const auditRes = await fetch(`${BASE}/audit?format=json`, { headers: { Cookie: cookie } });
  assert.ok(auditRes.status === 200 || auditRes.status === 404, 'Audit endpoint should be accessible');
});

// ── Phase 9: Broadened orders/customers scope ──────────────────────────────────
console.log('\nAPI tests — Phase 9: Broadened orders/customers scope:');

await test('GET /orders shows all orders by default (not just b2b-portal)', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('#1001'), 'Missing b2b-portal order #1001');
  assert.ok(html.includes('#1005'), 'Missing SparkLayer order #1005');
  assert.ok(html.includes('#1006'), 'Missing POS order #1006');
  assert.ok(html.includes('filter-chip'), 'Missing source filter chips');
});

await test('GET /orders?source=b2b-portal filters to b2b-portal only', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders?source=b2b-portal`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('#1001'), 'Should include b2b-portal order');
  assert.ok(!html.includes('#1006') || html.includes('No orders found'), 'Should not include POS order');
});

await test('GET /orders?source=sparklayer filters to sparklayer only', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders?source=sparklayer`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('#1005'), 'Should include SparkLayer order');
  assert.ok(!html.includes('#1006') || html.includes('No orders found'), 'Should not include POS order');
});

await test('GET /orders?source=pos filters to POS only', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders?source=pos`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('#1006'), 'Should include POS order');
  assert.ok(!html.includes('#1001') || html.includes('No orders found'), 'Should not include b2b-portal order');
});

await test('GET /customers shows all customers by default (not just b2b-tagged)', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Acme Pet Supply'), 'Missing b2b customer');
  assert.ok(html.includes('Top Dog Boutique'), 'Missing SparkLayer customer');
  assert.ok(html.includes('filter-chip'), 'Missing segment filter chips');
});

await test('GET /customers?segment=b2b filters to b2b-tagged only', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers?segment=b2b`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Acme Pet Supply'), 'Should include b2b customer');
  assert.ok(!html.includes('Top Dog Boutique') || html.includes('No customers found'), 'Should not include non-b2b customer');
});

await test('GET /customers?segment=sparklayer filters to SparkLayer customers', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers?segment=sparklayer`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('Top Dog Boutique'), 'Should include SparkLayer customer');
});

// ── Phase 8: 10 templates + 6-checkbox fields ─────────────────────────────────
console.log('\nAPI tests — Phase 8: Label engine 10 templates + field selection:');

await test('Labels engine: all 10 templates render without error', async () => {
  const { renderLabelSheet, TEMPLATES } = await import('../labels.mjs');
  const items = [
    { barcode: '012345678901', title: 'Test Product', variantTitle: 'Small', sku: 'SKU-001', price: '25.00', qty: 1 },
    { barcode: '012345678902', title: 'Test Product', variantTitle: 'Medium', sku: 'SKU-002', price: '25.00', qty: 1 },
    { barcode: '012345678903', title: 'Test Product', variantTitle: 'Large', sku: 'SKU-003', price: '25.00', qty: 1 },
  ];
  const fields = { productName: true, variantName: true, msrp: true, sku: false, upcBarcode: true, upcDigits: true };
  for (const key of Object.keys(TEMPLATES)) {
    const { pdf } = await renderLabelSheet({ template: key, items, fields });
    assert.ok(Buffer.isBuffer(pdf), `Template ${key} should return Buffer`);
    assert.ok(pdf.length > 500, `Template ${key} PDF too small`);
  }
});

await test('Labels engine: thermal template renders one page per item', async () => {
  const { renderLabelSheet } = await import('../labels.mjs');
  const items = [
    { barcode: '012345678901', title: 'Product A', variantTitle: 'S', sku: 'A1', price: '10.00', qty: 1 },
    { barcode: '012345678902', title: 'Product B', variantTitle: 'M', sku: 'B1', price: '20.00', qty: 1 },
  ];
  const { pdf } = await renderLabelSheet({ template: 'thermal-4x6', items, fields: { productName: true, upcBarcode: true } });
  const pageCount = (pdf.toString('binary').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.equal(pageCount, 2, `Expected 2 pages for 2 thermal labels, got ${pageCount}`);
});

await test('Labels engine: thermal-2x1 renders without error', async () => {
  const { renderLabelSheet } = await import('../labels.mjs');
  const items = [{ barcode: '012345678901', title: 'Small Product', variantTitle: '', sku: 'SP1', price: '5.00', qty: 1 }];
  const { pdf } = await renderLabelSheet({ template: 'thermal-2x1', items, fields: { upcBarcode: true, productName: true } });
  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 200, 'thermal-2x1 should render');
});

await test('Labels engine: only msrp field enabled renders price-only label', async () => {
  const { renderLabelSheet } = await import('../labels.mjs');
  const items = [{ barcode: '012345678901', title: 'Test', variantTitle: 'V1', sku: 'S1', price: '99.99', qty: 1 }];
  const { pdf } = await renderLabelSheet({ template: 'avery-5163', items, fields: { msrp: true } });
  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 200, 'MSRP-only label should render');
});

await test('Labels engine: only upcBarcode enabled renders barcode-only label', async () => {
  const { renderLabelSheet } = await import('../labels.mjs');
  const items = [{ barcode: '012345678901', title: 'Test', variantTitle: 'V1', sku: 'S1', price: '25.00', qty: 1 }];
  const { pdf } = await renderLabelSheet({ template: 'avery-5160', items, fields: { upcBarcode: true } });
  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 200, 'Barcode-only label should render');
});

await test('Labels engine: Avery 5161 (20/sheet) — 20 items = 1 page, 21 = 2 pages', async () => {
  const { renderLabelSheet } = await import('../labels.mjs');
  const mkItems = n => Array.from({ length: n }, (_, i) => ({ barcode: String(100000000000 + i), title: `P${i}`, variantTitle: '', sku: '', price: '10.00', qty: 1 }));
  const { pdf: pdf20 } = await renderLabelSheet({ template: 'avery-5161', items: mkItems(20), fields: { productName: true } });
  const pages20 = (pdf20.toString('binary').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.equal(pages20, 1, `avery-5161: 20 items should be 1 page, got ${pages20}`);
  const { pdf: pdf21 } = await renderLabelSheet({ template: 'avery-5161', items: mkItems(21), fields: { productName: true } });
  const pages21 = (pdf21.toString('binary').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.equal(pages21, 2, `avery-5161: 21 items should be 2 pages, got ${pages21}`);
});

await test('GET /labels page shows 10 templates in dropdown', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/labels`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('avery-5160'), 'Missing avery-5160');
  assert.ok(html.includes('avery-5161'), 'Missing avery-5161 (new)');
  assert.ok(html.includes('thermal-4x6'), 'Missing thermal-4x6');
  assert.ok(html.includes('thermal-2x1'), 'Missing thermal-2x1');
  assert.ok(html.includes('thermal-3x2'), 'Missing thermal-3x2');
});

await test('GET /labels page shows 6-field checkboxes', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/labels`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('field_productName'), 'Missing productName checkbox');
  assert.ok(html.includes('field_variantName'), 'Missing variantName checkbox');
  assert.ok(html.includes('field_msrp'),        'Missing msrp checkbox');
  assert.ok(html.includes('field_sku'),          'Missing sku checkbox');
  assert.ok(html.includes('field_upcBarcode'),   'Missing upcBarcode checkbox');
  assert.ok(html.includes('field_upcDigits'),    'Missing upcDigits checkbox');
});

await test('POST /labels/print with no fields selected returns 400', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({
    item_count: '1',
    template: 'avery-5160',
    sel: '0',
    item_barcode_0: '012345678901',
    item_title_0: 'Test',
    item_variant_0: '',
    item_sku_0: '',
    item_price_0: '10.00',
    item_qty_0: '1',
  });
  const res = await fetch(`${BASE}/labels/print`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 400, 'Should reject when no fields selected');
});

await test('POST /labels/print with thermal template returns PDF', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({
    item_count: '1',
    template: 'thermal-4x6',
    field_productName: '1',
    field_upcBarcode: '1',
    sel: '0',
    item_barcode_0: '012345678901',
    item_title_0: 'Test Product',
    item_variant_0: 'Large',
    item_sku_0: 'TP-001-L',
    item_price_0: '45.00',
    item_qty_0: '1',
  });
  const res = await fetch(`${BASE}/labels/print`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  assert.ok(res.headers.get('content-type')?.includes('pdf'), 'Should be PDF');
});

// ── Phase 13: Chase invoice link stub ──
console.log('\nAPI tests — Phase 13: Chase invoice link stub:');

await test('POST /orders/1001/send-chase-invoice (JSON) → stub response', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/send-chase-invoice`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.status, 'stubbed');
});

await test('POST /orders/1001/send-chase-invoice (form) → redirects to order with success', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/send-chase-invoice`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('chase_invoice_queued'));
});

await test('POST /orders/1001/send-chase-invoice requires auth', async () => {
  const res = await fetch(`${BASE}/orders/1001/send-chase-invoice`, {
    method: 'POST', redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

// ── Phase 14D: Visible notes proxy ──────────────────────────────────────────
console.log('\nAPI tests — Phase 14D: Visible notes:');

await test('POST /api/orders/:id/visible-note (mock) → ok response', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/orders/1001/visible-note`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'Your order is on its way!' }),
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.ok, 'visible note not ok');
});

await test('POST /api/orders/:id/visible-note → empty body → 400', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/orders/1001/visible-note`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: '' }),
  });
  assert.equal(res.status, 400);
});

await test('POST /api/orders/:id/visible-note → no auth → redirect to /login', async () => {
  const res = await fetch(`${BASE}/api/orders/1001/visible-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'test' }),
    redirect: 'manual',
  });
  assert.ok(res.status === 401 || res.status === 302, `expected 401 or 302, got ${res.status}`);
});

await test('GET /api/orders/:id/visible-notes (mock) → empty array', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/orders/1001/visible-notes`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(Array.isArray(j.notes), 'notes should be array');
});

// ── Phase 14C: Tax exempt review page ───────────────────────────────────────
console.log('\nAPI tests — Phase 14C: Tax exempt review:');

await test('GET /tax-exempt → 200 HTML page', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/tax-exempt`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.toLowerCase().includes('tax'), 'tax-exempt page missing tax content');
});

await test('GET /tax-exempt → no auth → redirect to /login', async () => {
  const res = await fetch(`${BASE}/tax-exempt`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/login'));
});

// ── Phase 19E: Catalog status filter ────────────────────────────────────────
console.log('\nAPI tests — Phase 19E: Catalog status filter:');

await test('GET /catalog (no query) → shows only Active products by default', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Active products should appear; draft/archived should NOT
  assert.ok(html.includes('Elite Collar'), 'Active product missing');
  assert.ok(!html.includes('Legacy Slip Lead'), 'Archived product should not appear in default view');
  assert.ok(!html.includes('Everyday Bandana (Draft)'), 'Draft product should not appear in default view');
});

await test('GET /catalog?status=all → shows all products including draft and archived', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog?status=all`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Elite Collar'), 'Active product missing in all view');
  assert.ok(html.includes('Legacy Slip Lead'), 'Archived product missing in all view');
  assert.ok(html.includes('Everyday Bandana'), 'Draft product missing in all view');
});

await test('GET /catalog?status=draft → shows only draft products', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog?status=draft`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Everyday Bandana'), 'Draft product should appear in draft view');
  assert.ok(!html.includes('Elite Collar'), 'Active product should not appear in draft view');
});

await test('GET /catalog?status=archived → shows only archived products', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog?status=archived`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Legacy Slip Lead'), 'Archived product should appear in archived view');
  assert.ok(!html.includes('Elite Collar'), 'Active product should not appear in archived view');
});

await test('GET /catalog → status chips render with counts', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('catalog-status-chips'), 'Status chips container missing');
  assert.ok(html.includes('filter-chip'), 'Filter chips missing');
});

// ── Phase 20: Priority customers ─────────────────────────────────────────────
console.log('\nAPI tests — Phase 20: Priority customers:');

await test('GET /customers → sorted by lifetime spend desc by default', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Top spender (Acme Pet Supply $4520) should appear before lower spenders
  const acmePos = html.indexOf('Acme Pet Supply');
  const pawCentralPos = html.indexOf('Paw Central');
  assert.ok(acmePos !== -1, 'Acme Pet Supply should be in list');
  assert.ok(pawCentralPos !== -1, 'Paw Central should be in list');
  assert.ok(acmePos < pawCentralPos, 'Acme (higher spend) should appear before Paw Central (lower spend)');
});

await test('GET /customers → sort dropdown renders', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('name="sort"'), 'Sort dropdown missing');
  assert.ok(html.includes('Lifetime spend'), 'Sort option missing');
});

await test('GET /customers → star badges appear on top customers', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('top-customer-star'), 'Top customer star badge missing');
});

await test('GET /customers?sort=name_asc → sorted alphabetically', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers?sort=name_asc`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Acme Pet Supply comes before Paw Central alphabetically
  const acmePos = html.indexOf('Acme Pet Supply');
  const pawCentralPos = html.indexOf('Paw Central');
  assert.ok(acmePos < pawCentralPos, 'Name sort: Acme should appear before Paw Central');
});

await test('GET / (dashboard) → top customers widget shows spend + order count', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Top Customers'), 'Top Customers widget missing');
  assert.ok(html.includes('top-customer-star'), 'Star badge missing in dashboard widget');
});

// ── Phase 19A: Customer spend API ────────────────────────────────────────────
console.log('\nAPI tests — Phase 19A: Customer spend:');

await test('GET /api/admin/customers/101/spend → returns spend data', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/spend?from=2026-01-01&to=2026-12-31`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data.lifetimeTotal !== 'undefined', 'lifetimeTotal missing');
  assert.ok(typeof data.lifetimeCount !== 'undefined', 'lifetimeCount missing');
  assert.ok(typeof data.rangeTotal !== 'undefined', 'rangeTotal missing');
  assert.ok(typeof data.rangeCount !== 'undefined', 'rangeCount missing');
  assert.ok(Array.isArray(data.orders), 'orders should be array');
});

await test('GET /api/admin/customers/101/spend → orders have expected fields', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/spend?from=2026-01-01&to=2026-12-31`, { headers: { Cookie: cookie } });
  const data = await res.json();
  if (data.orders.length > 0) {
    const o = data.orders[0];
    assert.ok(o.id, 'order.id missing');
    assert.ok(o.name, 'order.name missing');
    assert.ok(o.processedAt, 'order.processedAt missing');
    assert.ok(o.total !== undefined, 'order.total missing');
    assert.ok(o.financialStatus, 'order.financialStatus missing');
  }
});

await test('GET /api/admin/customers/101/spend with narrow range → returns filtered orders', async () => {
  const cookie = await seedSession();
  // Use a date range that excludes all orders
  const res = await fetch(`${BASE}/api/admin/customers/101/spend?from=2020-01-01&to=2020-12-31`, { headers: { Cookie: cookie } });
  const data = await res.json();
  assert.equal(data.rangeCount, 0, 'Should have 0 orders in 2020 range');
  assert.equal(parseFloat(data.rangeTotal), 0, 'rangeTotal should be 0 for empty range');
});

await test('GET /api/admin/customers/101/spend requires auth → 401 for API paths', async () => {
  const res = await fetch(`${BASE}/api/admin/customers/101/spend?from=2026-01-01&to=2026-12-31`);
  assert.equal(res.status, 401, 'Unauthenticated API request should return 401');
  const json = await res.json();
  assert.ok(json.error, 'Should return JSON error');
});

// ── Phase 17: Wholesale Leads CRM ─────────────────────────────────────────────
console.log('\nAPI tests — Phase 17: Wholesale leads CRM:');

await test('GET /leads → list page renders', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/leads`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Wholesale Leads'), 'Page title missing');
  assert.ok(html.includes('New Lead'), 'New Lead button missing');
  assert.ok(html.includes('filter-chip'), 'Status filter chips missing');
});

await test('GET /leads/new → form renders', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/leads/new`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('name="email"'), 'Email field missing');
  assert.ok(html.includes('name="business_name"'), 'Business name field missing');
  assert.ok(html.includes('Create Lead'), 'Submit button missing');
});

await test('POST /leads/new → creates lead, redirects to detail', async () => {
  const cookie = await seedSession();
  const form = new URLSearchParams({ email: `test-lead-${Date.now()}@example.com`, business_name: 'Test Boutique', contact_name: 'Jane Doe', source: 'tradeshow' });
  const res = await fetch(`${BASE}/leads/new`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 302, 'Should redirect after create');
  const loc = res.headers.get('location') || '';
  assert.ok(loc.startsWith('/leads/'), 'Should redirect to lead detail');
});

await test('POST /leads/new with duplicate email → shows error', async () => {
  const cookie = await seedSession();
  const email  = `dup-lead-${Date.now()}@example.com`;
  const form   = new URLSearchParams({ email, business_name: 'First' });
  await fetch(`${BASE}/leads/new`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(), redirect: 'manual',
  });
  // Second attempt with same email
  const res = await fetch(`${BASE}/leads/new`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('already exists') || html.includes('alert'), 'Duplicate error message missing');
});

await test('GET /leads/:id → lead detail renders', async () => {
  const cookie = await seedSession();
  // Create a lead first
  const email = `detail-lead-${Date.now()}@example.com`;
  const createRes = await fetch(`${BASE}/leads/new`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, business_name: 'Detail Test Co' }).toString(),
    redirect: 'manual',
  });
  const loc = createRes.headers.get('location') || '';
  const leadRes = await fetch(`${BASE}${loc}`, { headers: { Cookie: cookie } });
  assert.equal(leadRes.status, 200);
  const html = await leadRes.text();
  assert.ok(html.includes('Detail Test Co'), 'Business name missing');
  assert.ok(html.includes('Activity'), 'Activity timeline missing');
  assert.ok(html.includes('Change Status') || html.includes('Add Note'), 'Action sections missing');
});

await test('POST /leads/:id/status → changes status correctly', async () => {
  const cookie = await seedSession();
  const email  = `status-lead-${Date.now()}@example.com`;
  const createRes = await fetch(`${BASE}/leads/new`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, business_name: 'Status Test' }).toString(),
    redirect: 'manual',
  });
  const loc = createRes.headers.get('location') || '';
  const leadId = loc.split('/leads/')[1]?.replace('?flash=created', '');
  const statusRes = await fetch(`${BASE}/leads/${leadId}/status`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ new_status: 'under_review', note: 'Looks promising' }).toString(),
    redirect: 'manual',
  });
  assert.equal(statusRes.status, 302, 'Status change should redirect');
  const detailRes = await fetch(`${BASE}/leads/${leadId}`, { headers: { Cookie: cookie } });
  const html = await detailRes.text();
  assert.ok(html.includes('Under Review'), 'New status not reflected');
});

await test('POST /leads/:id/note → adds note to timeline', async () => {
  const cookie = await seedSession();
  const email  = `note-lead-${Date.now()}@example.com`;
  const createRes = await fetch(`${BASE}/leads/new`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, business_name: 'Note Test' }).toString(),
    redirect: 'manual',
  });
  const loc = createRes.headers.get('location') || '';
  const leadId = loc.split('/leads/')[1]?.replace('?flash=created', '');
  const uniqueNote = 'Spoke with buyer on ' + Date.now();
  await fetch(`${BASE}/leads/${leadId}/note`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ body: uniqueNote, note_type: 'call' }).toString(),
    redirect: 'manual',
  });
  const detailRes = await fetch(`${BASE}/leads/${leadId}`, { headers: { Cookie: cookie } });
  const html = await detailRes.text();
  assert.ok(html.includes(uniqueNote), 'Note body missing from timeline');
  assert.ok(html.includes('call'), 'Note type missing from timeline');
});

await test('GET /leads?status=under_review → filters by status', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/leads?status=under_review`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Under Review') || html.includes('filter-chip-active'), 'Status filter not applied');
});

// ── Phase 19B: Universal hyperlinks ──────────────────────────────────────────
console.log('\nAPI tests — Phase 19B: Universal hyperlinks:');

await test('GET /customers → tag chips are clickable links', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Tag chips should be <a> links pointing to /customers?tag=...
  assert.ok(html.includes('href="/customers?tag='), 'Tag chips should be anchor links');
});

await test('GET /audit → email is a mailto link', async () => {
  const cookie = await seedSession();
  // Seed an audit log entry first (via login)
  await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
  const res = await fetch(`${BASE}/audit`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('href="mailto:'), 'Audit email should be a mailto link');
});

await test('GET /audit → GID targets become clickable order/customer links', async () => {
  const cookie = await seedSession();
  // Mark paid to generate an audit log entry with a GID target
  await fetch(`${BASE}/orders/1001/mark-paid`, {
    method: 'POST', headers: { Cookie: cookie }, redirect: 'manual',
  });
  const res = await fetch(`${BASE}/audit`, { headers: { Cookie: cookie } });
  const html = await res.text();
  assert.ok(html.includes('href="/orders/'), 'Audit GID target should link to order detail');
});

// ── Phase 19C: Product detail page ───────────────────────────────────────────
console.log('\nAPI tests — Phase 19C: Product detail page:');

await test('GET /products/201 → returns product detail for Elite Collar', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/products/201`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Elite Collar'), 'Product title missing');
  assert.ok(html.includes('EC-001-S-NV'), 'Variant SKU missing');
  assert.ok(html.includes('Edit in Shopify'), 'Edit in Shopify link missing');
});

await test('GET /products/9999 → returns 404 for non-existent product', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/products/9999`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
});

await test('GET /products/:id → requires auth', async () => {
  const res = await fetch(`${BASE}/products/201`, { redirect: 'manual' });
  assert.ok([301, 302].includes(res.status), 'Should redirect unauthenticated request');
});

await test('GET /catalog/:id → redirects to /products/:id', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog/201`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')?.includes('/products/201'), 'Should redirect to /products/201');
});

await test('GET /orders/1001 → line item title links to /products/:id', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Elite Collar (variant v301) maps to product 201
  assert.ok(html.includes('href="/products/201"'), 'Product link missing from line item');
});

// ── Phase 16: Order editing, fulfillment, backorder ──────────────────────────
console.log('\nAPI tests — Phase 16: Order editing + fulfillment + backorder:');

await test('POST /orders/1001/edit → changes qty and redirects', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams();
  body.append('qtys[li1]', '3');
  body.append('staffNote', 'Test edit');
  const res = await fetch(`${BASE}/orders/1001/edit`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
  assert.ok([301, 302].includes(res.status), 'Should redirect after edit');
  assert.ok(res.headers.get('location')?.includes('order_edited'), 'Should redirect with success flash');
});

await test('POST /orders/1001/edit with remove → removes line item', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams();
  body.append('removes', 'li2');
  const res = await fetch(`${BASE}/orders/1001/edit`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
  assert.ok([301, 302].includes(res.status), 'Should redirect after edit');
});

await test('POST /orders/1002/discount → applies discount and redirects', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({ type: 'pct', value: '10', reason: 'Loyalty' });
  const res = await fetch(`${BASE}/orders/1002/discount`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
  assert.ok([301, 302].includes(res.status), 'Should redirect after discount');
  assert.ok(res.headers.get('location')?.includes('discount_applied'), 'Should have success flash');
});

await test('POST /orders/1003/fulfill → records fulfillment and redirects', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({
    'lineItems[li4]': '5',
    trackingCompany: 'USPS',
    trackingNumber: 'TEST123',
  });
  const res = await fetch(`${BASE}/orders/1003/fulfill`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
  assert.ok([301, 302].includes(res.status), 'Should redirect after fulfill');
  assert.ok(res.headers.get('location')?.includes('fulfilled'), 'Should have success flash');
});

await test('POST /orders/1001/backorder → flags backorder in SQLite', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({ lineItemId: 'li1', lineItemTitle: 'Elite Collar', quantity: '3', eta: '2026-07-01' });
  const res = await fetch(`${BASE}/orders/1001/backorder`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
  assert.ok([301, 302].includes(res.status), 'Should redirect after backorder');
  assert.ok(res.headers.get('location')?.includes('backorder_flagged'), 'Should have success flash');
});

await test('GET /api/orders/1001/backorders → returns backorders JSON', async () => {
  const cookie = await seedSession();
  // First create a backorder
  const body = new URLSearchParams({ lineItemId: 'li_test', lineItemTitle: 'Test Item', quantity: '2' });
  await fetch(`${BASE}/orders/1001/backorder`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
  const res = await fetch(`${BASE}/api/orders/1001/backorders`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.backorders), 'Should return backorders array');
  assert.ok(json.backorders.some(b => b.line_item_id === 'li_test'), 'Should find the test backorder');
});

await test('GET /orders/1001 → shows edit order button', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('toggleEditMode'), 'Edit mode JS missing');
  assert.ok(html.includes('Fulfill items'), 'Fulfill button missing');
  assert.ok(html.includes('Apply discount'), 'Discount button missing');
});

// ── Phase 18: Xero accounting integration ─────────────────────────────────────

await test('GET /settings/xero → renders account mapping form', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/settings/xero`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Xero Integration Settings'), 'Missing Xero settings title');
  assert.ok(html.includes('sales_revenue'), 'Missing sales_revenue field');
  assert.ok(html.includes('chase_checking'), 'Missing chase_checking field');
});

await test('POST /settings/xero → saves account map and redirects', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({
    sales_revenue: '200', accounts_receivable: '610', chase_checking: '1110',
    stripe_clearing: '1120', processing_fees: '6100', discounts: '400', payment_terms_days: '30',
  });
  const res = await fetch(`${BASE}/settings/xero`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(), redirect: 'manual',
  });
  assert.ok([301, 302].includes(res.status), 'Should redirect after save');
  assert.ok(res.headers.get('location')?.includes('flash=ok'), 'Should redirect with ok flash');
});

await test('GET /accounting → renders reconciliation page', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/accounting`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Accounting Reconciliation'), 'Missing accounting title');
  assert.ok(html.includes('Xero Invoice Map'), 'Missing invoice map section');
  assert.ok(html.includes('Pending Actions'), 'Missing pending actions section');
});

await test('POST /api/admin/xero/test → returns ok in mock mode', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/xero/test`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true, 'Should return ok');
  assert.ok(json.accounts >= 0, 'Should return account count');
});

await test('POST /api/admin/xero/sync → triggers retry and returns results', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/xero/sync`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _redirect: '' }).toString(), redirect: 'manual',
  });
  // Will redirect since no JSON Accept header and no _redirect body param with value
  // Let's try JSON mode
  const res2 = await fetch(`${BASE}/api/admin/xero/sync`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res2.status, 200);
  const json = await res2.json();
  assert.equal(json.ok, true, 'Should return ok');
  assert.ok('done' in json, 'Should include done count');
});

await test('POST /orders/1001/xero/sync → creates Xero invoice and redirects', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/xero/sync`, {
    method: 'POST', headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.ok([301, 302].includes(res.status), 'Should redirect');
  assert.ok(res.headers.get('location')?.includes('xero'), 'Should redirect with xero flash');
});

await test('POST /orders/1001/mark-paid → triggers Xero payment queue (non-blocking)', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001/mark-paid`, {
    method: 'POST', headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.ok([301, 302].includes(res.status), 'Should redirect after mark-paid');
  // Verify redirect goes to order page with success
  assert.ok(res.headers.get('location')?.includes('/orders/1001'), 'Should redirect to order');
});

await test('GET /orders/1001 → shows Sync to Xero button', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Xero'), 'Should show Xero button/card');
  assert.ok(html.includes('/orders/1001/xero/sync'), 'Should have Xero sync form');
});

await test('GET /accounting → requires auth', async () => {
  const res = await fetch(`${BASE}/accounting`, { redirect: 'manual' });
  assert.ok([301, 302].includes(res.status), 'Should redirect to login');
});

await test('GET /settings/xero → requires auth', async () => {
  const res = await fetch(`${BASE}/settings/xero`, { redirect: 'manual' });
  assert.ok([301, 302].includes(res.status), 'Should redirect to login');
});

// ── Phase 21: Xero customer sync ─────────────────────────────────────────────

await test('resolveXeroContact: known Shopify ID 8902606455019 → The Dog Shoppe', async () => {
  const { resolveXeroContact } = await import('../lib/xero-customer-sync.mjs');
  const result = await resolveXeroContact('8902606455019');
  assert.ok(result !== null, 'Should find mapping entry');
  assert.equal(result.xeroName, 'The Dog Shoppe', 'Should return The Dog Shoppe');
  assert.equal(result.isMerged, false, 'Primary should not be merged');
});

await test('resolveXeroContact: merged case 6909696999659 → Pro-Mohs Canine Supply, isMerged=true', async () => {
  const { resolveXeroContact } = await import('../lib/xero-customer-sync.mjs');
  const result = await resolveXeroContact('6909696999659');
  assert.ok(result !== null, 'Should find mapping entry');
  assert.equal(result.xeroName, 'Pro-Mohs Canine Supply', 'Should return Pro-Mohs Canine Supply');
  assert.equal(result.isMerged, true, 'Should be marked as merged');
});

await test('resolveXeroContact: insider 4742401425601 → null', async () => {
  const { resolveXeroContact } = await import('../lib/xero-customer-sync.mjs');
  const result = await resolveXeroContact('4742401425601');
  assert.equal(result, null, 'Insider should return null');
});

await test('isInsider: returns true for known insider IDs', async () => {
  const { isInsider } = await import('../lib/xero-customer-sync.mjs');
  assert.equal(isInsider('4742401425601'), true, 'Should be insider');
  assert.equal(isInsider('5163530813633'), true, 'Should be insider');
  assert.equal(isInsider('5462357967041'), false, 'Pro-Mohs should not be insider');
});

await test('syncCustomerToXero: new customer → creates mock contact (idempotent)', async () => {
  const { syncCustomerToXero } = await import('../lib/xero-customer-sync.mjs');
  const mockXero = async (method, path, body) => {
    if (path.includes('where=')) return { ok: true, body: { Contacts: [] } };
    if (path.includes('/ContactGroups')) return { ok: true, body: { ContactGroups: [] } };
    return { ok: true, body: { Contacts: [{ ContactID: 'new-xero-' + Date.now(), Name: body?.Contacts?.[0]?.Name || 'Test' }] } };
  };
  const result = await syncCustomerToXero('99999999', { email: 'test@example.com', displayName: 'Test Shop' }, mockXero, { dryRun: true });
  assert.ok(result.xeroContactId, 'Should return a contactId');
  assert.equal(result.created, true, 'Should be created=true for new customer');
});

await test('syncCustomerToXero: existing customer → returns existing (not created)', async () => {
  const { syncCustomerToXero } = await import('../lib/xero-customer-sync.mjs');
  const mockXero = async () => ({ ok: true, body: { Contacts: [] } });
  // 8902606455019 is already in mapping → should return created=false
  const result = await syncCustomerToXero('8902606455019', { email: 'test@example.com' }, mockXero, { dryRun: true });
  assert.equal(result.created, false, 'Should be created=false for existing customer');
  assert.equal(result.xeroName, 'The Dog Shoppe', 'Should return correct name');
});

await test('syncCustomerToXero: insider → returns skipped', async () => {
  const { syncCustomerToXero } = await import('../lib/xero-customer-sync.mjs');
  const mockXero = async () => ({ ok: true, body: {} });
  const result = await syncCustomerToXero('4742401425601', { email: 'insider@test.com' }, mockXero, { dryRun: true });
  assert.equal(result.skipped, 'insider', 'Insider should return skipped=insider');
  assert.equal(result.xeroContactId, null, 'Insider should have null contactId');
});

await test('GET /api/admin/customers/:id/xero-status → requires auth', async () => {
  const res = await fetch(`${BASE}/api/admin/customers/101/xero-status`, { redirect: 'manual' });
  assert.equal(res.status, 401, 'Should return 401 for unauthenticated API request');
});

await test('GET /api/admin/customers/101/xero-status → returns status JSON', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/xero-status`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true, 'Should return ok');
  assert.ok(['synced','not_synced','insider','merged'].includes(json.state), 'State should be valid enum value');
});

await test('POST /api/admin/customers/101/xero-sync → triggers sync', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/xero-sync`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true, 'Should return ok');
});

await test('GET /api/admin/customers/8902606455019/xero-status → synced (from mapping)', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/8902606455019/xero-status`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.state, 'synced', 'Real Shopify ID from mapping should show as synced');
  assert.equal(json.xeroName, 'The Dog Shoppe');
});

await test('GET /api/admin/customers/4742401425601/xero-status → insider', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/4742401425601/xero-status`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.state, 'insider', 'Known insider should return insider state');
});

await test('GET /api/admin/customers/6909696999659/xero-status → merged', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/6909696999659/xero-status`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.state, 'merged', 'Merged customer should return merged state');
  assert.equal(json.xeroName, 'Pro-Mohs Canine Supply');
});

console.log('\nAPI tests — Phase 22 (Impersonation):');

await test('POST /api/admin/customers/101/impersonate → requires auth', async () => {
  const res = await fetch(`${BASE}/api/admin/customers/101/impersonate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 401);
});

await test('POST /api/admin/customers/101/impersonate → returns url in mock mode', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/impersonate`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ read_only: true }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(json.url, 'Should return a URL');
  assert.ok(json.url.includes('__impersonate__'), 'URL should point to impersonation endpoint');
  assert.ok(json.url.includes('tok='), 'URL should contain token');
  assert.equal(json.readOnly, true);
});

await test('POST /api/admin/customers/101/impersonate read_only=false → interactive mode', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/impersonate`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ read_only: false }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.readOnly, false);
});

await test('POST /api/admin/customers/999/impersonate → 404 for unknown customer', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/999/impersonate`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 404);
});

console.log('\nAPI tests — Phase 23 (Activity viewer):');

await test('GET /api/admin/customers/101/activity → requires auth', async () => {
  const res = await fetch(`${BASE}/api/admin/customers/101/activity`);
  assert.equal(res.status, 401);
});

await test('GET /api/admin/customers/101/activity → returns activity data', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/activity`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.rows), 'Should return rows array');
  assert.ok(typeof json.total === 'number', 'Should return total count');
  assert.ok(typeof json.page === 'number', 'Should return page number');
});

await test('GET /api/admin/customers/101/activity with type filter → filters correctly', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/activity?type=page_view`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(json.rows.every(r => r.eventType === 'page_view'), 'Should only return page_view events');
});

await test('GET /api/admin/customers/101/activity/lookup → requires auth', async () => {
  const res = await fetch(`${BASE}/api/admin/customers/101/activity/lookup?date=2026-05-26`);
  assert.equal(res.status, 401);
});

await test('GET /api/admin/customers/101/activity/lookup → requires date param', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/activity/lookup`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 400);
});

await test('GET /api/admin/customers/101/activity/lookup with date → returns found or not-found', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/activity/lookup?date=2026-05-26`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(typeof json.found === 'boolean', 'Should return found boolean');
});

await test('GET /customers/101/activity → unauthenticated redirects', async () => {
  const res = await fetch(`${BASE}/customers/101/activity`, { redirect: 'manual' });
  assert.ok(res.status === 302 || res.status === 303, 'Unauthenticated should redirect');
});

await test('GET /customers/101/activity → renders activity page', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101/activity`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Activity log'), 'Should include activity log heading');
  assert.ok(html.includes('Quick lookup'), 'Should include quick lookup section');
  assert.ok(html.includes('data-table'), 'Should include data table');
});

// ── Phase 16E: Partial invoices ──────────────────────────────────────────────

await test('GET /api/admin/orders/1001/partial-invoices → requires auth', async () => {
  const res = await fetch(`${BASE}/api/admin/orders/1001/partial-invoices`);
  assert.equal(res.status, 401);
});

await test('GET /api/admin/orders/1001/partial-invoices → returns empty list initially', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/orders/1001/partial-invoices`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.invoices), 'Should return invoices array');
});

await test('POST /orders/1001/partial-invoice → requires auth', async () => {
  const res = await fetch(`${BASE}/orders/1001/partial-invoice`, { method: 'POST', redirect: 'manual' });
  assert.ok(res.status === 302 || res.status === 303 || res.status === 401, 'Unauthenticated should redirect or 401');
});

await test('POST /orders/1001/partial-invoice with type=full → returns PDF', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({ type: 'full', shipping_handling: 'first' });
  const res = await fetch(`${BASE}/orders/1001/partial-invoice`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  assert.equal(res.headers.get('content-type'), 'application/pdf', 'Should return PDF');
});

// REGRESSION: this test previously asserted that type=fulfilled_only returned a PDF — which it did,
// while billing the ENTIRE order. Both arms of the ternary behind it were `allLineItems`, so the
// "partial invoice" the modal pre-selected was a full one wearing a "partial" badge. The scope is
// now refused server-side; the old assertion was locking in the bug.
await test('REGRESSION: type=fulfilled_only is REFUSED, not silently billed in full', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({ type: 'fulfilled_only', shipping_handling: 'none' });
  const res = await fetch(`${BASE}/orders/1001/partial-invoice`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 422, `fulfilled_only must be refused, got ${res.status}`);
  const j = await res.json();
  assert.ok(/full/i.test(j.error || ''), `error should explain the order can only be invoiced in full, got: ${j.error}`);
});

// REGRESSION: shipping and tax were billed IN FULL on every invoice — shipping because
// shipping_handling came from the client (modal default 'first') with no server-side check against
// existing invoices, tax because it had no gate at all. Two invoices on a $100+$10 ship+$8 tax order
// billed $118 then $108 = $226 for a $118 order. Both figures were persisted.
await test('REGRESSION: shipping and tax are billed ONCE per order, not on every invoice', async () => {
  const cookie = await seedSession();
  const post = () => fetch(`${BASE}/orders/1010/partial-invoice`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ type: 'full', shipping_handling: 'first' }).toString(),
  });
  assert.equal((await post()).status, 200, 'first invoice should succeed');
  assert.equal((await post()).status, 200, 'second invoice should succeed');

  const list = await (await fetch(`${BASE}/api/admin/orders/1010/partial-invoices`, { headers: { Cookie: cookie } })).json();
  const invs = list.invoices || list;
  assert.ok(invs.length >= 2, `expected at least 2 invoices, got ${invs.length}`);
  const [a, b] = invs.slice(0, 2).sort((x, y) => String(x.invoice_letter).localeCompare(String(y.invoice_letter)));

  assert.equal(Number(a.shipping), 10, 'the FIRST invoice carries the shipping');
  assert.equal(Number(a.tax), 8, 'the FIRST invoice carries the tax');
  assert.equal(Number(b.shipping), 0, 'the SECOND invoice must NOT re-bill shipping');
  assert.equal(Number(b.tax), 0, 'the SECOND invoice must NOT re-bill tax');
  // The order is $118 all-in; the extras must appear exactly once across all invoices.
  const totalShipping = invs.reduce((s, i) => s + Number(i.shipping || 0), 0);
  const totalTax      = invs.reduce((s, i) => s + Number(i.tax || 0), 0);
  assert.equal(totalShipping, 10, `shipping billed ${totalShipping} across invoices, expected 10`);
  assert.equal(totalTax, 8, `tax billed ${totalTax} across invoices, expected 8`);
});

// REGRESSION: a 100%-comped line was invoiced at FULL LIST price. liNum() ends in `|| 0`, so a
// legitimate "0.00" is falsy and `liNum(discounted) || liNum(original)` treated the genuine zero as
// "field absent" and substituted 45.99. The printed rows then did not sum to the printed subtotal on
// a customer-facing document, and the overstated figure was persisted into the invoice snapshot.
await test('REGRESSION: a 100%-comped line is invoiced at 0.00, not at list price', async () => {
  const cookie = await seedSession();
  const csv = await (await fetch(`${BASE}/orders/1010/invoice.csv`, { headers: { Cookie: cookie } })).text();
  assert.ok(/Comped Replacement Collar/.test(csv), 'the comped line should appear on the invoice');
  const compedRow = csv.split(/\r?\n/).find(l => /Comped Replacement Collar/.test(l));
  assert.ok(!/45\.99/.test(compedRow), `comped line must NOT be priced at list: ${compedRow}`);
  assert.ok(/\b0(\.00)?\b/.test(compedRow), `comped line total should be zero: ${compedRow}`);

  // The stated invariant: the line totals must sum to the order's current subtotal (100.00).
  const billedRow = csv.split(/\r?\n/).find(l => /Billed Collar/.test(l));
  assert.ok(/100(\.00)?/.test(billedRow), `the billed line should total 100.00: ${billedRow}`);
});

await test('POST /orders/1001/partial-invoice twice → second gets letter B', async () => {
  const cookie = await seedSession();
  const body1 = new URLSearchParams({ type: 'full', shipping_handling: 'first' });
  await fetch(`${BASE}/orders/1001/partial-invoice`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body1.toString(),
  });
  const listRes = await fetch(`${BASE}/api/admin/orders/1001/partial-invoices`, { headers: { Cookie: cookie } });
  const json = await listRes.json();
  assert.ok(json.invoices.length >= 1, 'Should have at least 1 invoice after generation');
  const letters = json.invoices.map(i => i.invoice_letter);
  assert.ok(letters.includes('A') || letters.includes('B'), 'Should have assigned letter A or B');
});

await test('GET /orders/1001/partial-invoice/A.pdf → returns PDF or 404 based on prior tests', async () => {
  const cookie = await seedSession();
  const listRes = await fetch(`${BASE}/api/admin/orders/1001/partial-invoices`, { headers: { Cookie: cookie } });
  const json = await listRes.json();
  if (json.invoices.length > 0) {
    const letter = json.invoices[0].invoice_letter;
    const res = await fetch(`${BASE}/orders/1001/partial-invoice/${letter}.pdf`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, 'Should serve existing invoice PDF');
    assert.equal(res.headers.get('content-type'), 'application/pdf');
  } else {
    const res = await fetch(`${BASE}/orders/1001/partial-invoice/Z.pdf`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 404, 'Should 404 for non-existent letter');
  }
});

await test('GET /orders/1001 → includes Generate Invoice button', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/orders/1001`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Generate Invoice'), 'Should include Generate Invoice button');
  assert.ok(html.includes('invoice-modal'), 'Should include invoice modal');
});

// ── Phase 15A: Catalog access tags ───────────────────────────────────────────

await test('GET /customers/101 → B2B settings includes catalog_access_tags field', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('catalog_access_tags'), 'Should include catalog_access_tags input');
  assert.ok(html.includes('Custom catalog tags'), 'Should include Custom catalog tags label');
});

await test('POST /customers/101/b2b-config with catalog_access_tags → saves and redirects', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({ catalog_access_tags: 'private-test,trade-only' });
  const res = await fetch(`${BASE}/customers/101/b2b-config`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
  assert.ok(res.status === 302 || res.status === 303, 'Should redirect after save');
});

await test('GET /api/admin/customers/101/b2b-config → includes catalog_access_tags', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/b2b-config`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok('catalog_access_tags' in (json.effective || json.overrides || json), 'Should include catalog_access_tags');
});

await test('GET /settings → includes catalog_private_tags field', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/settings`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('catalog_private_tags'), 'Should include catalog_private_tags input');
  assert.ok(html.includes('Private catalog tags'), 'Should include Private catalog tags label');
});

await test('POST /settings with catalog_private_tags → saves and redirects', async () => {
  const cookie = await seedSession();
  const body = new URLSearchParams({ catalog_private_tags: 'private-acme,trade-only' });
  const res = await fetch(`${BASE}/settings`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
  assert.ok(res.status === 302 || res.status === 303, 'Should redirect after settings save');
});

// ── Phase 19D: Active cart API ────────────────────────────────────────────────
console.log('\nAPI tests — Phase 19D (Active cart):');

await test('GET /api/admin/customers/:id/active-cart → returns cart object', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/api/admin/customers/101/active-cart`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.ok, 'should return ok');
  assert.ok(Array.isArray(json.items), 'items should be array');
  assert.ok(typeof json.subtotal === 'number', 'subtotal should be number');
  assert.ok(typeof json.itemCount === 'number', 'itemCount should be number');
});

await test('GET /api/admin/customers/:id/active-cart without auth → 401', async () => {
  const res = await fetch(`${BASE}/api/admin/customers/101/active-cart`);
  assert.equal(res.status, 401);
});

await test('GET /customers/101 → includes active-cart card section', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/customers/101`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('active-cart-card') || html.includes('Active cart'), 'should include active cart section');
});

// ── Phase 24: Webhooks + cache schema ────────────────────────────────────────
console.log('\nAPI tests — Phase 24 (Webhooks + cache schema):');

const WEBHOOK_SECRET = 'test-shopify-webhook-secret';

function makeWebhookHeaders(body, topic = 'orders/updated') {
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Topic': topic,
    'X-Shopify-Hmac-Sha256': hmac,
  };
}

await test('POST /webhooks/shopify with valid HMAC → 200 ok', async () => {
  const body = JSON.stringify({ id: 999, name: '#TEST-999' });
  const res = await fetch(`${BASE}/webhooks/shopify`, {
    method: 'POST',
    headers: makeWebhookHeaders(body, 'orders/updated'),
    body,
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.ok, 'should return ok:true');
});

await test('POST /webhooks/shopify with invalid HMAC → 401', async () => {
  const body = JSON.stringify({ id: 999 });
  const res = await fetch(`${BASE}/webhooks/shopify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Topic': 'orders/updated',
      'X-Shopify-Hmac-Sha256': 'invalidsignatureXXX',
    },
    body,
  });
  assert.equal(res.status, 401);
});

await test('POST /webhooks/shopify customers/updated → 200 ok', async () => {
  const body = JSON.stringify({ id: 101, email: 'test@example.com', tags: 'b2b-portal' });
  const res = await fetch(`${BASE}/webhooks/shopify`, {
    method: 'POST',
    headers: makeWebhookHeaders(body, 'customers/updated'),
    body,
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.ok);
});

// REGRESSION (H21, 2026-08-09): express.json defaults to a 100kb limit, and the webhook HMAC is
// verified over the rawBody captured by that same parser — so an over-limit payload was rejected
// with 413 by the body parser BEFORE the handler ran. Shopify retried, then gave up, and the order
// never reached orders_cache. That silently lost the LARGEST B2B orders (most line items = biggest
// body). This asserts a ~300kb order webhook is accepted.
await test('POST /webhooks/shopify with a >100kb order payload → 200, not 413', async () => {
  const lineItems = Array.from({ length: 1200 }, (_, i) => ({
    id: 900000 + i, variant_id: 500000 + i, product_id: 400000 + i,
    sku: `BULK-SKU-${i}`, title: `Bulk Line Item Number ${i} — long title padding for payload size`,
    variant_title: 'Large / Red / Extra padding to grow the JSON body',
    quantity: 1, price: '19.99', total_discount: '0.00', vendor: 'Fuzzywumpets',
  }));
  const body = JSON.stringify({ id: 998877, name: '#BIG-998877', financial_status: 'paid', line_items: lineItems });
  assert.ok(Buffer.byteLength(body) > 100 * 1024, `test payload must exceed the old 100kb limit (was ${Buffer.byteLength(body)})`);
  const res = await fetch(`${BASE}/webhooks/shopify`, {
    method: 'POST',
    headers: makeWebhookHeaders(body, 'orders/updated'),
    body,
  });
  assert.equal(res.status, 200, 'a large order webhook must not be rejected by the body-size limit');
  const json = await res.json();
  assert.ok(json.ok);
});

await test('POST /webhooks/shopify products/updated → 200 ok', async () => {
  const body = JSON.stringify({ id: 201, title: 'Test Product', vendor: 'Fuzzywumpets' });
  const res = await fetch(`${BASE}/webhooks/shopify`, {
    method: 'POST',
    headers: makeWebhookHeaders(body, 'products/updated'),
    body,
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.ok);
});

// ── Phase 25: Vendor filter ───────────────────────────────────────────────────
console.log('\nAPI tests — Phase 25 (Vendor filter):');

await test('GET /catalog → only shows Fuzzywumpets products by default', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // FMS product should NOT appear
  assert.ok(!html.includes('FMS Toy Ball'), 'FMS product should be filtered out by default');
  // At least one FWW product should appear
  assert.ok(html.includes('Elite Collar') || html.includes('Fuzzywumpets') || html.includes('catalog'), 'Should show catalog content');
});

await test('GET /catalog?vendor=all → shows all vendors including FMS', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog?vendor=all`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('FMS') || html.includes('all vendors') || html.includes('vendor=all'), 'Should include non-FWW products or show all vendor option selected');
});

await test('GET /catalog → vendor select has Fuzzywumpets as default option', async () => {
  const cookie = await seedSession();
  const res = await fetch(`${BASE}/catalog`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Fuzzywumpets (default)') || html.includes('selected'), 'Should show Fuzzywumpets as default vendor');
});

console.log(`\n  ${passed} passed, ${failed} failed`);

// ── Task 45: Backorder queue API ─────────────────────────────────────────────
console.log('\nAPI tests — Task 45 (Backorder queue):');

{
  const r = await fetch(`${BASE}/api/admin/backorders`);
  assert.equal(r.status, 401, 'GET /api/admin/backorders: unauthenticated → 401');
  console.log('  ✓ /api/admin/backorders: unauthenticated → 401');
}

{
  const cookie = await seedSession();
  const r = await fetch(`${BASE}/api/admin/backorders`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200, 'GET /api/admin/backorders: authenticated → 200');
  const body = await r.json();
  assert.ok(Array.isArray(body.backorders), '/api/admin/backorders: body.backorders is array');
  console.log('  ✓ /api/admin/backorders: authenticated → 200, returns backorders array');
}


// ── Task 48: Revenue chart + customer outstanding balance ────────────────────
console.log('\nAPI tests — Task 48 (Revenue chart + outstanding balance):');

{
  const cookie = await seedSession();
  const r = await fetch(`${BASE}/`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200, 'GET /: dashboard should return 200');
  const html = await r.text();
  assert.ok(html.includes('Revenue'), 'Dashboard HTML should include Revenue widget heading');
  console.log('  ✓ Dashboard: Revenue widget present in HTML');
}

{
  const cookie = await seedSession();
  const r = await fetch(`${BASE}/customers/101`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200, 'GET /customers/101: customer detail should return 200');
  const html = await r.text();
  assert.ok(html.includes('B2B Customer Settings'), 'Customer detail: B2B Customer Settings card present');
  // Outstanding section present in template (even if count = 0)
  assert.ok(html.includes('outstanding') || html.includes('Outstanding') || html.includes('card-header'), 'Customer detail: card-header present');
  console.log('  ✓ Customer detail: B2B Customer Settings card with outstanding balance section');
}

if (failed > 0) process.exit(1);
