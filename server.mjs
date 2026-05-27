/**
 * fww-b2b-admin — Fuzzywumpets internal ops dashboard.
 * Phase 1: Google OAuth + dashboard MVP.
 * Phase 2: Orders + Customers pages.
 * Phase 3: Catalog + Reports + Settings + Migrate.
 * Phase 4: Polish — keyboard shortcuts, CSV exports, PWA manifest.
 * Phase 5: UPC barcode label engine.
 * Phase 6: Product CSV + image ZIP exports.
 */
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ZipArchive } from 'archiver';
import {
  createSession, getSession, deleteSession, auditLog,
  getCustomerNotes, setCustomerNotes, getDropshipCache, setDropshipCache,
  getSetting, setSetting, getGlobalSettings, getAuditLog, getAuditLogCount,
  logLabelBatch, logExportBatch,
  createLead, getLeads, getLeadCounts, getLead, updateLead,
  addLeadNote, getLeadNotes, addLeadStatusHistory, getLeadStatusHistory,
  upsertBackorder, getBackordersForOrder, fulfillBackorder, logOrderEdit,
  getXeroMap, setXeroMap, addXeroPending, getXeroPending, markXeroPendingDone, markXeroPendingFailed, getXeroPendingCount, getXeroInvoiceMaps,
  createImpersonationNonce, consumeImpersonationNonce, gcImpersonationNonces,
  createPartialInvoice, getPartialInvoices, getNextInvoiceLetter,
  upsertCustomerCache, upsertOrderCache, upsertOrderLineItemsCache, upsertProductCache,
  getOrdersFromCache, getOrderFromCache, getOrderSpendFromCache, getCustomerFromCache,
  getCustomersCountInCache, getOrdersCountInCache, getProductsCountInCache,
  getSyncState, setSyncState, getAllInvoicesForList, getPartialInvoicesAll,
  listCustomersFromCache,
  getCustomerCacheStats,
  listOrdersFromCache, getOrdersCacheStats, getCustomerOrdersFromCache,
} from './db.mjs';
import { generateInvoicePdf } from './pdf.mjs';
import { renderLabelSheet, expandItems, TEMPLATES as LABEL_TEMPLATES, DEFAULT_FIELDS } from './labels.mjs';
import { isInsider, resolveXeroContact, syncCustomerToXero, getXeroSyncStatus } from './lib/xero-customer-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK  = process.env.B2B_ADMIN_MOCK === '1';
const PORT  = Number(process.env.PORT || 8794);

const GOOGLE_CLIENT_ID     = process.env.B2B_ADMIN_GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.B2B_ADMIN_GOOGLE_CLIENT_SECRET || '';
const ALLOWED_EMAILS       = (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
const SHOPIFY_BEARER       = process.env.SHOPIFY_BRIDGE_BEARER           || '';
const REDIRECT_URI         = MOCK
  ? `http://127.0.0.1:${PORT}/auth/google/callback`
  : 'https://b2badmin.fuzzywumpets.com/auth/google/callback';
const COOKIE_NAME = 'b2b_admin_sid';
const B2B_PUB_ID  = 'gid://shopify/Publication/199709720811';
const PORTAL_INTERNAL_TOKEN = process.env.B2B_PORTAL_INTERNAL_TOKEN || '';
const PORTAL_INTERNAL_URL   = process.env.B2B_PORTAL_INTERNAL_URL || 'http://127.0.0.1:8793';
const XERO_BRIDGE_URL       = 'https://fww-xero-bridge.alex-037.workers.dev/xero';
const XERO_BEARER           = process.env.XERO_BRIDGE_BEARER || '';
const IMPERSONATION_SECRET  = process.env.B2B_IMPERSONATION_SECRET || (MOCK ? 'test-impersonation-secret-mock' : '');
const PORTAL_BASE_URL       = MOCK ? `http://127.0.0.1:8793` : 'https://b2b.fuzzyreporting.com';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || (MOCK ? 'test-shopify-webhook-secret' : '');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Portal integration (read portal SQLite + call portal internal API) ────────

import Database from 'better-sqlite3';

let portalDb = null;
function getPortalDb() {
  if (MOCK) return null;
  if (!portalDb) {
    const dbPath = '/home/alexa/projects/fww-b2b-portal/data/portal.db';
    try { portalDb = new Database(dbPath, { readonly: true, fileMustExist: true }); } catch (_) {}
  }
  return portalDb;
}

function getVisibleNotesForOrder(shopifyOrderId) {
  if (MOCK) return [];
  const db = getPortalDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM visible_notes WHERE order_id = ? ORDER BY added_at DESC').all(shopifyOrderId).map(r => ({
      id: r.id, orderId: r.order_id, customerId: r.customer_id,
      body: r.body, addedAt: r.added_at, addedBy: r.added_by,
    }));
  } catch (_) { return []; }
}

function getPendingTaxCertsFromPortal() {
  if (MOCK) return [];
  const db = getPortalDb();
  if (!db) return [];
  try {
    return db.prepare("SELECT * FROM tax_exempt_certs WHERE status = 'pending' ORDER BY uploaded_at ASC").all().map(r => ({
      id: r.id, customerId: r.customer_id, state: r.state, filePath: r.file_path,
      status: r.status, uploadedAt: r.uploaded_at,
    }));
  } catch (_) { return []; }
}

function getCustomerActivityFromPortal(numericCustomerId, { from, to, type, q, page = 1, limit = 50 } = {}) {
  if (MOCK) {
    const allRows = [
      { id: 1, customerId: `gid://shopify/Customer/${numericCustomerId}`, sessionId: 'sess-1', eventType: 'page_view', eventSubtype: null, path: '/catalog', httpStatus: 200, durationMs: 120, ts: Date.now() - 5000 },
      { id: 2, customerId: `gid://shopify/Customer/${numericCustomerId}`, sessionId: 'sess-1', eventType: 'api_call', eventSubtype: 'api/catalog', path: '/api/catalog', httpStatus: 200, durationMs: 45, ts: Date.now() - 6000 },
      { id: 3, customerId: `gid://shopify/Customer/${numericCustomerId}`, sessionId: 'sess-1', eventType: 'auth', eventSubtype: 'login', path: '/auth/callback', httpStatus: 302, ts: Date.now() - 7000 },
    ];
    const filtered = (type && type !== 'all') ? allRows.filter(r => r.eventType === type) : allRows;
    return {
      rows: filtered,
      total: filtered.length,
      lastLogin: { ts: Date.now() - 7000 },
      lastCart: null,
      page: 1,
      limit: 50,
    };
  }
  const db = getPortalDb();
  if (!db) return { rows: [], total: 0, lastLogin: null, lastCart: null, page: 1, limit: 50 };
  try {
    const customerId = `gid://shopify/Customer/${numericCustomerId}`;
    let sql = 'SELECT * FROM customer_activity WHERE customer_id = ?';
    const params = [customerId];
    if (from) { sql += ' AND ts >= ?'; params.push(new Date(from).getTime()); }
    if (to)   { sql += ' AND ts <= ?'; params.push(new Date(to).getTime() + 86400000); }
    if (type && type !== 'all') { sql += ' AND event_type = ?'; params.push(type); }
    if (q) {
      sql += ' AND (path LIKE ? OR event_subtype LIKE ? OR event_data LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const countRow = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) as cnt')).get(...params);
    const total = countRow ? countRow.cnt : 0;
    const lim = Math.min(Number(limit) || 50, 200);
    const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
    sql += ' ORDER BY ts DESC LIMIT ? OFFSET ?';
    params.push(lim, off);
    const rows = db.prepare(sql).all(...params).map(r => ({
      id: r.id, customerId: r.customer_id, sessionId: r.session_id,
      eventType: r.event_type, eventSubtype: r.event_subtype,
      eventData: r.event_data ? (() => { try { return JSON.parse(r.event_data); } catch(_) { return r.event_data; } })() : null,
      path: r.path, referrer: r.referrer, userAgent: r.user_agent,
      ipHash: r.ip_hash ? r.ip_hash.slice(0, 8) : null,
      ipCountry: r.ip_country, httpStatus: r.http_status,
      durationMs: r.duration_ms, impersonationAdmin: r.impersonation_admin, ts: r.ts,
    }));
    const lastLoginRow = db.prepare(`SELECT * FROM customer_activity WHERE customer_id = ? AND event_type = 'auth' AND event_subtype = 'login' ORDER BY ts DESC LIMIT 1`).get(customerId);
    const lastCartRow  = db.prepare(`SELECT * FROM customer_activity WHERE customer_id = ? AND event_type = 'cart' ORDER BY ts DESC LIMIT 1`).get(customerId);
    return { rows, total, page: Math.max(Number(page) || 1, 1), limit: lim,
      lastLogin: lastLoginRow ? { ts: lastLoginRow.ts } : null,
      lastCart:  lastCartRow  ? { ts: lastCartRow.ts  } : null };
  } catch (e) { console.error('[activity] portal read failed:', e.message); return { rows: [], total: 0, lastLogin: null, lastCart: null, page: 1, limit: 50 }; }
}

function getActiveCartFromPortal(numericCustomerId) {
  const customerId = `gid://shopify/Customer/${numericCustomerId}`;
  if (MOCK) {
    return { items: [], subtotal: 0, itemCount: 0, updatedAt: null };
  }
  const db = getPortalDb();
  if (!db) return { items: [], subtotal: 0, itemCount: 0, updatedAt: null };
  try {
    const cart = db.prepare('SELECT * FROM carts WHERE customer_id = ?').get(customerId);
    if (!cart) return { items: [], subtotal: 0, itemCount: 0, updatedAt: null };
    const rows = db.prepare('SELECT * FROM cart_items WHERE cart_id = ? ORDER BY added_at').all(cart.cart_id);
    const items = rows.map(r => ({
      variantId:    r.variant_id,
      productId:    r.product_id,
      productTitle: r.product_title,
      variantTitle: r.variant_title,
      sku:          r.sku,
      quantity:     r.quantity,
      b2bPrice:     r.b2b_price,
      lineTotal:    Math.round(r.b2b_price * r.quantity * 100) / 100,
    }));
    const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
    return { items, subtotal: Math.round(subtotal * 100) / 100, itemCount: rows.length, updatedAt: cart.updated_at };
  } catch (e) { console.error('[active-cart] portal read failed:', e.message); return { items: [], subtotal: 0, itemCount: 0, updatedAt: null }; }
}

async function callPortalInternal(method, path, body) {
  if (!PORTAL_INTERNAL_TOKEN) return { ok: false, error: 'no_internal_token' };
  try {
    const r = await fetch(`${PORTAL_INTERNAL_URL}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${PORTAL_INTERNAL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    return { ok: r.ok, ...j };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Xero accounting integration ───────────────────────────────────────────────

function xeroMockResponse(method, xeroPath, body) {
  if (xeroPath.includes('/ContactGroups')) {
    return { ContactGroups: [{ ContactGroupID: 'c5afb0f1-8a59-4db8-be57-83548c361669', Name: 'B2B Customers', Contacts: [] }] };
  }
  if (xeroPath.includes('/Contacts') && method === 'GET' && xeroPath.includes('where=')) {
    // Live lookup by AccountNumber — return empty in mock (so syncCustomerToXero will create)
    return { Contacts: [] };
  }
  if (xeroPath.includes('/Contacts')) {
    return { Contacts: [{ ContactID: 'mock-contact-xero', Name: body?.Contacts?.[0]?.Name || 'Mock Contact', EmailAddress: body?.Contacts?.[0]?.EmailAddress || '' }] };
  }
  if (xeroPath.includes('/Invoices') && method !== 'GET') {
    return { Invoices: [{ InvoiceID: 'mock-inv-' + Date.now(), InvoiceNumber: body?.Invoices?.[0]?.InvoiceNumber || 'MOCK001', Status: 'AUTHORISED', AmountDue: 100 }] };
  }
  if (xeroPath.includes('/Invoices') && method === 'GET') {
    return { Invoices: [{ InvoiceID: 'mock-inv-get', InvoiceNumber: 'MOCK001', Status: 'AUTHORISED', AmountDue: 100 }] };
  }
  if (xeroPath.includes('/Payments')) {
    return { Payments: [{ PaymentID: 'mock-pay-' + Date.now(), Status: 'AUTHORISED' }] };
  }
  if (xeroPath.includes('/Accounts')) {
    return { Accounts: [{ Code: '200', Name: 'Sales', Type: 'REVENUE', AccountID: 'acc-200' }, { Code: '610', Name: 'Accounts Receivable', Type: 'CURRENT', AccountID: 'acc-610' }, { Code: '1110', Name: 'Chase Business Checking', Type: 'BANK', AccountID: 'acc-1110' }, { Code: '1120', Name: 'Stripe Clearing', Type: 'CURRENT', AccountID: 'acc-1120' }, { Code: '6100', Name: 'Bank Fees', Type: 'EXPENSE', AccountID: 'acc-6100' }, { Code: '400', Name: 'Discounts', Type: 'REVENUE', AccountID: 'acc-400' }] };
  }
  return {};
}

async function xeroRequest(method, xeroPath, body = null) {
  if (MOCK || !XERO_BEARER) {
    return { ok: true, body: xeroMockResponse(method, xeroPath, body) };
  }
  const payload = { method, path: xeroPath };
  if (body) payload.body = body;
  const resp = await fetch(XERO_BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XERO_BEARER}` },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Xero bridge ${method} ${xeroPath} → ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = await resp.json();
  if (!json.ok) throw new Error(`Xero API error: ${JSON.stringify(json.body || json).slice(0, 300)}`);
  return json;
}

function getXeroAccountMap() {
  return {
    sales_revenue:        getSetting('xero_sales_revenue')        || '200',
    accounts_receivable:  getSetting('xero_accounts_receivable')  || '610',
    chase_checking:       getSetting('xero_chase_checking')       || '1110',
    stripe_clearing:      getSetting('xero_stripe_clearing')      || '1120',
    processing_fees:      getSetting('xero_processing_fees')      || '6100',
    discounts:            getSetting('xero_discounts')            || '400',
    payment_terms_days:   Number(getSetting('xero_payment_terms_days') || '30'),
  };
}

function toXeroDate(isoString) {
  if (!isoString) return new Date().toISOString().slice(0, 10);
  return new Date(isoString).toISOString().slice(0, 10);
}

function addDays(isoString, days) {
  const d = new Date(isoString || new Date());
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function ensureXeroContact(customer) {
  // customer: { id (GID), displayName, email }
  // Phase 21G: resolve from mapping / live before creating to avoid duplicates
  const numId = shopifyNumericId(customer.id || '');
  if (numId) {
    const resolved = await resolveXeroContact(numId, xeroRequest, { dryRun: MOCK });
    if (resolved) return resolved.xeroContactId;
  }
  const name  = customer.displayName || customer.email || 'Unknown Customer';
  const email = customer.email || '';
  const res = await xeroRequest('PUT', '/api.xro/2.0/Contacts', {
    Contacts: [{ Name: name, AccountNumber: numId || undefined, EmailAddress: email }],
  });
  const contact = res.body?.Contacts?.[0];
  if (!contact?.ContactID) throw new Error('Xero contact create failed: ' + JSON.stringify(res.body).slice(0, 200));
  return contact.ContactID;
}

async function createXeroInvoice(order, accountMap) {
  // order: Shopify order object with lineItems, customer, etc.
  const orderId   = shopifyNumericId(order.id);
  const existing  = getXeroMap(orderId);
  if (existing?.xero_invoice_id && existing.status === 'synced') return existing.xero_invoice_id;

  const contactId = await ensureXeroContact(order.customer || { displayName: 'Unknown', email: '' });

  const lineItems = (order.lineItems?.edges || []).map(e => {
    const li     = e.node;
    const price  = parseFloat(li.originalUnitPriceSet?.presentmentMoney?.amount || li.discountedUnitPriceSet?.presentmentMoney?.amount || '0');
    const qty    = li.quantity || 1;
    return {
      Description:    `${li.title}${li.variantTitle ? ' — ' + li.variantTitle : ''}`,
      Quantity:        qty,
      UnitAmount:      price,
      AccountCode:     accountMap.sales_revenue,
      TaxType:         'NONE',
      LineAmount:      Math.round(price * qty * 100) / 100,
    };
  });

  // Add order-level discounts if present (as negative line)
  if (order.discountApplications?.edges?.length) {
    for (const da of order.discountApplications.edges) {
      const app = da.node;
      if (app.value?.__typename === 'MoneyV2') {
        lineItems.push({ Description: `Discount: ${app.title || 'Order discount'}`, Quantity: 1, UnitAmount: -parseFloat(app.value.amount || '0'), AccountCode: accountMap.discounts, TaxType: 'NONE' });
      }
    }
  }

  const orderDate  = toXeroDate(order.processedAt || order.createdAt);
  const dueDate    = addDays(orderDate, accountMap.payment_terms_days);
  const totalPrice = parseFloat(order.totalPriceSet?.presentmentMoney?.amount || '0');

  const res = await xeroRequest('PUT', '/api.xro/2.0/Invoices', {
    Invoices: [{
      Type:           'ACCREC',
      Contact:        { ContactID: contactId },
      Date:           orderDate,
      DueDate:        dueDate,
      InvoiceNumber:  order.name || ('#' + orderId),
      Reference:      'b2b-admin',
      LineItems:      lineItems.length ? lineItems : [{ Description: 'B2B Order', Quantity: 1, UnitAmount: totalPrice, AccountCode: accountMap.sales_revenue, TaxType: 'NONE' }],
      Status:         'AUTHORISED',
    }],
  });
  const inv = res.body?.Invoices?.[0];
  if (!inv?.InvoiceID) throw new Error('Xero invoice create failed: ' + JSON.stringify(res.body).slice(0, 300));
  setXeroMap(orderId, inv.InvoiceID, contactId, 'synced');
  return inv.InvoiceID;
}

async function recordXeroPayment(orderId, xeroInvoiceId, amount, date, accountCode) {
  const payDate = date ? toXeroDate(date) : new Date().toISOString().slice(0, 10);
  const res = await xeroRequest('PUT', '/api.xro/2.0/Payments', {
    Payments: [{
      Invoice:  { InvoiceID: xeroInvoiceId },
      Account:  { Code: accountCode },
      Date:     payDate,
      Amount:   amount,
    }],
  });
  const pay = res.body?.Payments?.[0];
  if (!pay?.PaymentID) throw new Error('Xero payment create failed: ' + JSON.stringify(res.body).slice(0, 300));
  return pay.PaymentID;
}

async function syncOrderToXero(numId, actorEmail) {
  const order = await getOrderDetail(numId);
  if (!order) throw new Error('Order not found: ' + numId);
  const accountMap = getXeroAccountMap();
  try {
    const xeroInvoiceId = await createXeroInvoice(order, accountMap);
    auditLog(actorEmail, 'xero:invoice_synced', shopifyOrderGid(numId), null, { xeroInvoiceId });
    return { ok: true, xeroInvoiceId };
  } catch (err) {
    const pendingId = addXeroPending('create_invoice', { orderId: numId, error: err.message });
    setXeroMap(numId, null, null, 'pending_retry', err.message);
    auditLog(actorEmail, 'xero:invoice_failed', shopifyOrderGid(numId), null, { error: err.message, pendingId });
    throw err;
  }
}

async function retryXeroPending() {
  const pending = getXeroPending('pending');
  const accountMap = getXeroAccountMap();
  const results = { done: 0, failed: 0, skipped: 0 };
  for (const action of pending) {
    if (action.retries >= 3) { results.skipped++; continue; }
    const payload = JSON.parse(action.payload_json);
    try {
      if (action.action_type === 'create_invoice') {
        const order = await getOrderDetail(payload.orderId);
        if (!order) { markXeroPendingFailed(action.id, 'Order not found', action.retries + 1); results.failed++; continue; }
        const xeroInvoiceId = await createXeroInvoice(order, accountMap);
        markXeroPendingDone(action.id);
        setXeroMap(payload.orderId, xeroInvoiceId, null, 'synced');
        results.done++;
      } else if (action.action_type === 'record_payment') {
        await recordXeroPayment(payload.orderId, payload.xeroInvoiceId, payload.amount, payload.date, payload.accountCode);
        markXeroPendingDone(action.id);
        results.done++;
      } else {
        markXeroPendingFailed(action.id, 'Unknown action type: ' + action.action_type, action.retries + 1);
        results.failed++;
      }
    } catch (err) {
      markXeroPendingFailed(action.id, err.message, action.retries + 1);
      results.failed++;
    }
  }
  return results;
}

// ── Mock data ─────────────────────────────────────────────────────────────────
const MOCK_ORDERS = [
  {
    id: 'gid://shopify/Order/1001', name: '#1001', processedAt: '2026-05-24T10:00:00Z',
    customer: { id: 'gid://shopify/Customer/101', displayName: 'Acme Pet Supply', email: 'buyer@acme.com' },
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '450.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['b2b-portal'], note: '',
    lineItems: { edges: [
      { node: { id: 'li1', title: 'Elite Collar', quantity: 5, variant: { id: 'v301', sku: 'EC-001-S-NV', price: '36.00', inventoryQuantity: 24 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '18.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '36.00', currencyCode: 'USD' } } } },
      { node: { id: 'li2', title: 'Luxe Leash', quantity: 2, variant: { id: 'v302', sku: 'LL-005', price: '75.00', inventoryQuantity: 5 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '37.50', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '75.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet: { presentmentMoney: { amount: '420.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '30.00', currencyCode: 'USD' } },
    totalTaxSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'John', lastName: 'Doe', address1: '123 Main St', address2: '', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' },
    billingAddress:  { firstName: 'John', lastName: 'Doe', address1: '123 Main St', address2: '', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' },
    fulfillments: [],
    transactions: [{ id: 'tx1', status: 'PENDING', kind: 'AUTHORIZATION', gateway: 'manual', createdAt: '2026-05-24T10:00:00Z', amountSet: { presentmentMoney: { amount: '450.00', currencyCode: 'USD' } } }],
  },
  {
    id: 'gid://shopify/Order/1002', name: '#1002', processedAt: '2026-05-23T14:00:00Z',
    customer: { id: 'gid://shopify/Customer/102', displayName: 'Happy Paws Boutique', email: 'orders@happypaws.com' },
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '285.50', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['b2b-portal'], note: 'Ship by Friday',
    lineItems: { edges: [
      { node: { id: 'li3', title: 'Simplicity Collar', quantity: 10, variant: { id: 'v303', sku: 'SC-002-M-RD', price: '22.00', inventoryQuantity: 7 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '11.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '22.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '275.50', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', address2: '', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' },
    billingAddress:  { firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', address2: '', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' },
    fulfillments: [], transactions: [],
  },
  {
    id: 'gid://shopify/Order/1003', name: '#1003', processedAt: '2026-05-22T09:30:00Z',
    customer: { id: 'gid://shopify/Customer/103', displayName: 'Doggo Depot', email: 'wholesale@doggo.com' },
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '1200.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['b2b-portal'], note: '',
    lineItems: { edges: [
      { node: { id: 'li4', title: 'Elite Collar Bundle XL', quantity: 20, variant: { id: 'v304', sku: 'ECB-010-XL', price: '60.00', inventoryQuantity: 8 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '60.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '60.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '1200.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', address2: '', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    billingAddress:  { firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', address2: '', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'TRACK123', url: null, company: 'UPS' }], createdAt: '2026-05-23T12:00:00Z' }],
    transactions: [{ id: 'tx2', status: 'SUCCESS', kind: 'SALE', gateway: 'manual', createdAt: '2026-05-22T11:00:00Z', amountSet: { presentmentMoney: { amount: '1200.00', currencyCode: 'USD' } } }],
  },
  {
    id: 'gid://shopify/Order/1004', name: '#1004', processedAt: '2026-05-21T16:00:00Z',
    customer: { id: 'gid://shopify/Customer/104', displayName: 'Pet Paradise', email: 'buy@petparadise.com' },
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '675.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['b2b-portal'], note: 'Partial ship OK',
    lineItems: { edges: [
      { node: { id: 'li5', title: 'Everyday Collar', quantity: 15, variant: { id: 'v305', sku: 'EC-003-L-BK', price: '30.00', inventoryQuantity: 12 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '30.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '30.00', currencyCode: 'USD' } } } },
      { node: { id: 'li6', title: 'Leash Set', quantity: 5, variant: { id: 'v306', sku: 'LS-007', price: '45.00', inventoryQuantity: 3 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '45.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '45.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '675.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Maria', lastName: 'Garcia', address1: '321 Palm Dr', address2: 'Suite 4', city: 'Miami', province: 'FL', zip: '33101', country: 'US' },
    billingAddress:  { firstName: 'Maria', lastName: 'Garcia', address1: '321 Palm Dr', address2: 'Suite 4', city: 'Miami', province: 'FL', zip: '33101', country: 'US' },
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'TRACK456', url: null, company: 'FedEx' }], createdAt: '2026-05-22T09:00:00Z' }],
    transactions: [{ id: 'tx3', status: 'SUCCESS', kind: 'SALE', gateway: 'manual', createdAt: '2026-05-21T17:00:00Z', amountSet: { presentmentMoney: { amount: '675.00', currencyCode: 'USD' } } }],
  },
  // SparkLayer wholesale order (historical — pre-portal)
  {
    id: 'gid://shopify/Order/1005', name: '#1005', processedAt: '2026-05-18T11:00:00Z',
    customer: { id: 'gid://shopify/Customer/103', displayName: 'Doggo Depot', email: 'wholesale@doggo.com' },
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '540.00', currencyCode: 'USD' } },
    sourceName: 'web', tags: ['sparklayer', 'b2b'], note: 'SparkLayer historical order',
    lineItems: { edges: [
      { node: { id: 'li7', title: 'Elite Collar', quantity: 9, variant: { id: 'v301', sku: 'EC-001-S-NV', price: '36.00', inventoryQuantity: 24 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '18.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '36.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '540.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: { firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', address2: '', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    billingAddress:  { firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', address2: '', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [{ number: 'SPKL001', url: null, company: 'UPS' }], createdAt: '2026-05-19T09:00:00Z' }],
    transactions: [{ id: 'tx4', status: 'SUCCESS', kind: 'SALE', gateway: 'manual', createdAt: '2026-05-18T11:30:00Z', amountSet: { presentmentMoney: { amount: '540.00', currencyCode: 'USD' } } }],
  },
  // POS order (from dog show / in-person sale)
  {
    id: 'gid://shopify/Order/1006', name: '#1006', processedAt: '2026-05-15T14:30:00Z',
    customer: { id: 'gid://shopify/Customer/101', displayName: 'Acme Pet Supply', email: 'buyer@acme.com' },
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
    totalPriceSet: { presentmentMoney: { amount: '220.00', currencyCode: 'USD' } },
    sourceName: 'pos', tags: [], note: 'In-person at dog show',
    lineItems: { edges: [
      { node: { id: 'li8', title: 'Luxe Leash', quantity: 4, variant: { id: 'v302', sku: 'LL-005', price: '55.00', inventoryQuantity: 5 },
          discountedUnitPriceSet: { presentmentMoney: { amount: '55.00', currencyCode: 'USD' } },
          originalUnitPriceSet:   { presentmentMoney: { amount: '55.00', currencyCode: 'USD' } } } },
    ]},
    subtotalPriceSet:      { presentmentMoney: { amount: '220.00', currencyCode: 'USD' } },
    totalShippingPriceSet: { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    totalTaxSet:           { presentmentMoney: { amount: '0.00', currencyCode: 'USD' } },
    shippingAddress: null, billingAddress: null,
    fulfillments: [{ status: 'SUCCESS', trackingInfo: [], createdAt: '2026-05-15T14:30:00Z' }],
    transactions: [{ id: 'tx5', status: 'SUCCESS', kind: 'SALE', gateway: 'pos', createdAt: '2026-05-15T14:30:00Z', amountSet: { presentmentMoney: { amount: '220.00', currencyCode: 'USD' } } }],
  },
];

// In-memory overrides for mock mutations (mark paid, note changes)
const mockOrderOverrides = new Map(); // numericId → { displayFinancialStatus?, note? }

function getMockOrder(numericId) {
  const gid = `gid://shopify/Order/${numericId}`;
  const order = MOCK_ORDERS.find(o => o.id === gid);
  if (!order) return null;
  const overrides = mockOrderOverrides.get(numericId) || {};
  return { ...order, ...overrides };
}

const MOCK_CUSTOMERS = [
  {
    id: 'gid://shopify/Customer/101', displayName: 'Acme Pet Supply',
    email: 'buyer@acme.com', phone: '+1-555-0101',
    tags: ['b2b', 'b2b-tier:gold'],
    amountSpent: { amount: '4520.00', currencyCode: 'USD' },
    numberOfOrders: 23,
    defaultAddress: { id: 'addr1', firstName: 'John', lastName: 'Doe', address1: '123 Main St', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' },
    addresses: [{ id: 'addr1', firstName: 'John', lastName: 'Doe', address1: '123 Main St', city: 'Chicago', province: 'IL', zip: '60601', country: 'US' }],
    metafields: { edges: [
      { node: { id: 'mf1', namespace: 'b2b', key: 'dropship_enabled', value: 'false', type: 'boolean' } },
      { node: { id: 'mf4', namespace: 'b2b', key: 'discount_pct', value: '60', type: 'number_integer' } },
    ]},
  },
  {
    id: 'gid://shopify/Customer/102', displayName: 'Happy Paws Boutique',
    email: 'orders@happypaws.com', phone: '+1-555-0102',
    tags: ['b2b', 'b2b-tier:silver'],
    amountSpent: { amount: '2890.00', currencyCode: 'USD' },
    numberOfOrders: 15,
    defaultAddress: { id: 'addr2', firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' },
    addresses: [{ id: 'addr2', firstName: 'Jane', lastName: 'Smith', address1: '456 Park Ave', city: 'Seattle', province: 'WA', zip: '98101', country: 'US' }],
    metafields: { edges: [
      { node: { id: 'mf2', namespace: 'b2b', key: 'dropship_enabled', value: 'true', type: 'boolean' } },
      { node: { id: 'mf3', namespace: 'b2b', key: 'dropship_margin_pct', value: '30', type: 'number_integer' } },
    ]},
  },
  {
    id: 'gid://shopify/Customer/103', displayName: 'Doggo Depot',
    email: 'wholesale@doggo.com', phone: '+1-555-0103',
    tags: ['b2b'],
    amountSpent: { amount: '1850.00', currencyCode: 'USD' },
    numberOfOrders: 9,
    defaultAddress: { id: 'addr3', firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', city: 'Austin', province: 'TX', zip: '78701', country: 'US' },
    addresses: [{ id: 'addr3', firstName: 'Bob', lastName: 'Brown', address1: '789 Oak St', city: 'Austin', province: 'TX', zip: '78701', country: 'US' }],
    metafields: { edges: [] },
  },
  {
    id: 'gid://shopify/Customer/104', displayName: 'Pet Paradise',
    email: 'buy@petparadise.com', phone: '+1-555-0104',
    tags: ['b2b', 'b2b-tier:gold'],
    amountSpent: { amount: '1200.00', currencyCode: 'USD' },
    numberOfOrders: 7,
    defaultAddress: { id: 'addr4', firstName: 'Maria', lastName: 'Garcia', address1: '321 Palm Dr', city: 'Miami', province: 'FL', zip: '33101', country: 'US' },
    addresses: [{ id: 'addr4', firstName: 'Maria', lastName: 'Garcia', address1: '321 Palm Dr', city: 'Miami', province: 'FL', zip: '33101', country: 'US' }],
    metafields: { edges: [] },
  },
  {
    id: 'gid://shopify/Customer/105', displayName: 'Paw Central',
    email: 'orders@pawcentral.com', phone: '+1-555-0105',
    tags: ['b2b', 'b2b-tier:silver'],
    amountSpent: { amount: '890.00', currencyCode: 'USD' },
    numberOfOrders: 5,
    defaultAddress: null,
    addresses: [],
    metafields: { edges: [] },
  },
  // SparkLayer legacy customer (not yet b2b-tagged)
  {
    id: 'gid://shopify/Customer/106', displayName: 'Top Dog Boutique',
    email: 'buying@topdogboutique.com', phone: '+1-555-0106',
    tags: ['sparklayer', 'sparklayer-customer'],
    amountSpent: { amount: '3100.00', currencyCode: 'USD' },
    numberOfOrders: 11,
    defaultAddress: { id: 'addr6', firstName: 'Dave', lastName: 'Lee', address1: '100 Elm St', city: 'Portland', province: 'OR', zip: '97201', country: 'US' },
    addresses: [{ id: 'addr6', firstName: 'Dave', lastName: 'Lee', address1: '100 Elm St', city: 'Portland', province: 'OR', zip: '97201', country: 'US' }],
    metafields: { edges: [] },
  },
];

// In-memory override store for mock mode (Phase 7). Key = numericId string.
const mockB2bConfigOverrides = new Map();

const MOCK_PRODUCTS = [
  { id: 'gid://shopify/Product/201', title: 'Elite Collar', handle: 'elite-collar',
    vendor: 'Fuzzywumpets', productType: 'Dog Collar', tags: ['Style_Elite', 'b2b'],
    featuredImage: { url: 'https://cdn.shopify.com/mock/elite-collar-1.jpg', altText: 'Elite Collar' },
    images: { edges: [
      { node: { url: 'https://cdn.shopify.com/mock/elite-collar-1.jpg', altText: '' } },
      { node: { url: 'https://cdn.shopify.com/mock/elite-collar-2.jpg', altText: '' } },
    ]},
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/301', title: 'Small / Navy', sku: 'EC-001-S-NV', price: '36.00', compareAtPrice: '54.00', barcode: '012345678901', inventoryQuantity: 24 } },
      { node: { id: 'gid://shopify/ProductVariant/302', title: 'Medium / Navy', sku: 'EC-001-M-NV', price: '36.00', compareAtPrice: '54.00', barcode: '012345678902', inventoryQuantity: 12 } },
      { node: { id: 'gid://shopify/ProductVariant/307', title: 'Large / Navy',  sku: 'EC-001-L-NV', price: '36.00', compareAtPrice: '54.00', barcode: '',             inventoryQuantity: 0  } },
    ]}
  },
  { id: 'gid://shopify/Product/202', title: 'Luxe Leash', handle: 'luxe-leash',
    vendor: 'Fuzzywumpets', productType: 'Dog Leash', tags: ['Style_Luxe', 'b2b'],
    featuredImage: { url: 'https://cdn.shopify.com/mock/luxe-leash-1.jpg', altText: 'Luxe Leash' },
    images: { edges: [
      { node: { url: 'https://cdn.shopify.com/mock/luxe-leash-1.jpg', altText: '' } },
    ]},
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/303', title: 'Default Title', sku: 'LL-005', price: '75.00', compareAtPrice: '112.00', barcode: '012345678903', inventoryQuantity: 5 } },
    ]}
  },
  { id: 'gid://shopify/Product/203', title: 'Simplicity Collar', handle: 'simplicity-collar',
    vendor: 'Fuzzywumpets', productType: 'Dog Collar', tags: ['Style_Simplicity', 'b2b'],
    featuredImage: { url: 'https://cdn.shopify.com/mock/simplicity-collar-1.jpg', altText: 'Simplicity Collar' },
    images: { edges: [
      { node: { url: 'https://cdn.shopify.com/mock/simplicity-collar-1.jpg', altText: '' } },
      { node: { url: 'https://cdn.shopify.com/mock/simplicity-collar-2.jpg', altText: '' } },
      { node: { url: 'https://cdn.shopify.com/mock/simplicity-collar-3.jpg', altText: '' } },
    ]},
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/304', title: 'Medium / Red', sku: 'SC-002-M-RD', price: '22.00', compareAtPrice: '33.00', barcode: '012345678904', inventoryQuantity: 7  } },
      { node: { id: 'gid://shopify/ProductVariant/305', title: 'Large / Red',  sku: 'SC-002-L-RD', price: '22.00', compareAtPrice: '33.00', barcode: '012345678905', inventoryQuantity: 18 } },
    ]}
  },
  { id: 'gid://shopify/Product/204', title: 'Everyday Collar Bundle', handle: 'everyday-collar-bundle',
    vendor: 'Fuzzywumpets', productType: 'Dog Collar', tags: ['Style_Everyday', 'b2b'],
    featuredImage: { url: 'https://cdn.shopify.com/mock/everyday-bundle-1.jpg', altText: 'Everyday Collar Bundle' },
    images: { edges: [
      { node: { url: 'https://cdn.shopify.com/mock/everyday-bundle-1.jpg', altText: '' } },
    ]},
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/306', title: 'XL', sku: 'ECB-010-XL', price: '60.00', compareAtPrice: '90.00', barcode: '012345678906', inventoryQuantity: 8 } },
    ]}
  },
];

// Phase 3 mock data ─────────────────────────────────────────────────────────
const MOCK_CATALOG_PRODUCTS = [
  { id: 'gid://shopify/Product/201', title: 'Elite Collar', handle: 'elite-collar',
    vendor: 'Fuzzywumpets', tags: ['Style_Elite', 'b2b'], publishedOnB2B: true, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/301', sku: 'EC-001-S-NV', title: 'Small / Navy', inventoryQuantity: 24 } },
      { node: { id: 'gid://shopify/ProductVariant/302', sku: 'EC-001-M-NV', title: 'Medium / Navy', inventoryQuantity: 12 } },
      { node: { id: 'gid://shopify/ProductVariant/307', sku: 'EC-001-L-NV', title: 'Large / Navy', inventoryQuantity: 0 } },
    ]}
  },
  { id: 'gid://shopify/Product/202', title: 'Luxe Leash', handle: 'luxe-leash',
    vendor: 'Fuzzywumpets', tags: ['Style_Luxe', 'b2b'], publishedOnB2B: true, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/303', sku: 'LL-005', title: 'Default Title', inventoryQuantity: 5 } },
    ]}
  },
  { id: 'gid://shopify/Product/203', title: 'Simplicity Collar', handle: 'simplicity-collar',
    vendor: 'Fuzzywumpets', tags: ['Style_Simplicity', 'b2b'], publishedOnB2B: true, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/304', sku: 'SC-002-M-RD', title: 'Medium / Red', inventoryQuantity: 7 } },
      { node: { id: 'gid://shopify/ProductVariant/305', sku: 'SC-002-L-RD', title: 'Large / Red', inventoryQuantity: 18 } },
    ]}
  },
  { id: 'gid://shopify/Product/204', title: 'Everyday Collar Bundle', handle: 'everyday-collar-bundle',
    vendor: 'Fuzzywumpets', tags: ['Style_Everyday', 'b2b'], publishedOnB2B: true, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/306', sku: 'ECB-010-XL', title: 'XL', inventoryQuantity: 8 } },
    ]}
  },
  { id: 'gid://shopify/Product/205', title: 'Everyday Collar Starter', handle: 'everyday-collar-starter',
    vendor: 'Fuzzywumpets', tags: ['Style_Everyday'], publishedOnB2B: false, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/308', sku: 'EC-STR-S', title: 'Small', inventoryQuantity: 45 } },
      { node: { id: 'gid://shopify/ProductVariant/309', sku: 'EC-STR-M', title: 'Medium', inventoryQuantity: 32 } },
    ]}
  },
  { id: 'gid://shopify/Product/206', title: 'Elite Harness', handle: 'elite-harness',
    vendor: 'Fuzzywumpets', tags: ['Style_Elite', 'b2b'], publishedOnB2B: true, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/310', sku: 'EH-001-S', title: 'Small', inventoryQuantity: 3 } },
      { node: { id: 'gid://shopify/ProductVariant/311', sku: 'EH-001-M', title: 'Medium', inventoryQuantity: 9 } },
    ]}
  },
  { id: 'gid://shopify/Product/207', title: 'Everyday Bandana (Draft)', handle: 'everyday-bandana-draft',
    vendor: 'Fuzzywumpets', tags: ['Style_Everyday'], publishedOnB2B: false, status: 'draft',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/312', sku: 'EB-DFT-S', title: 'Small', inventoryQuantity: 0 } },
    ]}
  },
  { id: 'gid://shopify/Product/208', title: 'Legacy Slip Lead (Archived)', handle: 'legacy-slip-lead',
    vendor: 'Fuzzywumpets', tags: ['Style_Simplicity'], publishedOnB2B: false, status: 'archived',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/313', sku: 'LSL-OLD-OS', title: 'One Size', inventoryQuantity: 0 } },
    ]}
  },
  // Phase 25 test fixture: non-FWW vendor product (should be hidden by default vendor filter)
  { id: 'gid://shopify/Product/210', title: 'FMS Toy Ball - Red', handle: 'fms-toy-ball-red',
    vendor: 'FMS', tags: ['toy'], publishedOnB2B: false, status: 'active',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/320', sku: 'FMS-TB-R', title: 'Default Title', inventoryQuantity: 50 } },
    ]}
  },
];
const mockCatalogOverrides = new Map();

const MOCK_MONTHLY_REVENUE = [
  { month: '2025-06', revenue: 4250.00, orders: 8 },
  { month: '2025-07', revenue: 5100.50, orders: 10 },
  { month: '2025-08', revenue: 6800.00, orders: 13 },
  { month: '2025-09', revenue: 5950.00, orders: 11 },
  { month: '2025-10', revenue: 7200.00, orders: 14 },
  { month: '2025-11', revenue: 8400.00, orders: 17 },
  { month: '2025-12', revenue: 9100.00, orders: 19 },
  { month: '2026-01', revenue: 6200.00, orders: 12 },
  { month: '2026-02', revenue: 7100.00, orders: 14 },
  { month: '2026-03', revenue: 8800.00, orders: 18 },
  { month: '2026-04', revenue: 7500.00, orders: 15 },
  { month: '2026-05', revenue: 4650.00, orders: 9 },
];

const MOCK_CUSTOMER_REVENUE = [
  { id: '101', name: 'Acme Pet Supply',    email: 'buyer@acme.com',         revenue: 14520, orders: 23, aov: 631 },
  { id: '102', name: 'Happy Paws Boutique', email: 'orders@happypaws.com',  revenue: 8890,  orders: 15, aov: 593 },
  { id: '103', name: 'Doggo Depot',         email: 'wholesale@doggo.com',   revenue: 5850,  orders: 9,  aov: 650 },
  { id: '104', name: 'Pet Paradise',        email: 'buy@petparadise.com',   revenue: 4200,  orders: 7,  aov: 600 },
  { id: '105', name: 'Paw Central',         email: 'orders@pawcentral.com', revenue: 2890,  orders: 5,  aov: 578 },
];

// Build variant → product lookup from MOCK_PRODUCTS (mock mode only)
const MOCK_VARIANT_PRODUCT = new Map(); // variantId (short like 'v301') → productNumericId
for (const p of MOCK_PRODUCTS) {
  const pNum = shopifyNumericId(p.id);
  for (const { node: v } of (p.variants?.edges || [])) {
    const vNum = shopifyNumericId(v.id);
    MOCK_VARIANT_PRODUCT.set(`v${vNum}`, pNum);
    MOCK_VARIANT_PRODUCT.set(vNum, pNum); // also map numeric form
  }
}

const MOCK_PRODUCT_REVENUE = [
  { id: '201', title: 'Elite Collar',           sku: 'EC-001-*', revenue: 8640,  units: 240 },
  { id: '202', title: 'Luxe Leash',             sku: 'LL-005',   revenue: 6375,  units: 85  },
  { id: '203', title: 'Simplicity Collar',      sku: 'SC-002-*', revenue: 4400,  units: 200 },
  { id: '204', title: 'Everyday Collar Bundle', sku: 'ECB-010',  revenue: 3600,  units: 60  },
  { id: '206', title: 'Elite Harness',          sku: 'EH-001-*', revenue: 2200,  units: 55  },
];

const MOCK_SPARKLAYER_CUSTOMERS = [
  { id: 'gid://shopify/Customer/201', displayName: 'SparkLayer Test Store', email: 'sl@retailer.com',     tags: ['sparklayer-customer'] },
  { id: 'gid://shopify/Customer/202', displayName: 'Old Portal Boutique',   email: 'old@boutique.com',    tags: ['sparklayer-account', 'b2b-portal-v1'] },
  { id: 'gid://shopify/Customer/203', displayName: 'Migrated Early',        email: 'migrated@store.com',  tags: ['sparklayer-customer', 'b2b'] },
];
const mockSparkLayerMigrated = new Set(['203']); // id 203 already has b2b

// ── Cookie helpers ────────────────────────────────────────────────────────────
function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function sessionCookie(sid, expire = false) {
  const val    = expire ? '' : encodeURIComponent(sid);
  const maxAge = expire ? 0 : 604800;
  const secure = !MOCK ? '; Secure' : '';
  return `${COOKIE_NAME}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const session = getSession(getCookie(req, COOKIE_NAME));
  if (!session) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not authenticated' });
    return res.redirect('/login');
  }
  req.adminSession = session;
  next();
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function h(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function fmtMoney(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount) || 0);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function shopifyNumericId(gid) {
  return gid ? String(gid).split('/').pop() : null;
}

function shopifyOrderGid(numId)    { return `gid://shopify/Order/${numId}`; }
function shopifyCustomerGid(numId) { return `gid://shopify/Customer/${numId}`; }

// ── HTML layout ───────────────────────────────────────────────────────────────
function gfonts() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">`;
}

function layout({ title, session, activePath = '/', content, extraHead = '' }) {
  const navItems = [
    ['/', 'Dashboard'], ['/orders', 'Orders'], ['/customers', 'Customers'],
    ['/leads', 'Leads'], ['/catalog', 'Catalog'], ['/reports', 'Reports'],
    ['/labels', 'Labels'], ['/exports', 'Exports'],
    ['/tax-exempt', 'Tax Exempt'], ['/accounting', 'Accounting'],
    ['/settings', 'Settings'],
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${h(title)} — FWW Admin</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#9BBC0E">
  ${gfonts()}
  <link rel="stylesheet" href="/admin.css">
  ${extraHead}
</head>
<body>
  <header class="admin-header">
    <div class="header-inner">
      <a href="/" class="header-logo">
        <span class="logo-fw">FW</span><span class="logo-admin">admin</span>
      </a>
      <nav class="header-nav">
        ${navItems.map(([href, label]) =>
          `<a href="${href}" class="nav-link${activePath === href ? ' active' : ''}">${label}</a>`
        ).join('')}
      </nav>
      <div class="header-user">
        <span class="user-email">${h(session?.email || '')}</span>
        <a href="/auth/logout" class="btn-signout">Sign out</a>
      </div>
    </div>
  </header>
  <main class="main-content">
    ${content}
  </main>
  <div id="kb-overlay" class="kb-overlay hidden" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <div class="kb-overlay-inner">
      <h3>Keyboard Shortcuts</h3>
      <table class="kb-table">
        <tr><td><kbd>/</kbd></td><td>Focus search</td></tr>
        <tr><td><kbd>g</kbd> <kbd>d</kbd></td><td>Go to Dashboard</td></tr>
        <tr><td><kbd>g</kbd> <kbd>o</kbd></td><td>Go to Orders</td></tr>
        <tr><td><kbd>g</kbd> <kbd>c</kbd></td><td>Go to Customers</td></tr>
        <tr><td><kbd>g</kbd> <kbd>l</kbd></td><td>Go to Catalog</td></tr>
        <tr><td><kbd>g</kbd> <kbd>r</kbd></td><td>Go to Reports</td></tr>
        <tr><td><kbd>g</kbd> <kbd>b</kbd></td><td>Go to Labels</td></tr>
        <tr><td><kbd>g</kbd> <kbd>e</kbd></td><td>Go to Exports</td></tr>
        <tr><td><kbd>?</kbd></td><td>Toggle this overlay</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Close overlay</td></tr>
      </table>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('kb-overlay').classList.add('hidden')">Close</button>
    </div>
  </div>
  <script>
  (function() {
    var gDown = false, gTimer = null;
    document.addEventListener('keydown', function(e) {
      var tag = (e.target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '?' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        var o = document.getElementById('kb-overlay');
        if (o) o.classList.toggle('hidden');
        return;
      }
      if (e.key === 'Escape') {
        var o = document.getElementById('kb-overlay');
        if (o) o.classList.add('hidden');
        return;
      }
      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        var s = document.querySelector('.search-input, #filter-q, input[type="search"]');
        if (s) s.focus();
        return;
      }
      if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
        gDown = true;
        clearTimeout(gTimer);
        gTimer = setTimeout(function() { gDown = false; }, 1000);
        return;
      }
      if (gDown) {
        gDown = false;
        clearTimeout(gTimer);
        var map = { d: '/', o: '/orders', c: '/customers', l: '/catalog', r: '/reports', b: '/labels', e: '/exports', s: '/settings' };
        if (map[e.key]) { e.preventDefault(); window.location = map[e.key]; }
      }
    });
  })();
  </script>
</body>
</html>`;
}

function renderLogin(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — FWW Admin</title>${gfonts()}
  <link rel="stylesheet" href="/admin.css">
</head>
<body class="login-body">
  <div class="login-card">
    <div class="login-logo"><span class="logo-fw">FW</span><span class="logo-admin">admin</span></div>
    <p class="login-tagline">Fuzzywumpets Internal Dashboard</p>
    ${error ? `<div class="alert alert-error" style="margin-bottom:1.25rem;text-align:left">${h(error)}</div>` : ''}
    <a href="/auth/login" class="btn-google">
      <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
        <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
        <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
        <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 6.293C4.672 4.166 6.656 3.58 9 3.58z" fill="#EA4335"/>
      </svg>
      Sign in with Google
    </a>
    <p class="login-note">Access restricted to authorized Fuzzywumpets admin emails.</p>
  </div>
</body></html>`;
}

function renderUnauthorized(email) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Denied — FWW Admin</title>${gfonts()}<link rel="stylesheet" href="/admin.css">
</head>
<body class="login-body">
  <div class="login-card">
    <div class="login-logo"><span class="logo-fw">FW</span><span class="logo-admin">admin</span></div>
    <div class="alert alert-error" style="margin-top:1.5rem;text-align:left">
      <strong>Not authorized.</strong><br>
      <span style="word-break:break-all">${h(email)}</span> is not on the admin allowlist.
      Contact Alexa to request access.
    </div>
    <a href="/login" class="btn-google" style="margin-top:1.25rem;background:#f5f5f5;color:#374151;border-color:#e5e7eb">← Back to login</a>
  </div>
</body></html>`;
}

function renderComingSoon(session, label, activePath) {
  return layout({ title: label, session, activePath, content: `
    <div class="page-header"><h1>${h(label)}</h1></div>
    <div class="coming-soon"><h2>${h(label)}</h2><p>Coming in the next phase — check back soon.</p></div>
  ` });
}

// ── Shopify ───────────────────────────────────────────────────────────────────
async function shopifyFetch(query, variables = {}) {
  const res = await fetch('https://shopify-bridge.alex-037.workers.dev/api/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SHOPIFY_BEARER}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`shopify-bridge ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function getDashboardData() {
  if (MOCK) {
    return {
      openOrdersCount: 2,
      openOrders: MOCK_ORDERS.filter(o => ['PENDING','AUTHORIZED'].includes(o.displayFinancialStatus)).slice(0, 5),
      weekOrdersCount: 3,
      topCustomers: [...MOCK_CUSTOMERS]
        .sort((a, b) => parseFloat(b.amountSpent?.amount || 0) - parseFloat(a.amountSpent?.amount || 0))
        .slice(0, 5)
        .map(c => ({ id: c.id, name: c.displayName, email: c.email, spend: parseFloat(c.amountSpent.amount), orders: c.numberOfOrders })),
      lowStockItems: [
        { productId: 'gid://shopify/Product/201', productTitle: 'Elite Collar', variantTitle: 'Large / Navy', sku: 'EC-001-L-NV', qty: 0 },
        { productId: 'gid://shopify/Product/202', productTitle: 'Luxe Leash', variantTitle: 'Default Title', sku: 'LL-005', qty: 5 },
        { productId: 'gid://shopify/Product/203', productTitle: 'Simplicity Collar', variantTitle: 'Medium / Red', sku: 'SC-002-M-RD', qty: 7 },
        { productId: 'gid://shopify/Product/204', productTitle: 'Everyday Collar Bundle', variantTitle: 'XL', sku: 'ECB-010-XL', qty: 8 },
      ],
    };
  }
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sevenDaysAgo  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const [ordersResult, productsResult] = await Promise.all([
      shopifyFetch(`query($q:String!){ orders(first:50,query:$q,sortKey:PROCESSED_AT,reverse:true){
        edges{node{id name processedAt customer{id displayName email} displayFinancialStatus
          totalPriceSet{presentmentMoney{amount currencyCode}} tags}}
        pageInfo{hasNextPage}}}`, { q: `tag:b2b-portal created_at:>${ninetyDaysAgo}` }),
      shopifyFetch(`query{ products(first:100,query:"published_status:published"){
        edges{node{id title publishedOnPublication(publicationId:"${B2B_PUB_ID}")
          variants(first:10){edges{node{sku title inventoryQuantity}}}}}}}`)
    ]);
    const orders = ordersResult.data?.orders?.edges?.map(e => e.node) || [];
    const openStatuses = new Set(['PENDING','AUTHORIZED','PARTIALLY_PAID']);
    const openOrders = orders.filter(o => openStatuses.has(o.displayFinancialStatus));
    const weekOrders = orders.filter(o => o.processedAt >= sevenDaysAgo);
    const spend = new Map();
    for (const o of orders) {
      if (!o.customer) continue;
      const { id, displayName, email } = o.customer;
      const amt = parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0);
      if (!spend.has(id)) spend.set(id, { id, name: displayName, email, spend: 0 });
      spend.get(id).spend += amt;
    }
    const topCustomers = [...spend.values()].sort((a, b) => b.spend - a.spend).slice(0, 5);
    const allProducts = productsResult.data?.products?.edges?.map(e => e.node) || [];
    const lowStockItems = [];
    for (const p of allProducts) {
      if (!p.publishedOnPublication) continue;
      for (const ve of (p.variants?.edges || [])) {
        const v = ve.node;
        if (typeof v.inventoryQuantity === 'number' && v.inventoryQuantity < 10)
          lowStockItems.push({ productId: p.id, productTitle: p.title, variantTitle: v.title, sku: v.sku, qty: v.inventoryQuantity });
      }
    }
    return { openOrdersCount: openOrders.length, openOrders: openOrders.slice(0, 5), weekOrdersCount: weekOrders.length, topCustomers, lowStockItems: lowStockItems.sort((a,b)=>a.qty-b.qty).slice(0,10) };
  } catch (err) {
    console.error('getDashboardData error:', err.message);
    return { error: err.message, openOrdersCount:0, openOrders:[], weekOrdersCount:0, topCustomers:[], lowStockItems:[] };
  }
}

function renderDashboard(session, data) {
  const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const openOrdersTable = data.openOrders?.length > 0
    ? `<table class="mini-table"><thead><tr><th>Order</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead><tbody>
      ${data.openOrders.map(o => `<tr>
        <td><a href="/orders/${shopifyNumericId(o.id)}">${h(o.name)}</a></td>
        <td>${h(o.customer?.displayName || '—')}</td>
        <td>${fmtMoney(o.totalPriceSet?.presentmentMoney?.amount, o.totalPriceSet?.presentmentMoney?.currencyCode)}</td>
        <td><span class="badge badge-${h((o.displayFinancialStatus||'').toLowerCase())}">${h(o.displayFinancialStatus)}</span></td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="empty-state">No open orders</p>';

  const topCustomersTable = data.topCustomers?.length > 0
    ? `<table class="mini-table"><thead><tr><th>Customer</th><th class="text-right">Spend</th><th class="text-right">Orders</th></tr></thead><tbody>
      ${data.topCustomers.map((c, i) => `<tr>
        <td><span class="top-customer-star" title="Top customer">★</span> <a href="/customers/${shopifyNumericId(c.id)}">${h(c.name)}</a><br><small class="text-muted">${h(c.email)}</small></td>
        <td class="text-right mono">${fmtMoney(c.spend)}</td>
        <td class="text-right"><a href="/orders?customer=${shopifyNumericId(c.id)}" class="link">${c.orders ?? '—'}</a></td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="empty-state">No customer data</p>';

  const lowStockTable = data.lowStockItems?.length > 0
    ? `<table class="mini-table"><thead><tr><th>Product / Variant</th><th>SKU</th><th>Qty</th></tr></thead><tbody>
      ${data.lowStockItems.map(item => `<tr class="${item.qty===0?'row-critical':item.qty<=3?'row-warning':''}">
        <td><a href="/catalog/${shopifyNumericId(item.productId)}">${h(item.productTitle)}</a>
          ${item.variantTitle && item.variantTitle !== 'Default Title' ? `<small>${h(item.variantTitle)}</small>` : ''}</td>
        <td class="mono">${h(item.sku||'—')}</td>
        <td class="${item.qty===0?'qty-zero':item.qty<=3?'qty-critical':'qty-low'}">${item.qty}</td>
      </tr>`).join('')}</tbody></table>`
    : '<p class="empty-state">All items well-stocked ✓</p>';

  return layout({ title: 'Dashboard', session, activePath: '/', content: `
    <div class="page-header"><h1>Dashboard</h1><span class="text-muted">${h(today)}</span></div>
    ${data.error ? `<div class="alert alert-warning">Shopify data unavailable: ${h(data.error)}</div>` : ''}
    <div class="widget-grid">
      <div class="widget">
        <div class="widget-header"><h2>Open Orders</h2><a href="/orders?status=open" class="widget-link">View all →</a></div>
        <div class="widget-stat">${data.openOrdersCount??0}</div>
        <p class="widget-subtext">awaiting payment</p>
        ${openOrdersTable}
      </div>
      <div class="widget">
        <div class="widget-header"><h2>This Week</h2><a href="/orders?date=7d" class="widget-link">View →</a></div>
        <div class="widget-stat">${data.weekOrdersCount??0}</div>
        <p class="widget-subtext">B2B orders in last 7 days</p>
      </div>
      <div class="widget">
        <div class="widget-header"><h2>Top Customers</h2><a href="/customers" class="widget-link">View all →</a></div>
        ${topCustomersTable}
      </div>
      <div class="widget">
        <div class="widget-header"><h2>Low Stock (B2B)</h2><a href="/catalog?stock=low" class="widget-link">Catalog →</a></div>
        ${lowStockTable}
      </div>
    </div>
  ` });
}

// ── Orders list ───────────────────────────────────────────────────────────────
function deriveOrderSource(order) {
  const tags = order.tags || [];
  const sn   = order.sourceName || '';
  if (tags.some(t => (t || '').toLowerCase().startsWith('sparklayer'))) return 'sparklayer';
  if (sn === 'pos') return 'pos';
  if (sn === 'draft_order') return 'manual';
  if (tags.includes('b2b-portal')) return 'b2b-portal';
  return 'online';
}

const ORDER_SOURCE_LABELS = { 'b2b-portal': 'B2B', sparklayer: 'SparkLayer', pos: 'POS', manual: 'Manual', online: 'Online' };
const ORDER_SOURCE_COLORS = { 'b2b-portal': 'lime', sparklayer: 'blue', pos: 'orange', manual: 'gray', online: 'muted' };

const FINANCIAL_STATUS_FILTER = {
  pending: ['PENDING','AUTHORIZED'],
  paid:    ['PAID','PARTIALLY_PAID'],
  open:    ['PENDING','AUTHORIZED','PARTIALLY_PAID'],
  refunded: ['REFUNDED'],
  voided:   ['VOIDED'],
};

async function getOrdersData(filters) {
  // Phase 24D: try cache first (B2B-only by definition — joined to customers_cache where is_b2b=1)
  if (!MOCK) {
    try {
      const stats = getOrdersCacheStats();
      if (stats && stats.total > 0) {
        const cached = listOrdersFromCache(filters);
        return { orders: cached, hasNextPage: false, endCursor: null, total: cached.length, _fromCache: true, _syncedAt: stats.latest };
      }
    } catch (e) {
      console.error('orders cache read failed, falling back to live Shopify:', e.message);
    }
  }
  if (MOCK) {
    let orders = MOCK_ORDERS.map(o => {
      const ov = mockOrderOverrides.get(shopifyNumericId(o.id)) || {};
      return { ...o, ...ov };
    });
    if (filters.source === 'b2b-portal') orders = orders.filter(o => (o.tags||[]).includes('b2b-portal'));
    if (filters.source === 'sparklayer')  orders = orders.filter(o => (o.tags||[]).some(t => t.toLowerCase().startsWith('sparklayer')));
    if (filters.source === 'pos')         orders = orders.filter(o => (o.sourceName||'') === 'pos');
    if (filters.source === 'manual')      orders = orders.filter(o => (o.sourceName||'') === 'draft_order');
    if (filters.q) {
      const q = filters.q.toLowerCase();
      orders = orders.filter(o =>
        o.name.toLowerCase().includes(q) ||
        (o.customer?.displayName || '').toLowerCase().includes(q) ||
        (o.customer?.email || '').toLowerCase().includes(q) ||
        o.lineItems?.edges?.some(e => (e.node.variant?.sku || '').toLowerCase().includes(q))
      );
    }
    if (filters.status && FINANCIAL_STATUS_FILTER[filters.status]) {
      const allowed = FINANCIAL_STATUS_FILTER[filters.status];
      orders = orders.filter(o => allowed.includes(o.displayFinancialStatus));
    }
    if (filters.date) {
      const days = { '7d': 7, '30d': 30, '90d': 90 }[filters.date];
      if (days) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        orders = orders.filter(o => o.processedAt >= cutoff);
      }
    }
    return { orders, hasNextPage: false, endCursor: null, total: orders.length };
  }

  try {
    const qParts = [];  // Phase 9: no default filter — show all orders
    if (filters.source === 'b2b-portal') qParts.push('tag:b2b-portal');
    if (filters.source === 'sparklayer')  qParts.push('tag:sparklayer*');
    if (filters.source === 'pos')         qParts.push('source_name:pos');
    if (filters.source === 'manual')      qParts.push('source_name:draft_order');
    if (filters.q) qParts.push(filters.q);
    if (filters.date) {
      const days = { '7d': 7, '30d': 30, '90d': 90 }[filters.date];
      if (days) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        qParts.push(`created_at:>${cutoff}`);
      }
    }
    if (filters.status && FINANCIAL_STATUS_FILTER[filters.status]) {
      const statuses = FINANCIAL_STATUS_FILTER[filters.status];
      qParts.push(`financial_status:${statuses.join(' OR financial_status:')}`);
    }
    const result = await shopifyFetch(`
      query($q:String!,$first:Int!,$after:String){
        orders(first:$first,query:$q,after:$after,sortKey:PROCESSED_AT,reverse:true){
          edges{cursor node{
            id name processedAt
            customer{id displayName email}
            displayFinancialStatus displayFulfillmentStatus
            totalPriceSet{presentmentMoney{amount currencyCode}}
            sourceName note tags
            lineItems(first:3){edges{node{title quantity variant{sku}}}}
          }}
          pageInfo{hasNextPage endCursor}
        }
      }`, { q: qParts.join(' '), first: 50, after: filters.after || null });
    const edges = result.data?.orders?.edges || [];
    return {
      orders: edges.map(e => e.node),
      hasNextPage: result.data?.orders?.pageInfo?.hasNextPage || false,
      endCursor:   result.data?.orders?.pageInfo?.endCursor   || null,
      total:       edges.length,
    };
  } catch (err) {
    console.error('getOrdersData error:', err.message);
    return { orders: [], error: err.message, hasNextPage: false, endCursor: null, total: 0 };
  }
}

function renderOrdersList(session, data, filters) {
  const { orders, hasNextPage, endCursor, error } = data;

  const rows = orders.map(o => {
    const numId  = shopifyNumericId(o.id);
    const status = (o.displayFinancialStatus || '').toLowerCase();
    const fstatus = (o.displayFulfillmentStatus || '').toLowerCase().replace(/_/g, '-');
    const lineItemSummary = (o.lineItems?.edges || []).slice(0, 3)
      .map(e => `${e.node.title} ×${e.node.quantity}`).join(', ');
    const src = deriveOrderSource(o);
    const srcLabel = ORDER_SOURCE_LABELS[src] || src;
    const srcColor = ORDER_SOURCE_COLORS[src] || 'muted';
    return `<tr>
      <td class="col-check"><input type="checkbox" name="ids" value="${h(numId)}"></td>
      <td><a href="/orders/${h(numId)}" class="order-link">${h(o.name)}</a></td>
      <td>${o.customer ? `<a href="/customers/${shopifyNumericId(o.customer.id)}">${h(o.customer.displayName)}</a><br><small>${h(o.customer.email)}</small>` : '—'}</td>
      <td class="text-muted">${fmtDate(o.processedAt)}</td>
      <td class="text-muted small-text">${h(lineItemSummary)}</td>
      <td class="text-right mono">${fmtMoney(o.totalPriceSet?.presentmentMoney?.amount)}</td>
      <td><span class="badge badge-${h(status)}">${h(o.displayFinancialStatus)}</span></td>
      <td><span class="badge badge-ff-${h(fstatus)}">${h(o.displayFulfillmentStatus)}</span></td>
      <td><a href="/orders/${h(numId)}" class="table-action">View →</a></td>
    </tr>`;
  }).join('');

  const emptyRow = orders.length === 0
    ? `<tr><td colspan="10" class="empty-state">No orders found${filters.q || filters.source || filters.status || filters.date ? ' — try clearing filters' : ''}</td></tr>`
    : '';

  const currentParams = new URLSearchParams();
  if (filters.q)      currentParams.set('q', filters.q);
  if (filters.source) currentParams.set('source', filters.source);
  if (filters.status) currentParams.set('status', filters.status);
  if (filters.date)   currentParams.set('date', filters.date);

  const nextParams = new URLSearchParams(currentParams);
  if (endCursor) nextParams.set('after', endCursor);

  const flash = filters.success === 'marked_paid' ? `<div class="alert alert-success">Order(s) marked as paid.</div>` : '';

  // Source filter removed — all orders shown are B2B (filtered via customers_cache.is_b2b)
  const sourceChips = '';

  return layout({ title: 'Orders', session, activePath: '/orders', content: `
    <div class="page-header-row">
      <h1>Orders</h1>
      <a href="/orders/new" class="btn btn-primary">+ New Order</a>
    </div>
    ${flash}
    ${error ? `<div class="alert alert-warning">Shopify unavailable: ${h(error)}</div>` : ''}
    <div class="filter-chips">${sourceChips}</div>
    <form class="filter-bar" method="GET" action="/orders">
      ${filters.source ? `<input type="hidden" name="source" value="${h(filters.source)}">` : ''}
      <input type="search" name="q" value="${h(filters.q||'')}" placeholder="Order #, customer, SKU…" class="filter-input search-input">
      <select name="status" class="filter-select">
        <option value="">All statuses</option>
        <option value="open"    ${filters.status==='open'?'selected':''}>Open (unpaid)</option>
        <option value="pending" ${filters.status==='pending'?'selected':''}>Pending</option>
        <option value="paid"    ${filters.status==='paid'?'selected':''}>Paid</option>
        <option value="refunded" ${filters.status==='refunded'?'selected':''}>Refunded</option>
      </select>
      <select name="date" class="filter-select">
        <option value="">All time</option>
        <option value="7d"  ${filters.date==='7d'?'selected':''}>Last 7 days</option>
        <option value="30d" ${filters.date==='30d'?'selected':''}>Last 30 days</option>
        <option value="90d" ${filters.date==='90d'?'selected':''}>Last 90 days</option>
      </select>
      <button type="submit" class="btn btn-secondary">Filter</button>
      <a href="/orders" class="btn btn-ghost">Clear</a>
    </form>
    <form id="bulk-form" method="POST" action="/orders/bulk">
      <div class="bulk-bar" id="bulk-bar" hidden>
        <span id="bulk-count">0 selected</span>
        <button type="submit" name="action" value="mark-paid" class="btn btn-success btn-sm">Mark Paid</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            <th class="col-check"><input type="checkbox" id="select-all"></th>
            <th>Order</th><th>Customer</th><th>Date</th><th>Items</th>
            <th class="text-right">Amount</th><th>Payment</th><th>Fulfillment</th><th></th>
          </tr></thead>
          <tbody>${rows}${emptyRow}</tbody>
        </table>
      </div>
    </form>
    <div class="pagination">
      <span class="text-muted">${orders.length} order${orders.length !== 1 ? 's' : ''}</span>
      ${hasNextPage ? `<a href="/orders?${nextParams}" class="btn btn-ghost">Next 50 →</a>` : ''}
    </div>
    <script>
    (function(){
      var selectAll = document.getElementById('select-all');
      var bulkBar   = document.getElementById('bulk-bar');
      var bulkCount = document.getElementById('bulk-count');
      var form      = document.getElementById('bulk-form');
      function upd(){
        var checked = form.querySelectorAll('input[name="ids"]:checked');
        if(checked.length>0){ bulkBar.removeAttribute('hidden'); bulkCount.textContent=checked.length+' selected'; }
        else bulkBar.setAttribute('hidden','');
      }
      selectAll.addEventListener('change',function(){ form.querySelectorAll('input[name="ids"]').forEach(function(c){c.checked=selectAll.checked;}); upd(); });
      form.querySelectorAll('input[name="ids"]').forEach(function(c){ c.addEventListener('change',upd); });
    })();
    </script>
  ` });
}

// ── Order detail ──────────────────────────────────────────────────────────────
async function getOrderDetail(numericId) {
  if (MOCK) return getMockOrder(numericId);
  try {
    const result = await shopifyFetch(`
      query($id:ID!){ order(id:$id){
        id name processedAt createdAt cancelledAt
        customer{id displayName email phone}
        displayFinancialStatus displayFulfillmentStatus
        totalPriceSet{presentmentMoney{amount currencyCode}}
        subtotalPriceSet{presentmentMoney{amount currencyCode}}
        totalShippingPriceSet{presentmentMoney{amount currencyCode}}
        totalTaxSet{presentmentMoney{amount currencyCode}}
        note tags
        shippingAddress{firstName lastName address1 address2 city province zip country}
        billingAddress{firstName lastName address1 address2 city province zip country}
        lineItems(first:50){edges{node{id title quantity
          variant{id sku price inventoryQuantity product{id title}}
          discountedUnitPriceSet{presentmentMoney{amount currencyCode}}
          originalUnitPriceSet{presentmentMoney{amount currencyCode}}
        }}}
        fulfillments{status trackingInfo{number url company} createdAt}
        transactions(first:10){id status kind gateway createdAt
          amountSet{presentmentMoney{amount currencyCode}}}
      }}`, { id: shopifyOrderGid(numericId) });
    return result.data?.order || null;
  } catch (err) {
    console.error('getOrderDetail error:', err.message);
    return null;
  }
}

function renderVisibleNotesList(notes) {
  if (!notes || !notes.length) return '<p class="text-muted small-text">No visible notes yet.</p>';
  return notes.map(n => `
    <div style="border-left:3px solid var(--lime);padding:8px 12px;margin-bottom:8px;background:#f9fdf0;border-radius:0 4px 4px 0">
      <div style="font-size:13px;white-space:pre-wrap">${h(n.body)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">${fmtDate(n.addedAt)} · ${h(n.addedBy)}</div>
    </div>`).join('');
}

function renderOrderDetail(session, order, flash) {
  const numId    = shopifyNumericId(order.id);
  const isPaid   = order.displayFinancialStatus === 'PAID';
  // Xero map (read from SQLite)
  const xeroMap  = getXeroMap(numId);
  // Partial invoices (read from SQLite)
  const partialInvoices = getPartialInvoices(`gid://shopify/Order/${numId}`);
  const isFulfilled = ['FULFILLED','PARTIALLY_FULFILLED'].includes(order.displayFulfillmentStatus);
  const finStatus = (order.displayFinancialStatus || '').toLowerCase();
  const fulStatus = (order.displayFulfillmentStatus || '').toLowerCase().replace(/_/g, '-');

  // Status timeline
  const step1done  = true;
  const step2done  = ['PAID','PARTIALLY_PAID','REFUNDED'].includes(order.displayFinancialStatus);
  const step3done  = isFulfilled;
  const step4done  = order.fulfillments?.some(f => f.status === 'DELIVERED') || false;
  const step2curr  = !step2done;
  const step3curr  = step2done && !step3done;
  const step4curr  = step3done && !step4done;

  function timelineStep(label, done, current) {
    return `<div class="tl-step ${done ? 'tl-done' : current ? 'tl-current' : ''}">${label}</div>`;
  }

  const timeline = `<div class="timeline">
    ${timelineStep('Placed', step1done, false)}
    ${timelineStep('Payment', step2done, step2curr)}
    ${timelineStep('Fulfilled', step3done, step3curr)}
    ${timelineStep('Delivered', step4done, step4curr)}
  </div>`;

  // Backorders for this order (from SQLite) — must be before lineItemsHtml
  const backordersForOrder = getBackordersForOrder(`gid://shopify/Order/${numId}`);
  const backorderMap = new Map(backordersForOrder.map(b => [b.line_item_id, b]));

  // Line items table
  const lineItems = (order.lineItems?.edges || []).map(e => e.node);
  const lineItemsHtml = lineItems.map(item => {
    const unitPrice = parseFloat(item.discountedUnitPriceSet?.presentmentMoney?.amount ?? item.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
    const rowTotal  = unitPrice * (item.quantity || 0);
    // Resolve product ID: from GraphQL `variant.product.id` or mock lookup
    const varId = item.variant?.id || '';
    const productGid = item.variant?.product?.id;
    const productNum = productGid ? shopifyNumericId(productGid) : (MOCK_VARIANT_PRODUCT.get(varId) || MOCK_VARIANT_PRODUCT.get(shopifyNumericId(varId)));
    const titleCell = productNum
      ? `<a href="/products/${productNum}" class="link">${h(item.title)}</a>`
      : h(item.title);
    const bo = backorderMap.get(item.id);
    const boBadge = bo ? `<span class="badge badge-warning" title="ETA: ${bo.eta_date || 'unknown'}">⚠ Backorder</span>` : '';
    const boBtn = `<button type="button" class="btn btn-ghost btn-xs edit-remove-btn" style="display:none;margin-left:4px"
      onclick="toggleBackorderModal('${h(item.id)}','${h(item.title).replace(/'/g,"\\'")}','${item.quantity}',true)">Backorder</button>`;
    return `<tr data-removed="0">
      <td>${titleCell} ${boBadge}${boBtn}
        <input type="hidden" name="removes" value="${h(item.id)}" disabled id="remove_${h(item.id)}">
      </td>
      <td class="mono">${h(item.variant?.sku || '—')}</td>
      <td class="text-right">
        <span class="edit-qty-static">${item.quantity}</span>
        <input type="number" name="qtys[${h(item.id)}]" value="${item.quantity}" min="0" class="edit-qty-input" style="display:none;width:60px">
        <button type="button" class="btn btn-ghost btn-xs edit-remove-btn" style="display:none;margin-left:4px" onclick="markRemove('${h(item.id)}',this)">✕</button>
      </td>
      <td class="text-right">${fmtMoney(unitPrice)}</td>
      <td class="text-right">${fmtMoney(rowTotal)}</td>
    </tr>`;
  }).join('');

  const sub   = fmtMoney(order.subtotalPriceSet?.presentmentMoney?.amount);
  const ship  = fmtMoney(order.totalShippingPriceSet?.presentmentMoney?.amount);
  const total = fmtMoney(order.totalPriceSet?.presentmentMoney?.amount);

  // Fulfillments
  const fulfillmentsHtml = (order.fulfillments || []).length > 0
    ? (order.fulfillments || []).map(f => `
        <div class="fulfillment-row">
          <span class="badge badge-ff-${h((f.status||'').toLowerCase())}">${h(f.status)}</span>
          <span class="text-muted">${fmtDate(f.createdAt)}</span>
          ${(f.trackingInfo || []).map(t => `<a href="${t.url ? h(t.url) : '#'}" target="_blank" rel="noopener" class="tracking-link">${h(t.company || '')} ${h(t.number || '')}</a>`).join('')}
        </div>`).join('')
    : '<p class="text-muted small-text">No fulfillments yet</p>';

  // Transactions
  const txHtml = (order.transactions || []).length > 0
    ? `<table class="mini-table"><thead><tr><th>Kind</th><th>Gateway</th><th>Status</th><th class="text-right">Amount</th><th>Date</th></tr></thead><tbody>
        ${(order.transactions||[]).map(tx => `<tr>
          <td>${h(tx.kind)}</td><td>${h(tx.gateway)}</td>
          <td><span class="badge badge-${h((tx.status||'').toLowerCase())}">${h(tx.status)}</span></td>
          <td class="text-right mono">${fmtMoney(tx.amountSet?.presentmentMoney?.amount)}</td>
          <td class="text-muted">${fmtDate(tx.createdAt)}</td>
        </tr>`).join('')}</tbody></table>`
    : '<p class="text-muted small-text">No transactions</p>';

  const addr = order.shippingAddress;
  const addrHtml = addr
    ? `${h(addr.firstName || '')} ${h(addr.lastName || '')}<br>
       ${h(addr.address1||'')}${addr.address2 ? '<br>'+h(addr.address2) : ''}<br>
       ${h(addr.city||'')}, ${h(addr.province||'')} ${h(addr.zip||'')}<br>${h(addr.country||'')}`
    : '<span class="text-muted">No shipping address</span>';

  const flashHtml = flash === 'marked_paid'
    ? `<div class="alert alert-success">Order marked as paid.</div>`
    : flash === 'note_saved'
    ? `<div class="alert alert-success">Note saved.</div>`
    : flash === 'chase_invoice_queued'
    ? `<div class="alert alert-success">Chase invoice intent logged. Wire Chase API to send the real link.</div>`
    : flash === 'order_edited'
    ? `<div class="alert alert-success">Order updated.</div>`
    : flash === 'discount_applied'
    ? `<div class="alert alert-success">Discount applied.</div>`
    : flash === 'fulfilled'
    ? `<div class="alert alert-success">Fulfillment recorded.</div>`
    : flash === 'backorder_flagged'
    ? `<div class="alert alert-success">Line item marked as backordered.</div>`
    : flash === 'xero_synced'
    ? `<div class="alert alert-success">Xero invoice created/synced.</div>`
    : flash === 'xero_paid'
    ? `<div class="alert alert-success">Xero payment recorded.</div>`
    : flash === 'xero_failed'
    ? `<div class="alert alert-warning">Xero sync failed — queued for retry. Check /accounting.</div>`
    : flash === 'partial_invoice_created'
    ? `<div class="alert alert-success">Partial invoice generated.</div>`
    : flash === 'edit_failed' || flash === 'fulfillment_failed' || flash === 'discount_failed'
    ? `<div class="alert alert-warning">Action failed — check server logs.</div>`
    : '';

  // Edit mode JS (16A)
  const editModeScript = `<script>
  function toggleEditMode(enable) {
    document.getElementById('edit-mode-bar').style.display = enable ? 'block' : 'none';
    document.getElementById('edit-save-bar').style.display = enable ? 'block' : 'none';
    document.getElementById('edit-btn').style.display = enable ? 'none' : 'inline-flex';
    document.querySelectorAll('.edit-qty-input').forEach(el => { el.style.display = enable ? 'inline-block' : 'none'; el.disabled = !enable; });
    document.querySelectorAll('.edit-qty-static').forEach(el => { el.style.display = enable ? 'none' : 'inline'; });
    document.querySelectorAll('.edit-remove-btn').forEach(el => { el.style.display = enable ? 'inline-flex' : 'none'; });
    if (!enable) { document.querySelectorAll('tr[data-removed]').forEach(r => { r.dataset.removed = '0'; r.style.opacity = '1'; }); }
  }
  function markRemove(liId, btn) {
    const row = btn.closest('tr');
    const removed = row.dataset.removed === '1';
    row.dataset.removed = removed ? '0' : '1';
    row.style.opacity = removed ? '1' : '0.4';
    const input = document.getElementById('remove_' + liId);
    if (input) input.disabled = removed;
  }
  function toggleDiscountModal(show) {
    document.getElementById('discount-modal').style.display = show ? 'flex' : 'none';
  }
  function toggleFulfillModal(show) {
    document.getElementById('fulfill-modal').style.display = show ? 'flex' : 'none';
  }
  function toggleBackorderModal(liId, liTitle, liQty, show) {
    const m = document.getElementById('backorder-modal');
    if (show) {
      m.style.display = 'flex';
      document.getElementById('bo-li-id').value = liId || '';
      document.getElementById('bo-li-title').value = liTitle || '';
      document.getElementById('bo-quantity').value = liQty || 1;
    } else {
      m.style.display = 'none';
    }
  }
  function toggleInvoiceModal(show) {
    document.getElementById('invoice-modal').style.display = show ? 'flex' : 'none';
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('discount-modal').style.display = 'none';
      document.getElementById('fulfill-modal').style.display = 'none';
      document.getElementById('backorder-modal').style.display = 'none';
      document.getElementById('invoice-modal').style.display = 'none';
    }
  });
  </script>`;


  const visibleNotesScript = `
    <script>
    async function submitVisibleNote(e, orderId) {
      e.preventDefault();
      const body = document.getElementById('visible-note-body').value.trim();
      if (!body) return;
      const btn = e.target.querySelector('button[type=submit]');
      const status = document.getElementById('visible-note-status');
      btn.disabled = true;
      status.textContent = 'Sending…';
      try {
        const r = await fetch('/api/orders/' + orderId + '/visible-note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Failed');
        document.getElementById('visible-note-body').value = '';
        status.textContent = '✓ Note sent to customer';
        // Refresh notes list
        const nr = await fetch('/api/orders/' + orderId + '/visible-notes');
        const nj = await nr.json();
        const nl = document.getElementById('visible-notes-list');
        if (nl && nj.notes) {
          nl.innerHTML = nj.notes.length
            ? nj.notes.map(n => '<div style="border-left:3px solid var(--lime);padding:8px 12px;margin-bottom:8px;background:#f9fdf0;border-radius:0 4px 4px 0"><div style="font-size:13px;white-space:pre-wrap">' + n.body.replace(/</g,'&lt;') + '</div><div style="font-size:11px;color:var(--muted);margin-top:4px">' + new Date(n.addedAt).toLocaleDateString() + ' · ' + (n.addedBy||'').replace(/</g,'&lt;') + '</div></div>').join('')
            : '<p class="text-muted small-text">No visible notes yet.</p>';
        }
      } catch (err) {
        status.textContent = '✗ ' + err.message;
      } finally {
        btn.disabled = false;
      }
    }
    </script>`;

  return layout({ title: order.name || 'Order', session, activePath: '/orders', content: `
    ${visibleNotesScript}
    ${editModeScript}
    <div class="breadcrumb-row"><a href="/orders" class="breadcrumb">← Orders</a></div>
    ${flashHtml}
    <div class="detail-header">
      <div class="detail-header-left">
        <h1>${h(order.name)} <span class="badge badge-${h(finStatus)}">${h(order.displayFinancialStatus)}</span>
            <span class="badge badge-ff-${h(fulStatus)}">${h(order.displayFulfillmentStatus)}</span></h1>
        <p class="text-muted">
          ${order.customer ? `<a href="/customers/${shopifyNumericId(order.customer.id)}">${h(order.customer.displayName)}</a> · ` : ''}
          ${fmtDate(order.processedAt)}
        </p>
      </div>
      <div class="detail-header-actions">
        ${!isPaid ? `<form method="POST" action="/orders/${h(numId)}/mark-paid" style="display:inline">
          <button class="btn btn-success" onclick="return confirm('Mark ${h(order.name)} as paid?')">Mark Paid</button>
        </form>` : ''}
        <button id="edit-btn" class="btn btn-secondary" onclick="toggleEditMode(true)">Edit order</button>
        <button class="btn btn-secondary" onclick="toggleFulfillModal(true)">Fulfill items</button>
        <button class="btn btn-ghost" onclick="toggleDiscountModal(true)">Apply discount</button>
        <button class="btn btn-secondary" onclick="toggleInvoiceModal(true)">Generate Invoice</button>
        <form method="POST" action="/orders/${h(numId)}/send-chase-invoice" style="display:inline">
          <button class="btn btn-secondary" onclick="return confirm('Queue Chase invoice link for ${h(order.name)}?\\n\\nNote: Chase API not yet wired — this logs the intent.')">Send Chase Invoice</button>
        </form>
        <form method="POST" action="/orders/${h(numId)}/xero/sync" style="display:inline">
          <button class="btn btn-ghost" title="Create or refresh Xero invoice for this order">${xeroMap?.status === 'synced' ? '✓ Xero synced' : 'Sync to Xero'}</button>
        </form>
      </div>
    </div>
    ${timeline}
    <div class="detail-grid">
      <div class="detail-main">
        <div class="card">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
            <h2>Line Items</h2>
            <span id="edit-mode-bar" style="display:none">
              <span style="font-size:12px;color:var(--muted);margin-right:8px">✏ Edit mode</span>
              <button type="button" class="btn btn-ghost btn-sm" onclick="toggleEditMode(false)">Cancel</button>
            </span>
          </div>
          <form method="POST" action="/orders/${h(numId)}/edit" id="edit-form">
          <table class="data-table">
            <thead><tr><th>Item</th><th>SKU</th><th class="text-right">Qty</th><th class="text-right">Unit</th><th class="text-right">Total</th></tr></thead>
            <tbody>${lineItemsHtml}</tbody>
          </table>
          <div class="totals-block">
            <div class="totals-row"><span>Subtotal</span><span>${sub}</span></div>
            <div class="totals-row"><span>Shipping</span><span>${ship}</span></div>
            <div class="totals-row totals-total"><span>Total</span><span>${total}</span></div>
          </div>
          <div id="edit-save-bar" style="display:none;padding:12px 0;border-top:1px solid var(--border);margin-top:8px">
            <input type="text" name="staffNote" placeholder="Staff note (optional)" class="filter-input" style="width:60%;margin-right:8px">
            <button type="submit" class="btn btn-primary">Save changes</button>
            <button type="button" class="btn btn-ghost" onclick="toggleEditMode(false)" style="margin-left:4px">Cancel</button>
          </div>
          </form>
        </div>
        ${/* Discount modal */''}<div id="discount-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:340px;max-width:480px">
            <h3 style="margin:0 0 16px">Apply order discount</h3>
            <form method="POST" action="/orders/${h(numId)}/discount">
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:500">Type</label><br>
                <select name="type" class="filter-select" style="width:100%;margin-top:4px">
                  <option value="pct">Percentage (%)</option>
                  <option value="fixed">Fixed amount ($)</option>
                </select>
              </div>
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:500">Value</label><br>
                <input type="number" name="value" step="0.01" min="0" class="filter-input" style="width:100%;margin-top:4px" placeholder="e.g. 10">
              </div>
              <div style="margin-bottom:16px">
                <label style="font-size:13px;font-weight:500">Reason (required)</label><br>
                <input type="text" name="reason" class="filter-input" style="width:100%;margin-top:4px" placeholder="e.g. Loyalty discount" required>
              </div>
              <div style="display:flex;gap:8px">
                <button type="submit" class="btn btn-primary">Apply discount</button>
                <button type="button" class="btn btn-ghost" onclick="toggleDiscountModal(false)">Cancel</button>
              </div>
            </form>
          </div>
        </div>
        ${/* Fulfill modal */''}<div id="fulfill-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:400px;max-width:560px;max-height:80vh;overflow-y:auto">
            <h3 style="margin:0 0 16px">Fulfill items</h3>
            <form method="POST" action="/orders/${h(numId)}/fulfill">
              <div style="margin-bottom:12px">
                ${lineItems.map(item => {
                  const bo = backorderMap.get(item.id);
                  return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:13px">
                    <input type="checkbox" name="sel_${h(item.id)}" value="1" checked style="flex-shrink:0">
                    <span style="flex:1">${h(item.title)}${bo ? ' <span class="badge badge-warning">Backorder</span>' : ''}</span>
                    <input type="number" name="lineItems[${h(item.id)}]" value="${item.quantity}" min="0" max="${item.quantity}" style="width:60px">
                  </div>`;
                }).join('')}
              </div>
              <div style="margin-bottom:12px;display:flex;gap:8px">
                <input type="text" name="trackingCompany" class="filter-input" style="flex:1" placeholder="Carrier (e.g. USPS)">
                <input type="text" name="trackingNumber" class="filter-input" style="flex:2" placeholder="Tracking number">
              </div>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:16px">
                <input type="checkbox" name="notifyCustomer" value="1"> Email customer with tracking info
              </label>
              <div style="display:flex;gap:8px">
                <button type="submit" class="btn btn-primary">Record fulfillment</button>
                <button type="button" class="btn btn-ghost" onclick="toggleFulfillModal(false)">Cancel</button>
              </div>
            </form>
          </div>
        </div>
        ${/* Backorder modal */''}<div id="backorder-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:340px;max-width:480px">
            <h3 style="margin:0 0 16px">Mark as backordered</h3>
            <form method="POST" action="/orders/${h(numId)}/backorder">
              <input type="hidden" name="lineItemId" id="bo-li-id">
              <input type="hidden" name="lineItemTitle" id="bo-li-title">
              <div style="margin-bottom:12px">
                <label style="font-size:13px;font-weight:500">Quantity backordered</label><br>
                <input type="number" name="quantity" id="bo-quantity" min="1" class="filter-input" style="width:100%;margin-top:4px">
              </div>
              <div style="margin-bottom:16px">
                <label style="font-size:13px;font-weight:500">Expected ship date (optional)</label><br>
                <input type="date" name="eta" class="filter-input" style="width:100%;margin-top:4px">
              </div>
              <div style="display:flex;gap:8px">
                <button type="submit" class="btn btn-primary">Mark backordered</button>
                <button type="button" class="btn btn-ghost" onclick="toggleBackorderModal(null,null,null,false)">Cancel</button>
              </div>
            </form>
          </div>
        </div>
        ${/* Generate Invoice modal */''}<div id="invoice-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:24px;min-width:380px;max-width:500px">
            <h3 style="margin:0 0 16px">Generate Invoice</h3>
            <form method="POST" action="/orders/${h(numId)}/partial-invoice">
              <div style="margin-bottom:14px">
                <div style="font-size:13px;font-weight:500;margin-bottom:8px">Invoice scope</div>
                ${(order.fulfillments || []).length > 0
                  ? `<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:6px">
                      <input type="radio" name="type" value="fulfilled_only" checked>
                      Fulfilled items only (partial invoice)
                    </label>`
                  : ''}
                <label style="display:flex;align-items:center;gap:8px;font-size:13px">
                  <input type="radio" name="type" value="full" ${(order.fulfillments || []).length === 0 ? 'checked' : ''}>
                  Entire order
                </label>
              </div>
              <div style="margin-bottom:16px">
                <div style="font-size:13px;font-weight:500;margin-bottom:6px">Shipping charge</div>
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:4px">
                  <input type="radio" name="shipping_handling" value="first" checked>
                  Include all shipping on this invoice (common for wholesale)
                </label>
                <label style="display:flex;align-items:center;gap:8px;font-size:13px">
                  <input type="radio" name="shipping_handling" value="none">
                  No shipping on this invoice (prorate later)
                </label>
              </div>
              <div style="display:flex;gap:8px">
                <button type="submit" class="btn btn-primary">Generate PDF</button>
                <button type="button" class="btn btn-ghost" onclick="toggleInvoiceModal(false)">Cancel</button>
              </div>
            </form>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h2>Order Note (internal)</h2></div>
          <form method="POST" action="/orders/${h(numId)}/note">
            <textarea name="note" class="textarea" rows="3" placeholder="Add a note for this order…">${h(order.note||'')}</textarea>
            <div style="margin-top:0.5rem"><button type="submit" class="btn btn-secondary btn-sm">Save Note</button></div>
          </form>
        </div>
        <div class="card" id="visible-notes-card">
          <div class="card-header"><h2>Note visible to customer</h2></div>
          <div id="visible-notes-list" style="margin-bottom:10px">${renderVisibleNotesList(order.visibleNotes || [])}</div>
          <form id="visible-note-form" onsubmit="submitVisibleNote(event, ${h(JSON.stringify(numId))})">
            <textarea id="visible-note-body" class="textarea" rows="3" placeholder="Write a note the customer can see on their order…"></textarea>
            <div style="margin-top:0.5rem;display:flex;gap:8px;align-items:center">
              <button type="submit" class="btn btn-primary btn-sm">Send note to customer</button>
              <span id="visible-note-status" style="font-size:12px;color:var(--muted)"></span>
            </div>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><h2>Fulfillments</h2></div>
          ${fulfillmentsHtml}
        </div>
      </div>
      <div class="detail-side">
        ${order.customer ? `<div class="card">
          <div class="card-header"><h2>Customer</h2></div>
          <p><a href="/customers/${shopifyNumericId(order.customer.id)}" class="link-strong">${h(order.customer.displayName)}</a></p>
          <p class="text-muted">${h(order.customer.email)}</p>
          ${order.customer.phone ? `<p class="text-muted">${h(order.customer.phone)}</p>` : ''}
        </div>` : ''}
        <div class="card">
          <div class="card-header"><h2>Shipping Address</h2></div>
          <p class="address-block">${addrHtml}</p>
        </div>
        <div class="card">
          <div class="card-header"><h2>Transactions</h2></div>
          ${txHtml}
        </div>
        <div class="card">
          <div class="card-header"><h2>Tags</h2></div>
          <div class="tags-list">${(order.tags||[]).map(t => `<span class="tag">${h(t)}</span>`).join(' ')}</div>
        </div>
        ${partialInvoices.length > 0 ? `<div class="card">
          <div class="card-header"><h2>Invoices issued</h2></div>
          <div class="kv-list">
            ${partialInvoices.map(inv => `
              <div class="kv-row" style="align-items:flex-start">
                <span>
                  <strong>#${h(String(order.name||numId))}-${h(inv.invoice_letter)}</strong>
                  <span class="badge badge-muted" style="margin-left:4px">${inv.invoice_type === 'fulfilled_only' ? 'partial' : 'full'}</span>
                </span>
                <div style="text-align:right">
                  <div class="mono">${fmtMoney(inv.total)}</div>
                  <div style="font-size:11px;color:var(--muted)">${fmtDate(new Date(inv.created_at).toISOString())}</div>
                  <a href="/orders/${h(numId)}/partial-invoice/${h(inv.invoice_letter)}.pdf" class="link" style="font-size:11px">Download PDF</a>
                </div>
              </div>`).join('')}
          </div>
        </div>` : ''}
        <div class="card">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
            <h2>Xero</h2>
            <a href="/accounting" class="link" style="font-size:12px">View all →</a>
          </div>
          ${xeroMap?.status === 'synced'
            ? `<p class="text-sm"><span class="badge badge-paid">Synced</span></p>
               <p class="text-sm text-muted" style="font-size:12px">Invoice: <code>${h(xeroMap.xero_invoice_id)}</code></p>
               <p class="text-sm text-muted" style="font-size:12px">Last synced ${fmtDate(new Date(xeroMap.synced_at).toISOString())}</p>`
            : xeroMap?.status === 'pending_retry'
            ? `<p class="text-sm"><span class="badge badge-pending">Retry queued</span></p>
               <p class="text-sm text-muted" style="font-size:11px">${h(xeroMap.error_text || '')}</p>`
            : `<p class="text-sm text-muted">Not synced to Xero yet.</p>
               <form method="POST" action="/orders/${h(numId)}/xero/sync" style="margin-top:8px">
                 <button class="btn btn-ghost btn-sm">Create Xero invoice</button>
               </form>`
          }
        </div>
      </div>
    </div>
  ` });
}

// ── Customers list ────────────────────────────────────────────────────────────
async function getCustomersData(filters) {
  // Phase 24D: try local cache first (populated by backfill); fall back to live Shopify
  if (!MOCK) {
    try {
      const stats = getCustomerCacheStats();
      if (stats && stats.total > 0) {
        const cached = listCustomersFromCache(filters);
        if (cached.length > 0) {
          return { customers: cached, hasNextPage: false, total: cached.length, _fromCache: true, _syncedAt: stats.latest };
        }
      }
    } catch (e) {
      console.error('cache read failed, falling back to live Shopify:', e.message);
    }
  }
  if (MOCK) {
    let customers = [...MOCK_CUSTOMERS];
    if (filters.segment === 'b2b')         customers = customers.filter(c => (c.tags||[]).includes('b2b'));
    if (filters.segment === 'sparklayer')  customers = customers.filter(c => (c.tags||[]).some(t => t.toLowerCase().startsWith('sparklayer')));
    if (filters.segment === 'has_orders')  customers = customers.filter(c => (c.numberOfOrders||0) > 0);
    if (filters.segment === 'no_orders')   customers = customers.filter(c => (c.numberOfOrders||0) === 0);
    if (filters.q) {
      const q = filters.q.toLowerCase();
      customers = customers.filter(c =>
        c.displayName.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q)
      );
    }
    if (filters.tag) {
      customers = customers.filter(c => (c.tags||[]).includes(filters.tag));
    }
    // Sort: default = lifetime spend desc (Phase 20)
    const sort = filters.sort || 'lifetime_spend_desc';
    if (sort === 'lifetime_spend_desc') {
      customers.sort((a, b) => parseFloat(b.amountSpent?.amount || 0) - parseFloat(a.amountSpent?.amount || 0));
    } else if (sort === 'name_asc') {
      customers.sort((a, b) => a.displayName.localeCompare(b.displayName));
    } else if (sort === 'orders_desc') {
      customers.sort((a, b) => (b.numberOfOrders || 0) - (a.numberOfOrders || 0));
    }
    return { customers, hasNextPage: false, total: customers.length };
  }
  try {
    const qParts = [];  // Phase 9: no default filter — show all customers
    if (filters.segment === 'b2b')        qParts.push('tag:b2b');
    if (filters.segment === 'sparklayer') qParts.push('tag:sparklayer*');
    if (filters.segment === 'has_orders') qParts.push('orders_count:>0');
    if (filters.segment === 'no_orders')  qParts.push('orders_count:0');
    if (filters.q) qParts.push(filters.q);
    if (filters.tag && !filters.segment)  qParts.push(`tag:${filters.tag}`);
    const result = await shopifyFetch(`
      query($q:String!,$first:Int!,$after:String){
        customers(first:$first,query:$q,after:$after,sortKey:AMOUNT_SPENT,reverse:true){
          edges{cursor node{
            id displayName email phone tags numberOfOrders
            amountSpent{amount currencyCode}
            defaultAddress{city province country}
            metafields(first:5,namespace:"b2b"){edges{node{key value}}}
          }}
          pageInfo{hasNextPage endCursor}
        }
      }`, { q: qParts.join(' '), first: 50, after: filters.after || null });
    const edges = result.data?.customers?.edges || [];
    return {
      customers: edges.map(e => e.node),
      hasNextPage: result.data?.customers?.pageInfo?.hasNextPage || false,
      endCursor:   result.data?.customers?.pageInfo?.endCursor   || null,
      total:       edges.length,
    };
  } catch (err) {
    console.error('getCustomersData error:', err.message);
    return { customers: [], error: err.message, hasNextPage: false, total: 0 };
  }
}

function tagChip(t, { linked = false } = {}) {
  const tl = (t || '').toLowerCase();
  let cls = 'tag-chip-default';
  if (tl === 'b2b') cls = 'tag-chip-b2b';
  else if (tl.startsWith('sparklayer')) cls = 'tag-chip-sparklayer';
  else if (tl === 'b2b-admin') cls = 'tag-chip-admin';
  else if (tl.startsWith('b2b-tier:gold')) cls = 'tag-chip-gold';
  else if (tl.startsWith('b2b-tier:')) cls = 'tag-chip-tier';
  if (linked) {
    return `<a href="/customers?tag=${encodeURIComponent(t)}" class="tag-chip ${cls}">${h(t)}</a>`;
  }
  return `<span class="tag-chip ${cls}">${h(t)}</span>`;
}

function renderCustomersList(session, data, filters) {
  const { customers, hasNextPage, endCursor, error } = data;

  // top-10 by spend get a star badge (Phase 20) — rank = index in list when sorted by spend
  const TOP_CUSTOMER_THRESHOLD = 10;
  const rows = customers.map((c, idx) => {
    const numId = shopifyNumericId(c.id);
    const dropship = c.metafields?.edges?.find(e => e.node.key === 'dropship_enabled')?.node?.value === 'true';
    const addr     = c.defaultAddress;
    const location = addr ? `${addr.city || ''}${addr.province ? ', '+addr.province : ''}` : '—';
    const visibleTags = (c.tags || []).slice(0, 3);
    const moreTags    = (c.tags || []).length - visibleTags.length;
    const tagBadges   = visibleTags.map(t => tagChip(t, { linked: true })).join('') + (moreTags > 0 ? `<span class="tag-chip tag-chip-more" title="${h((c.tags||[]).join(', '))}">+${moreTags}</span>` : '');
    const isTop = (filters.sort || 'lifetime_spend_desc') === 'lifetime_spend_desc' && idx < TOP_CUSTOMER_THRESHOLD;
    const starBadge = isTop ? `<span class="top-customer-star" title="Top customer by lifetime spend">★</span>` : '';
    return `<tr>
      <td><a href="/customers/${h(numId)}" class="link-strong">${h(c.displayName)}</a>${starBadge}<br><small>${h(c.email)}</small></td>
      <td class="text-muted">${h(location)}</td>
      <td><div class="tags-mini">${tagBadges}</div></td>
      <td class="text-right mono">${fmtMoney(c.amountSpent?.amount, c.amountSpent?.currencyCode)}</td>
      <td class="text-right"><a href="/orders?customer=${h(numId)}" class="link">${c.numberOfOrders || 0}</a></td>
      <td>${dropship ? '<span class="badge badge-dropship">Dropship</span>' : ''}</td>
      <td><a href="/customers/${h(numId)}" class="table-action">View →</a></td>
    </tr>`;
  }).join('');

  const emptyRow = customers.length === 0
    ? `<tr><td colspan="7" class="empty-state">No customers found</td></tr>`
    : '';

  const currentParams = new URLSearchParams();
  if (filters.q)       currentParams.set('q', filters.q);
  if (filters.segment) currentParams.set('segment', filters.segment);
  if (filters.tag)     currentParams.set('tag', filters.tag);
  if (filters.sort)    currentParams.set('sort', filters.sort);
  const nextParams = new URLSearchParams(currentParams);
  if (endCursor) nextParams.set('after', endCursor);

  const segmentChips = [
    { value: '',           label: 'All' },
    { value: 'b2b',        label: 'B2B-tagged' },
    { value: 'sparklayer', label: 'SparkLayer' },
    { value: 'has_orders', label: 'Has orders' },
    { value: 'no_orders',  label: 'No orders' },
  ].map(c => {
    const p = new URLSearchParams(currentParams);
    if (c.value) p.set('segment', c.value); else p.delete('segment');
    p.delete('after');
    const active = (filters.segment || '') === c.value;
    return `<a href="/customers?${p}" class="filter-chip${active ? ' filter-chip-active' : ''}">${h(c.label)}</a>`;
  }).join('');

  const sortOptions = [
    { value: 'lifetime_spend_desc', label: 'Lifetime spend ↓' },
    { value: 'orders_desc',         label: 'Order count ↓' },
    { value: 'name_asc',            label: 'Name A–Z' },
  ];
  const currentSort = filters.sort || 'lifetime_spend_desc';

  return layout({ title: 'Customers', session, activePath: '/customers', content: `
    <div class="page-header-row"><h1>Customers</h1></div>
    ${error ? `<div class="alert alert-warning">Shopify unavailable: ${h(error)}</div>` : ''}
    <div class="filter-chips">${segmentChips}</div>
    <form class="filter-bar" method="GET" action="/customers">
      ${filters.segment ? `<input type="hidden" name="segment" value="${h(filters.segment)}">` : ''}
      <input type="search" name="q" value="${h(filters.q||'')}" placeholder="Name, email, phone…" class="filter-input search-input">
      <select name="tag" class="filter-select">
        <option value="">All tags</option>
        <option value="b2b-tier:gold"   ${filters.tag==='b2b-tier:gold'?'selected':''}>Gold tier</option>
        <option value="b2b-tier:silver" ${filters.tag==='b2b-tier:silver'?'selected':''}>Silver tier</option>
        <option value="b2b-dropship"    ${filters.tag==='b2b-dropship'?'selected':''}>Dropship</option>
      </select>
      <select name="sort" class="filter-select" onchange="this.form.submit()">
        ${sortOptions.map(o => `<option value="${h(o.value)}"${currentSort===o.value?' selected':''}>${h(o.label)}</option>`).join('')}
      </select>
      <button type="submit" class="btn btn-secondary">Filter</button>
      <a href="/customers" class="btn btn-ghost">Clear</a>
    </form>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>Customer</th><th>Location</th><th>Tags</th>
          <th class="text-right">Lifetime Spend</th><th class="text-right">Orders</th>
          <th>Dropship</th><th></th>
        </tr></thead>
        <tbody>${rows}${emptyRow}</tbody>
      </table>
    </div>
    <div class="pagination">
      <span class="text-muted">${customers.length} customer${customers.length !== 1 ? 's' : ''}</span>
      ${hasNextPage ? `<a href="/customers?${nextParams}" class="btn btn-ghost">Next 50 →</a>` : ''}
    </div>
  ` });
}

// ── Customer detail ───────────────────────────────────────────────────────────
async function getCustomerDetail(numericId) {
  if (MOCK) {
    const gid = shopifyCustomerGid(numericId);
    return MOCK_CUSTOMERS.find(c => c.id === gid) || null;
  }
  try {
    const result = await shopifyFetch(`
      query($id:ID!){ customer(id:$id){
        id email displayName phone tags numberOfOrders
        amountSpent{amount currencyCode}
        addresses(first:5){id firstName lastName address1 city province zip country}
        defaultAddress{id firstName lastName address1 city province zip country phone}
        metafields(first:20,namespace:"b2b"){edges{node{id namespace key value type}}}
      }}`, { id: shopifyCustomerGid(numericId) });
    return result.data?.customer || null;
  } catch (err) {
    console.error('getCustomerDetail error:', err.message);
    return null;
  }
}

async function getCustomerRecentOrders(customerId) {
  // Phase 24D: cache first
  if (!MOCK) {
    try {
      const stats = getOrdersCacheStats();
      if (stats && stats.total > 0) {
        const cached = getCustomerOrdersFromCache(customerId);
        return cached.slice(0, 10).map(o => ({
          id: o.gid,
          name: o.name,
          processedAt: new Date(o.processed_at || o.created_at).toISOString(),
          displayFinancialStatus: o.financial_status || o.display_financial_status,
          displayFulfillmentStatus: o.fulfillment_status || o.display_fulfillment_status,
          totalPriceSet: { presentmentMoney: { amount: String(o.total_price || 0), currencyCode: o.currency || 'USD' } },
          lineItems: { edges: [] },
          _fromCache: true,
        }));
      }
    } catch (e) {
      console.error('recent orders cache failed, falling back to live:', e.message);
    }
  }
  if (MOCK) {
    const gid = shopifyCustomerGid(customerId);
    return MOCK_ORDERS.filter(o => o.customer?.id === gid).slice(0, 10);
  }
  try {
    const result = await shopifyFetch(`
      query($q:String!){ orders(first:10,query:$q,sortKey:PROCESSED_AT,reverse:true){
        edges{node{id name processedAt displayFinancialStatus displayFulfillmentStatus
          totalPriceSet{presentmentMoney{amount currencyCode}}
        }}}}`,
      { q: `customer_id:${customerId}` });
    return result.data?.orders?.edges?.map(e => e.node) || [];
  } catch { return []; }
}

// Phase 10: 4 per-customer fields — discount_pct, dropship_enabled, dropship_margin_pct, allow_order_on_invoice
// min_order_usd and payment_terms are GLOBAL settings only (not per-customer).
async function getB2bConfig(numericId) {
  const defaults = {
    discount_pct:            parseInt(getSetting('b2b_discount_pct') ?? '50', 10),
    dropship_enabled:        false,
    dropship_margin_pct:     30,
    allow_order_on_invoice:  true,
    catalog_access_tags:     null,
  };

  if (MOCK) {
    const inMemory = mockB2bConfigOverrides.get(numericId) || {};
    const gid = shopifyCustomerGid(numericId);
    const cust = MOCK_CUSTOMERS.find(c => c.id === gid);
    const mfs  = cust?.metafields?.edges?.map(e => e.node) || [];
    const fromMf = {};
    const dpStr   = mfs.find(m => m.key === 'discount_pct')?.value;
    const deStr   = mfs.find(m => m.key === 'dropship_enabled')?.value;
    const dmStr   = mfs.find(m => m.key === 'dropship_margin_pct')?.value;
    const aoiStr  = mfs.find(m => m.key === 'allow_order_on_invoice')?.value;
    const catStr  = mfs.find(m => m.key === 'catalog_access_tags')?.value;
    if (dpStr  !== undefined) fromMf.discount_pct           = parseInt(dpStr, 10);
    if (deStr  !== undefined) fromMf.dropship_enabled       = deStr === 'true';
    if (dmStr  !== undefined) fromMf.dropship_margin_pct    = parseInt(dmStr, 10);
    if (aoiStr !== undefined) fromMf.allow_order_on_invoice = aoiStr !== 'false';
    if (catStr !== undefined) fromMf.catalog_access_tags    = catStr || null;

    const overrides = { ...fromMf, ...inMemory };
    for (const k of Object.keys(inMemory)) {
      if (inMemory[k] === null) delete overrides[k];
    }
    return {
      effective: {
        discount_pct:            overrides.discount_pct           ?? defaults.discount_pct,
        dropship_enabled:        overrides.dropship_enabled       ?? defaults.dropship_enabled,
        dropship_margin_pct:     overrides.dropship_margin_pct    ?? defaults.dropship_margin_pct,
        allow_order_on_invoice:  overrides.allow_order_on_invoice ?? defaults.allow_order_on_invoice,
        catalog_access_tags:     overrides.catalog_access_tags    ?? null,
      },
      overrides: {
        discount_pct:            overrides.discount_pct           ?? null,
        dropship_enabled:        overrides.dropship_enabled       ?? null,
        dropship_margin_pct:     overrides.dropship_margin_pct    ?? null,
        allow_order_on_invoice:  overrides.allow_order_on_invoice ?? null,
        catalog_access_tags:     overrides.catalog_access_tags    ?? null,
      },
      defaults,
    };
  }

  try {
    const result = await shopifyFetch(`
      query($id:ID!){customer(id:$id){
        metafields(first:20,namespace:"b2b"){edges{node{id key value type}}}
      }}`, { id: shopifyCustomerGid(numericId) });
    const mfs = result.data?.customer?.metafields?.edges?.map(e => e.node) || [];
    const getVal = k => mfs.find(m => m.key === k)?.value ?? null;
    const dpStr  = getVal('discount_pct');
    const deStr  = getVal('dropship_enabled');
    const dmStr  = getVal('dropship_margin_pct');
    const aoiStr = getVal('allow_order_on_invoice');
    const catStr = getVal('catalog_access_tags');
    const overrides = {
      discount_pct:            dpStr  !== null ? parseInt(dpStr, 10)   : null,
      dropship_enabled:        deStr  !== null ? deStr === 'true'       : null,
      dropship_margin_pct:     dmStr  !== null ? parseInt(dmStr, 10)   : null,
      allow_order_on_invoice:  aoiStr !== null ? aoiStr !== 'false'    : null,
      catalog_access_tags:     catStr || null,
    };
    return {
      effective: {
        discount_pct:            overrides.discount_pct           ?? defaults.discount_pct,
        dropship_enabled:        overrides.dropship_enabled       ?? defaults.dropship_enabled,
        dropship_margin_pct:     overrides.dropship_margin_pct    ?? defaults.dropship_margin_pct,
        allow_order_on_invoice:  overrides.allow_order_on_invoice ?? defaults.allow_order_on_invoice,
        catalog_access_tags:     overrides.catalog_access_tags    ?? null,
      },
      overrides,
      defaults,
    };
  } catch (err) {
    console.error('getB2bConfig error:', err.message);
    return {
      effective: defaults,
      overrides: { discount_pct: null, dropship_enabled: null, dropship_margin_pct: null, allow_order_on_invoice: null, catalog_access_tags: null },
      defaults,
    };
  }
}

async function applyB2bConfigUpdate(numericId, body) {
  const { discount_pct, dropship_enabled, dropship_margin_pct, allow_order_on_invoice, catalog_access_tags } = body;
  const gid = shopifyCustomerGid(numericId);
  if (MOCK) {
    const cur = { ...(mockB2bConfigOverrides.get(numericId) || {}) };
    if (discount_pct !== undefined)
      cur.discount_pct = (discount_pct === null || discount_pct === '') ? null : parseInt(discount_pct, 10);
    if (dropship_enabled !== undefined)
      cur.dropship_enabled = (dropship_enabled === null || dropship_enabled === '') ? null : (dropship_enabled === true || dropship_enabled === 'true' || dropship_enabled === 'on');
    if (dropship_margin_pct !== undefined)
      cur.dropship_margin_pct = (dropship_margin_pct === null || dropship_margin_pct === '') ? null : parseInt(dropship_margin_pct, 10);
    if (allow_order_on_invoice !== undefined)
      cur.allow_order_on_invoice = (allow_order_on_invoice === null || allow_order_on_invoice === '') ? null : (allow_order_on_invoice === true || allow_order_on_invoice === 'true' || allow_order_on_invoice === 'on');
    if (catalog_access_tags !== undefined)
      cur.catalog_access_tags = (catalog_access_tags === null || catalog_access_tags === '') ? null : String(catalog_access_tags).trim();
    mockB2bConfigOverrides.set(numericId, cur);
    return;
  }

  const sets    = [];
  const delKeys = [];
  const fieldDefs = [
    { key: 'discount_pct',           val: discount_pct,           type: 'number_integer' },
    { key: 'dropship_enabled',       val: dropship_enabled,       type: 'boolean' },
    { key: 'dropship_margin_pct',    val: dropship_margin_pct,    type: 'number_integer' },
    { key: 'allow_order_on_invoice', val: allow_order_on_invoice, type: 'boolean' },
    { key: 'catalog_access_tags',    val: catalog_access_tags,    type: 'single_line_text_field' },
  ];
  for (const f of fieldDefs) {
    if (f.val === undefined) continue;
    if (f.val === null || f.val === '') {
      delKeys.push(f.key);
    } else if (f.type === 'boolean') {
      const bval = f.val === true || f.val === 'true' || f.val === 'on';
      sets.push({ ownerId: gid, namespace: 'b2b', key: f.key, value: String(bval), type: 'boolean' });
    } else if (f.type === 'single_line_text_field') {
      sets.push({ ownerId: gid, namespace: 'b2b', key: f.key, value: String(f.val).trim(), type: 'single_line_text_field' });
    } else {
      sets.push({ ownerId: gid, namespace: 'b2b', key: f.key, value: String(parseInt(f.val, 10)), type: 'number_integer' });
    }
  }
  if (sets.length) {
    await shopifyFetch(`mutation metafieldsSet($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{field message} } }`, { m: sets });
  }
  if (delKeys.length) {
    const delInputs = delKeys.map(k => ({ ownerId: gid, namespace: 'b2b', key: k }));
    await shopifyFetch(`mutation metafieldsDelete($m:[MetafieldIdentifierInput!]!){ metafieldsDelete(metafields:$m){ deletedMetafieldIds userErrors{field message} } }`, { m: delInputs });
  }
}

function renderCustomerDetail(session, customer, recentOrders, notes, _dropshipCache, b2bConfig, flash) {
  const numId      = shopifyNumericId(customer.id);

  const flashHtml = flash === 'notes_saved'
    ? `<div class="alert alert-success">Notes saved.</div>`
    : flash === 'dropship_saved' || flash === 'b2b_settings_saved'
    ? `<div class="alert alert-success">B2B customer settings saved.</div>`
    : flash === 'b2b_config_saved'
    ? `<div class="alert alert-success">B2B customer settings saved.</div>`
    : flash === 'tags_added'
    ? `<div class="alert alert-success">Tags updated.</div>`
    : '';

  const recentOrdersHtml = recentOrders.length > 0
    ? `<table class="mini-table"><thead><tr><th>Order</th><th>Date</th><th class="text-right">Amount</th><th>Status</th></tr></thead><tbody>
        ${recentOrders.map(o => `<tr>
          <td><a href="/orders/${shopifyNumericId(o.id)}">${h(o.name)}</a></td>
          <td class="text-muted">${fmtDate(o.processedAt)}</td>
          <td class="text-right mono">${fmtMoney(o.totalPriceSet?.presentmentMoney?.amount)}</td>
          <td><span class="badge badge-${h((o.displayFinancialStatus||'').toLowerCase())}">${h(o.displayFinancialStatus)}</span></td>
        </tr>`).join('')}
      </tbody></table>`
    : '<p class="text-muted small-text">No orders yet</p>';

  const addr = customer.defaultAddress;
  const addrHtml = addr
    ? `${h(addr.firstName||'')} ${h(addr.lastName||'')}<br>
       ${h(addr.address1||'')}${addr.address2?'<br>'+h(addr.address2):''}<br>
       ${h(addr.city||'')}, ${h(addr.province||'')} ${h(addr.zip||'')}<br>${h(addr.country||'')}`
    : '<span class="text-muted">No address on file</span>';

  // Date range presets for spend section
  const now    = new Date();
  const ymd    = d => d.toISOString().split('T')[0];
  const daysAgo = n => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };
  const spendPresets = [
    { label: 'Last 7 days',    from: ymd(daysAgo(7)),   to: ymd(now) },
    { label: 'Last 30 days',   from: ymd(daysAgo(30)),  to: ymd(now) },
    { label: 'Last 90 days',   from: ymd(daysAgo(90)),  to: ymd(now) },
    { label: 'Last 12 months', from: ymd(daysAgo(365)), to: ymd(now) },
    { label: 'Year to date',   from: `${now.getFullYear()}-01-01`, to: ymd(now) },
    { label: 'All time',       from: '2000-01-01', to: ymd(now) },
  ];

  return layout({ title: customer.displayName || 'Customer', session, activePath: '/customers',
    extraHead: `<style>
      .spend-header{display:flex;align-items:baseline;gap:1rem;flex-wrap:wrap;margin-bottom:0.75rem;}
      .spend-lifetime{font-size:1.5rem;font-weight:700;color:#000;}
      .spend-count{color:#666;font-size:0.9rem;}
      .spend-range-bar{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem;}
      .spend-range-totals{display:flex;gap:2rem;margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:#f8f9fa;border-radius:6px;}
      .spend-range-stat{display:flex;flex-direction:column;}
      .spend-range-val{font-size:1.1rem;font-weight:700;}
      .spend-range-lbl{font-size:0.78rem;color:#666;}
      #spend-orders-body tr.voided{opacity:0.5;text-decoration:line-through;}
    </style>`,
    content: `
    <div class="breadcrumb-row"><a href="/customers" class="breadcrumb">← Customers</a></div>
    ${flashHtml}
    <div class="detail-header">
      <div class="detail-header-left">
        <h1>${h(customer.displayName)}</h1>
        <p class="text-muted">${h(customer.email)}${customer.phone ? ' · ' + h(customer.phone) : ''}</p>
      </div>
      <div class="detail-header-actions">
        <a href="/customers/${h(numId)}/activity" class="btn btn-ghost btn-sm" title="View portal activity log">Activity log</a>
        <button class="btn btn-secondary" id="impersonate-btn" type="button" title="Open the B2B portal as this customer">View in Portal</button>
        <a href="/orders/new?customer=${h(numId)}" class="btn btn-primary">+ New Order</a>
      </div>
    </div>

    <!-- Impersonation modal -->
    <div id="impersonate-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1000;align-items:center;justify-content:center">
      <div style="background:#fff;border-radius:10px;padding:1.5rem;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.18)">
        <h2 style="margin:0 0 0.5rem">View portal as customer</h2>
        <p style="color:#555;margin:0 0 1rem">Open the B2B portal as <strong>${h(customer.displayName)}</strong> (${h(customer.email)}). This generates a one-time link valid for 1 hour.</p>
        <label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;cursor:pointer">
          <input type="checkbox" id="impersonate-readonly" checked style="width:16px;height:16px">
          <span>Read-only mode <span style="color:#888;font-size:0.85em">(prevents placing orders or modifying cart)</span></span>
        </label>
        <div id="impersonate-error" style="display:none;color:#b00;margin-bottom:0.75rem;font-size:0.9em"></div>
        <div style="display:flex;gap:0.75rem;justify-content:flex-end">
          <button class="btn btn-ghost" id="impersonate-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" id="impersonate-open" type="button">Open Portal →</button>
        </div>
      </div>
    </div>
    <script>
    (function(){
      var modal = document.getElementById('impersonate-modal');
      var openBtn = document.getElementById('impersonate-btn');
      var cancelBtn = document.getElementById('impersonate-cancel');
      var doOpenBtn = document.getElementById('impersonate-open');
      var roCheck = document.getElementById('impersonate-readonly');
      var errEl = document.getElementById('impersonate-error');
      openBtn.addEventListener('click', function(){ modal.style.display = 'flex'; errEl.style.display = 'none'; });
      cancelBtn.addEventListener('click', function(){ modal.style.display = 'none'; });
      modal.addEventListener('click', function(e){ if(e.target === modal) modal.style.display = 'none'; });
      document.addEventListener('keydown', function(e){ if(e.key === 'Escape') modal.style.display = 'none'; });
      doOpenBtn.addEventListener('click', function(){
        doOpenBtn.disabled = true;
        doOpenBtn.textContent = 'Opening…';
        errEl.style.display = 'none';
        fetch('/api/admin/customers/${h(numId)}/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ read_only: roCheck.checked })
        })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if(!d.ok){ errEl.textContent = d.error || 'Error'; errEl.style.display = ''; doOpenBtn.disabled = false; doOpenBtn.textContent = 'Open Portal →'; return; }
          window.open(d.url, '_blank');
          modal.style.display = 'none';
          doOpenBtn.disabled = false;
          doOpenBtn.textContent = 'Open Portal →';
        })
        .catch(function(e){ errEl.textContent = e.message; errEl.style.display = ''; doOpenBtn.disabled = false; doOpenBtn.textContent = 'Open Portal →'; });
      });
    })();
    </script>
    <div class="detail-grid">
      <div class="detail-main">

        <!-- Phase 19A: Spend section -->
        <div class="card" id="spend-card">
          <div class="card-header"><h2>Spend</h2></div>
          <div class="spend-header">
            <span class="spend-lifetime">${fmtMoney(customer.amountSpent?.amount, customer.amountSpent?.currencyCode)}</span>
            <span class="spend-count">lifetime · ${customer.numberOfOrders || 0} orders</span>
          </div>
          <div class="spend-range-bar">
            <label for="spend-preset" style="font-size:0.85rem;color:#555">Show spend for:</label>
            <select id="spend-preset" class="input input-sm" style="width:auto">
              ${spendPresets.map((p, i) => `<option value="${h(p.from)}|${h(p.to)}"${i === 1 ? ' selected' : ''}>${h(p.label)}</option>`).join('')}
              <option value="custom">Custom range…</option>
            </select>
            <span id="spend-custom-row" style="display:none;gap:0.35rem;align-items:center">
              <input type="date" id="spend-from" class="input input-sm">
              <span>to</span>
              <input type="date" id="spend-to" class="input input-sm">
              <button id="spend-custom-go" class="btn btn-secondary btn-sm">Go</button>
            </span>
          </div>
          <div id="spend-range-totals" class="spend-range-totals">
            <div class="spend-range-stat"><span class="spend-range-val" id="spend-range-total">—</span><span class="spend-range-lbl">in range</span></div>
            <div class="spend-range-stat"><span class="spend-range-val" id="spend-range-count">—</span><span class="spend-range-lbl">orders</span></div>
          </div>
          <div id="spend-orders-wrap">
            <table class="mini-table" id="spend-orders-table" style="display:none">
              <thead><tr><th>Order</th><th>Date</th><th class="text-right">Amount</th><th>Status</th><th></th></tr></thead>
              <tbody id="spend-orders-body"></tbody>
            </table>
            <p id="spend-empty" class="text-muted small-text" style="display:none">No orders in this date range.</p>
            <p id="spend-loading" class="text-muted small-text">Loading…</p>
          </div>
        </div>
        <script>
        (function(){
          var custId = ${JSON.stringify(numId)};
          var preset = document.getElementById('spend-preset');
          var customRow = document.getElementById('spend-custom-row');
          var fromIn = document.getElementById('spend-from');
          var toIn   = document.getElementById('spend-to');
          var goBtn  = document.getElementById('spend-custom-go');
          function fmtMoney(n){ return '$' + parseFloat(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
          function fmtDate(s){ return new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
          function loadSpend(from, to){
            document.getElementById('spend-loading').style.display='';
            document.getElementById('spend-orders-table').style.display='none';
            document.getElementById('spend-empty').style.display='none';
            fetch('/api/admin/customers/' + custId + '/spend?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to))
              .then(r=>r.json()).then(function(d){
                document.getElementById('spend-loading').style.display='none';
                document.getElementById('spend-range-total').textContent = fmtMoney(d.rangeTotal || 0);
                document.getElementById('spend-range-count').textContent = d.rangeCount || 0;
                var tbody = document.getElementById('spend-orders-body');
                tbody.innerHTML = '';
                if (d.orders && d.orders.length > 0) {
                  d.orders.forEach(function(o){
                    var tr = document.createElement('tr');
                    tr.innerHTML =
                      '<td><a href="/orders/' + o.id + '">' + o.name + '</a></td>' +
                      '<td class="text-muted">' + fmtDate(o.processedAt) + '</td>' +
                      '<td class="text-right mono">' + fmtMoney(o.total) + '</td>' +
                      '<td><span class="badge badge-' + (o.financialStatus||'').toLowerCase() + '">' + (o.financialStatus||'—') + '</span></td>' +
                      '<td><a href="/orders/' + o.id + '/invoice.pdf" class="link text-muted small-text">invoice</a></td>';
                    tbody.appendChild(tr);
                  });
                  document.getElementById('spend-orders-table').style.display='';
                } else {
                  document.getElementById('spend-empty').style.display='';
                }
              }).catch(function(){ document.getElementById('spend-loading').textContent='Error loading spend data.'; });
          }
          function applyPreset(){
            var v = preset.value;
            if(v==='custom'){ customRow.style.display='flex'; return; }
            customRow.style.display='none';
            var parts = v.split('|');
            loadSpend(parts[0], parts[1]);
          }
          preset.addEventListener('change', applyPreset);
          goBtn && goBtn.addEventListener('click', function(){
            if(fromIn.value && toIn.value) loadSpend(fromIn.value, toIn.value);
          });
          applyPreset();
        })();
        </script>

        <div class="card">
          <div class="card-header">
            <h2>Recent Orders</h2>
            <a href="/orders?q=${h(customer.email)}" class="widget-link">All orders →</a>
          </div>
          ${recentOrdersHtml}
        </div>
        <div class="card">
          <div class="card-header"><h2>Internal Notes</h2></div>
          <form method="POST" action="/customers/${h(numId)}/notes">
            <textarea name="body" class="textarea" rows="4" placeholder="Internal notes about this customer (not shown to them)…">${h(notes?.body||'')}</textarea>
            ${notes?.updated_at ? `<p class="text-muted small-text" style="margin-top:0.25rem">Last updated ${fmtDate(new Date(notes.updated_at).toISOString())} by ${h(notes.updated_by)}</p>` : ''}
            <div style="margin-top:0.5rem"><button type="submit" class="btn btn-secondary btn-sm">Save Notes</button></div>
          </form>
        </div>
        <div class="card" id="b2b-settings-card">
          <div class="card-header"><h2>B2B Customer Settings</h2></div>
          <form method="POST" action="/customers/${h(numId)}/b2b-config" id="b2b-settings-form">
            <div class="b2b-settings-grid">
              <div class="b2b-field-row">
                <div>
                  <div class="b2b-field-label">Discount %</div>
                  <div class="b2b-field-help">What percent off MSRP this customer pays. Default ${h(String(b2bConfig.defaults.discount_pct))}% comes from store settings.</div>
                </div>
                <div class="b2b-field-control">
                  <input type="number" name="discount_pct" id="discount_pct"
                    value="${b2bConfig.overrides.discount_pct !== null ? h(String(b2bConfig.overrides.discount_pct)) : ''}"
                    min="0" max="95" step="1" class="input input-sm" style="width:80px"
                    placeholder="${h(String(b2bConfig.defaults.discount_pct))}">
                  <span class="badge ${b2bConfig.overrides.discount_pct !== null ? 'badge-warning' : 'badge-muted'}">
                    ${b2bConfig.overrides.discount_pct !== null ? 'override: ' + h(String(b2bConfig.effective.discount_pct)) + '%' : 'default applied'}
                  </span>
                  ${b2bConfig.overrides.discount_pct !== null ? `<button type="submit" name="discount_pct" value="" class="btn btn-ghost btn-xs">Reset</button>` : ''}
                </div>
              </div>
              <div class="b2b-field-row">
                <div>
                  <div class="b2b-field-label">Drop-ship allowed</div>
                  <div class="b2b-field-help">If on, this customer can ship orders directly to their end customer. Useful for resellers who don't carry inventory.</div>
                </div>
                <div class="b2b-field-control">
                  <label class="toggle-label">
                    <input type="checkbox" name="dropship_enabled" id="dropship_enabled" class="toggle"
                      ${b2bConfig.effective.dropship_enabled ? 'checked' : ''}
                      onchange="document.getElementById('dropship_margin_pct').disabled=!this.checked">
                  </label>
                </div>
              </div>
              <div class="b2b-field-row">
                <div>
                  <div class="b2b-field-label">Drop-ship discount %</div>
                  <div class="b2b-field-help">Discount on drop-ship orders only (separate from standard discount). Typical 25–35%.</div>
                </div>
                <div class="b2b-field-control">
                  <input type="number" name="dropship_margin_pct" id="dropship_margin_pct"
                    value="${h(String(b2bConfig.effective.dropship_margin_pct ?? 30))}"
                    min="0" max="95" step="1" class="input input-sm" style="width:80px"
                    ${!b2bConfig.effective.dropship_enabled ? 'disabled' : ''}>
                </div>
              </div>
              <div class="b2b-field-row">
                <div>
                  <div class="b2b-field-label">Allow order on invoice</div>
                  <div class="b2b-field-help">If on, customer can place orders without upfront payment — we invoice them. If off, must pay at checkout.</div>
                </div>
                <div class="b2b-field-control">
                  <label class="toggle-label">
                    <input type="checkbox" name="allow_order_on_invoice" id="allow_order_on_invoice" class="toggle"
                      ${b2bConfig.effective.allow_order_on_invoice !== false ? 'checked' : ''}>
                  </label>
                </div>
              </div>
            </div>
              <div class="b2b-field-row">
                <div>
                  <div class="b2b-field-label">Custom catalog tags</div>
                  <div class="b2b-field-help">Comma-separated private product tags this customer can access (e.g. <code>private-acme,deerskin-trade</code>). Products with these tags are hidden from customers who don't have them listed here.</div>
                </div>
                <div class="b2b-field-control">
                  <input type="text" name="catalog_access_tags" id="catalog_access_tags"
                    value="${h(b2bConfig.effective.catalog_access_tags || '')}"
                    class="input input-sm" style="width:240px"
                    placeholder="e.g. private-acme,deerskin-trade">
                  ${b2bConfig.effective.catalog_access_tags ? `<button type="submit" name="catalog_access_tags" value="" class="btn btn-ghost btn-xs">Clear</button>` : ''}
                </div>
              </div>
            <div style="margin-top:1rem"><button type="submit" class="btn btn-primary btn-sm">Save changes</button></div>
          </form>
        </div>
      </div>
      <div class="detail-side">
        <div class="card">
          <div class="card-header"><h2>Summary</h2></div>
          <div class="kv-list">
            <div class="kv-row"><span>Lifetime spend</span><strong>${fmtMoney(customer.amountSpent?.amount, customer.amountSpent?.currencyCode)}</strong></div>
            <div class="kv-row"><span>Orders</span><strong>${customer.numberOfOrders||0}</strong></div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h2>Default Address</h2></div>
          <p class="address-block">${addrHtml}</p>
        </div>
        <div class="card">
          <div class="card-header"><h2>Tags</h2>
            <button class="btn btn-ghost btn-xs" id="tag-add-btn" type="button">+ Add</button>
          </div>
          <div class="tags-list" id="tags-list">
            ${(customer.tags||[]).map(t => `
              <form method="POST" action="/customers/${h(numId)}/tags/remove" style="display:inline">
                <input type="hidden" name="tag" value="${h(t)}">
                <span class="tag">${h(t)} <button type="submit" class="tag-remove" title="Remove tag" onclick="return confirm('Remove tag ${h(t)}?')">×</button></span>
              </form>`).join(' ')}
          </div>
          <form method="POST" action="/customers/${h(numId)}/tags/add" id="tag-add-form" hidden style="margin-top:0.5rem;display:flex;gap:0.5rem">
            <input type="text" name="tag" placeholder="New tag…" class="input input-sm" style="flex:1">
            <button type="submit" class="btn btn-secondary btn-sm">Add</button>
          </form>
          <script>
          (function(){
            var btn  = document.getElementById('tag-add-btn');
            var form = document.getElementById('tag-add-form');
            if(btn && form){ btn.addEventListener('click',function(){ form.hidden=false; form.querySelector('input').focus(); }); }
          })();
          </script>
        </div>
        <!-- Phase 19D: Active cart card -->
        <div class="card" id="active-cart-card">
          <div class="card-header"><h2>Active cart</h2></div>
          <div id="active-cart-body"><span class="text-muted small-text">Loading…</span></div>
          <script>
          (function(){
            var el = document.getElementById('active-cart-body');
            fetch('/api/admin/customers/${h(numId)}/active-cart')
              .then(function(r){ return r.json(); })
              .then(function(d){
                if(!d.items || d.items.length === 0){
                  el.innerHTML = '<span class="text-muted small-text">No active cart</span>';
                  return;
                }
                var itemsHtml = d.items.map(function(i){
                  return '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;font-size:13px">' +
                    '<span>' + (i.productTitle||'').replace(/</g,'&lt;') + (i.variantTitle ? ' — ' + i.variantTitle.replace(/</g,'&lt;') : '') + ' × ' + i.quantity + '</span>' +
                    '<span style="font-weight:600;white-space:nowrap;margin-left:8px">$' + (i.lineTotal||0).toFixed(2) + '</span>' +
                    '</div>';
                }).join('');
                var updatedAgo = d.updatedAt ? (function(ts){
                  var m = Math.floor((Date.now()-ts)/60000);
                  if(m < 1) return 'just now';
                  if(m < 60) return m + 'm ago';
                  var h = Math.floor(m/60);
                  if(h < 24) return h + 'h ago';
                  return Math.floor(h/24) + 'd ago';
                })(d.updatedAt) : '';
                el.innerHTML = itemsHtml +
                  '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);display:flex;justify-content:space-between">' +
                    '<span class="text-muted small-text">' + d.items.length + ' item' + (d.items.length!==1?'s':'') + (updatedAgo ? ' · ' + updatedAgo : '') + '</span>' +
                    '<strong>$' + (d.subtotal||0).toFixed(2) + '</strong>' +
                  '</div>' +
                  '<div style="margin-top:8px;display:flex;gap:6px">' +
                    '<a href="/orders/new?customer=${h(numId)}" class="btn btn-ghost btn-xs" title="Pre-populate new order from cart">Convert to order…</a>' +
                  '</div>';
              })
              .catch(function(){ el.innerHTML = '<span class="text-muted small-text">Unavailable</span>'; });
          })();
          </script>
        </div>
        <!-- Phase 21D: Xero sync status card -->
        <div class="card" id="xero-customer-card">
          <div class="card-header"><h2>Xero</h2></div>
          <div id="xero-customer-status">
            <span class="text-muted small-text">Loading…</span>
          </div>
          <script>
          (function(){
            var el = document.getElementById('xero-customer-status');
            fetch('/api/admin/customers/${h(numId)}/xero-status')
              .then(function(r){ return r.json(); })
              .then(function(d){
                var html = '';
                if(d.state === 'synced'){
                  html = '<span style="color:var(--lime);font-weight:600">✓ Synced</span>' +
                    ' <a href="https://go.xero.com/Contacts/View/'+encodeURIComponent(d.xeroContactId)+'" target="_blank" class="text-muted small-text" style="font-size:11px" title="'+d.xeroContactId+'">' +
                    d.xeroContactId.slice(0,8)+'…</a>' +
                    (d.xeroName ? '<br><span class="text-muted small-text">'+d.xeroName+'</span>' : '') +
                    '<br><form method="POST" action="/api/admin/customers/${h(numId)}/xero-sync" style="margin-top:6px"><button class="btn btn-ghost btn-xs" type="submit">↻ Re-sync</button></form>';
                } else if(d.state === 'merged'){
                  html = '<span style="color:var(--lime);font-weight:600">⚭ Merged contact</span>' +
                    '<br><span class="text-muted small-text">Invoices for this customer post to <strong>'+d.xeroName+'</strong>.</span>' +
                    (d.primaryShopifyId ? '<br><a href="/customers/'+d.primaryShopifyId+'" class="small-text">View primary →</a>' : '');
                } else if(d.state === 'insider'){
                  html = '<span style="color:#999">⊘ Insider — sync not applicable</span>';
                } else {
                  html = '<span style="color:var(--orange)">⚠ Not synced</span>' +
                    '<br><form method="POST" action="/api/admin/customers/${h(numId)}/xero-sync" style="margin-top:6px"><button class="btn btn-secondary btn-xs" type="submit">Sync to Xero</button></form>';
                }
                el.innerHTML = html;
              })
              .catch(function(){ el.innerHTML = '<span class="text-muted small-text">Could not load Xero status.</span>'; });
          })();
          </script>
        </div>
      </div>
    </div>
  ` });
}

// ── Manual order form ─────────────────────────────────────────────────────────
function renderNewOrderForm(session, prefillCustomer) {
  const customerJson = prefillCustomer ? JSON.stringify({ id: shopifyNumericId(prefillCustomer.id), name: prefillCustomer.displayName, email: prefillCustomer.email }) : 'null';
  return layout({ title: 'New Order', session, activePath: '/orders',
    extraHead: `<style>
      .order-form-grid{display:grid;grid-template-columns:1fr 320px;gap:1rem;}
      #line-items-table tbody tr td{padding:0.35rem 0.5rem;}
      .price-override{width:90px;}
      .qty-input{width:60px;}
      @media(max-width:700px){.order-form-grid{grid-template-columns:1fr;}}
    </style>`,
    content: `
    <div class="breadcrumb-row"><a href="/orders" class="breadcrumb">← Orders</a></div>
    <div class="page-header-row"><h1>New Order</h1></div>
    <form id="order-form" method="POST" action="/orders/new">
      <input type="hidden" name="customer_id" id="customer_id_hidden">
      <input type="hidden" name="line_items" id="line_items_hidden" value="[]">
      <div class="order-form-grid">
        <div>
          <div class="card">
            <div class="card-header"><h2>Customer</h2></div>
            <div style="position:relative">
              <input type="text" id="customer-search" class="input" placeholder="Search customer by name or email…" autocomplete="off">
              <div id="customer-results" class="autocomplete-dropdown" hidden></div>
            </div>
            <div id="customer-selected" class="selected-item" hidden></div>
          </div>
          <div class="card" style="margin-top:1rem">
            <div class="card-header"><h2>Line Items</h2></div>
            <div style="position:relative;margin-bottom:0.75rem">
              <input type="text" id="product-search" class="input" placeholder="Search product by title or SKU…" autocomplete="off">
              <div id="product-results" class="autocomplete-dropdown" hidden></div>
            </div>
            <table class="data-table" id="line-items-table">
              <thead><tr><th>Product</th><th>SKU</th><th>Qty</th><th>List Price</th><th>B2B Price</th><th></th></tr></thead>
              <tbody id="line-items-body"><tr id="empty-row"><td colspan="6" class="empty-state">Add line items above</td></tr></tbody>
            </table>
            <div class="totals-block" id="order-totals" style="margin-top:0"></div>
          </div>
          <div class="card" style="margin-top:1rem">
            <div class="card-header"><h2>Notes &amp; PO</h2></div>
            <div class="form-row">
              <label for="order-po">PO Number</label>
              <input type="text" id="order-po" name="po_number" class="input" placeholder="Optional PO #">
            </div>
            <div class="form-row" style="margin-top:0.5rem">
              <label for="order-note">Order Note</label>
              <textarea id="order-note" name="note" class="textarea" rows="3" placeholder="Internal note / instructions…"></textarea>
            </div>
          </div>
        </div>
        <div>
          <div class="card">
            <div class="card-header"><h2>Shipping Address</h2></div>
            <div id="default-addr-msg" class="text-muted small-text" style="margin-bottom:0.5rem">Select a customer to auto-fill.</div>
            <div class="form-row"><label>First Name</label><input type="text" name="ship_first" class="input" id="ship-first"></div>
            <div class="form-row"><label>Last Name</label><input type="text" name="ship_last" class="input" id="ship-last"></div>
            <div class="form-row"><label>Address 1</label><input type="text" name="ship_addr1" class="input" id="ship-addr1"></div>
            <div class="form-row"><label>Address 2</label><input type="text" name="ship_addr2" class="input" id="ship-addr2"></div>
            <div class="form-row"><label>City</label><input type="text" name="ship_city" class="input" id="ship-city"></div>
            <div class="form-row"><label>Province/State</label><input type="text" name="ship_province" class="input" id="ship-province"></div>
            <div class="form-row"><label>ZIP</label><input type="text" name="ship_zip" class="input" id="ship-zip"></div>
            <div class="form-row"><label>Country</label><input type="text" name="ship_country" class="input" id="ship-country" value="US"></div>
          </div>
          <div class="card" style="margin-top:1rem">
            <div class="card-header"><h2>Submit</h2></div>
            <p class="text-muted small-text" style="margin-bottom:0.75rem">Order will be created as a draft and completed with payment pending.</p>
            <button type="submit" id="submit-btn" class="btn btn-primary" style="width:100%" disabled>Create Order</button>
            <p id="submit-error" class="text-muted small-text" style="margin-top:0.5rem;color:var(--red)"></p>
          </div>
        </div>
      </div>
    </form>
    <script>
    (function(){
      var lineItems = [];
      var selectedCustomer = ${customerJson};
      var customerIdHidden = document.getElementById('customer_id_hidden');
      var lineItemsHidden  = document.getElementById('line_items_hidden');
      var submitBtn = document.getElementById('submit-btn');
      var submitError = document.getElementById('submit-error');

      if(selectedCustomer){
        customerIdHidden.value = selectedCustomer.id;
        document.getElementById('customer-selected').hidden = false;
        document.getElementById('customer-selected').innerHTML =
          '<strong>'+esc(selectedCustomer.name)+'</strong> &lt;'+esc(selectedCustomer.email)+'&gt; '+
          '<button type="button" onclick="clearCustomer()" class="btn btn-ghost btn-xs">×</button>';
        document.getElementById('customer-search').hidden = true;
      }

      function esc(s){ var d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

      function updateSubmitBtn(){
        var ok = selectedCustomer && lineItems.length>0 && lineItems.every(function(l){return l.qty>0;});
        submitBtn.disabled = !ok;
        submitError.textContent = !selectedCustomer ? 'Select a customer first.' : lineItems.length===0 ? 'Add at least one line item.' : '';
      }

      function updateTotals(){
        var total = lineItems.reduce(function(s,l){ return s + parseFloat(l.price||0)*parseInt(l.qty||0,10); }, 0);
        document.getElementById('order-totals').innerHTML = total>0
          ? '<div class="totals-row totals-total"><span>Est. Total</span><span>'+fmt(total)+'</span></div>' : '';
        lineItemsHidden.value = JSON.stringify(lineItems);
        updateSubmitBtn();
      }

      function fmt(n){ return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n); }

      // Render line items table
      function renderLineItems(){
        var tbody = document.getElementById('line-items-body');
        if(lineItems.length===0){
          tbody.innerHTML = '<tr id="empty-row"><td colspan="6" class="empty-state">Add line items above</td></tr>';
          return;
        }
        tbody.innerHTML = lineItems.map(function(li,i){
          return '<tr>'+
            '<td>'+esc(li.title)+'</td>'+
            '<td class="mono">'+esc(li.sku||'—')+'</td>'+
            '<td><input type="number" class="qty-input" value="'+li.qty+'" min="1" data-idx="'+i+'" onchange="setQty('+i+',this.value)"></td>'+
            '<td class="text-right mono">'+fmt(parseFloat(li.listPrice||0))+'</td>'+
            '<td><input type="text" class="price-override" value="'+li.price+'" data-idx="'+i+'" onchange="setPrice('+i+',this.value)"></td>'+
            '<td><button type="button" class="btn btn-ghost btn-xs" onclick="removeItem('+i+')">×</button></td>'+
          '</tr>';
        }).join('');
      }

      window.setQty = function(i,v){ lineItems[i].qty=Math.max(1,parseInt(v,10)||1); renderLineItems(); updateTotals(); };
      window.setPrice = function(i,v){ lineItems[i].price=parseFloat(v)||0; updateTotals(); };
      window.removeItem = function(i){ lineItems.splice(i,1); renderLineItems(); updateTotals(); };
      window.clearCustomer = function(){
        selectedCustomer=null; customerIdHidden.value='';
        document.getElementById('customer-selected').hidden=true;
        document.getElementById('customer-search').hidden=false;
        updateSubmitBtn();
      };

      // Autocomplete helper
      function setupAutocomplete(inputId, resultsId, url, onSelect){
        var input   = document.getElementById(inputId);
        var results = document.getElementById(resultsId);
        var timer   = null;
        input.addEventListener('input',function(){
          clearTimeout(timer);
          var q = input.value.trim();
          if(!q){ results.hidden=true; return; }
          timer = setTimeout(function(){
            fetch(url+'?q='+encodeURIComponent(q))
              .then(function(r){return r.json();})
              .then(function(data){
                if(!data.length){ results.hidden=true; return; }
                results.innerHTML = data.map(function(item){
                  return '<div class="autocomplete-item" data-json=\''+JSON.stringify(item).replace(/'/g,"&apos;")+'\'>'
                    + esc(item.label) + (item.sublabel?'<small>'+esc(item.sublabel)+'</small>':'') + '</div>';
                }).join('');
                results.hidden=false;
              }).catch(function(){ results.hidden=true; });
          },250);
        });
        results.addEventListener('click',function(e){
          var item = e.target.closest('.autocomplete-item');
          if(!item) return;
          var data = JSON.parse(item.dataset.json.replace(/&apos;/g,"'"));
          results.hidden=true; input.value='';
          onSelect(data);
        });
        document.addEventListener('click',function(e){ if(!input.contains(e.target)&&!results.contains(e.target)) results.hidden=true; });
      }

      setupAutocomplete('customer-search','customer-results','/api/customers/search',function(c){
        selectedCustomer={id:c.id,name:c.label,email:c.sublabel};
        customerIdHidden.value=c.id;
        document.getElementById('customer-selected').hidden=false;
        document.getElementById('customer-selected').innerHTML=
          '<strong>'+esc(c.label)+'</strong> &lt;'+esc(c.sublabel||'')+'&gt; '+
          '<button type="button" onclick="clearCustomer()" class="btn btn-ghost btn-xs">×</button>';
        document.getElementById('customer-search').hidden=true;
        // Fill shipping address from customer default
        if(c.address){
          var a=c.address;
          document.getElementById('ship-first').value=a.firstName||'';
          document.getElementById('ship-last').value=a.lastName||'';
          document.getElementById('ship-addr1').value=a.address1||'';
          document.getElementById('ship-addr2').value=a.address2||'';
          document.getElementById('ship-city').value=a.city||'';
          document.getElementById('ship-province').value=a.province||'';
          document.getElementById('ship-zip').value=a.zip||'';
          document.getElementById('ship-country').value=a.country||'US';
          document.getElementById('default-addr-msg').textContent='Auto-filled from customer default address.';
        }
        updateSubmitBtn();
      });

      setupAutocomplete('product-search','product-results','/api/products/search',function(p){
        // p: {id, label, sublabel, variantId, sku, price}
        var exists = lineItems.findIndex(function(l){ return l.variantId===p.variantId; });
        if(exists>=0){ lineItems[exists].qty++; }
        else {
          lineItems.push({ variantId:p.variantId, title:p.label, sku:p.sku||'', listPrice:parseFloat(p.price||0), price:(parseFloat(p.price||0)*0.5).toFixed(2), qty:1 });
        }
        renderLineItems(); updateTotals();
      });

      // Form submit: validate
      document.getElementById('order-form').addEventListener('submit',function(e){
        if(!selectedCustomer||lineItems.length===0){ e.preventDefault(); updateSubmitBtn(); return; }
        lineItemsHidden.value=JSON.stringify(lineItems);
      });

      updateSubmitBtn();
    })();
    </script>
  ` });
}

async function submitNewOrder(req, session) {
  const { customer_id, line_items, note, po_number,
          ship_first, ship_last, ship_addr1, ship_addr2,
          ship_city, ship_province, ship_zip, ship_country } = req.body;
  let lineItemsParsed = [];
  try { lineItemsParsed = JSON.parse(line_items || '[]'); } catch {}

  if (!customer_id || !lineItemsParsed.length) {
    return { error: 'Missing customer or line items' };
  }

  const shippingAddress = {
    firstName: ship_first || '', lastName: ship_last || '',
    address1: ship_addr1 || '', address2: ship_addr2 || '',
    city: ship_city || '', province: ship_province || '',
    zip: ship_zip || '', country: ship_country || 'US',
  };

  const orderNote = [note || '', po_number ? `PO: ${po_number}` : ''].filter(Boolean).join('\n');

  if (MOCK) {
    auditLog(session.email, 'create_draft_order', `mock-customer-${customer_id}`, null, { customer_id, lineItemsParsed, shippingAddress });
    return { orderId: 'MOCK-9999', orderName: '#MOCK-9999', ok: true };
  }

  try {
    const gidCustomer = shopifyCustomerGid(customer_id);
    const draftInput = {
      customerId: gidCustomer,
      lineItems: lineItemsParsed.map(li => ({
        variantId: `gid://shopify/ProductVariant/${li.variantId}`,
        quantity: parseInt(li.qty, 10),
        appliedDiscount: li.price && li.listPrice && li.price < li.listPrice
          ? { value: parseFloat((((li.listPrice - li.price) / li.listPrice) * 100).toFixed(2)), valueType: 'PERCENTAGE' }
          : undefined,
      })),
      shippingAddress,
      note: orderNote || null,
      tags: ['b2b-portal', 'b2b-manual-order'],
    };
    const createRes = await shopifyFetch(`
      mutation draftOrderCreate($input:DraftOrderInput!){
        draftOrderCreate(input:$input){ draftOrder{id invoiceUrl} userErrors{field message} }
      }`, { input: draftInput });
    const ue = createRes.data?.draftOrderCreate?.userErrors || [];
    if (ue.length) return { error: ue.map(e => e.message).join('; ') };
    const draftId = createRes.data?.draftOrderCreate?.draftOrder?.id;

    const completeRes = await shopifyFetch(`
      mutation draftOrderComplete($id:ID!,$paymentPending:Boolean!){
        draftOrderComplete(id:$id,paymentPending:$paymentPending){
          draftOrder{order{id name}} userErrors{field message}
        }
      }`, { id: draftId, paymentPending: true });
    const ue2 = completeRes.data?.draftOrderComplete?.userErrors || [];
    if (ue2.length) return { error: ue2.map(e => e.message).join('; ') };
    const order = completeRes.data?.draftOrderComplete?.draftOrder?.order;
    auditLog(session.email, 'create_order', order?.id, null, { customer_id, lineItemCount: lineItemsParsed.length });
    return { orderId: shopifyNumericId(order?.id), orderName: order?.name, ok: true };
  } catch (err) {
    console.error('submitNewOrder error:', err.message);
    return { error: err.message };
  }
}

// ── PWA icon generator ────────────────────────────────────────────────────────
// Creates a minimal RGB PNG at startup (lime green #9BBC0E with "FW" approximated).
function generateIconPng(size, r, g, b) {
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const typeBuf = Buffer.from(type);
    const lenBuf = Buffer.allocUnsafe(4); lenBuf.writeUInt32BE(data.length);
    const crcBuf = Buffer.allocUnsafe(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }
  const rowSize = 1 + size * 3;
  const raw = Buffer.allocUnsafe(size * rowSize);
  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * rowSize + 1 + x * 3;
      raw[i] = r; raw[i+1] = g; raw[i+2] = b;
    }
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ICON_PATH = path.join(__dirname, 'public', 'icon-192.png');
if (!fs.existsSync(ICON_PATH)) {
  fs.writeFileSync(ICON_PATH, generateIconPng(192, 0x9B, 0xBC, 0x0E));
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, app: 'fww-b2b-admin', ts: Date.now() });
});

app.get('/manifest.json', (_req, res) => {
  res.json({
    name: 'FWW Admin',
    short_name: 'FWWadmin',
    start_url: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: '#9BBC0E',
    icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
  });
});

// Mock: seed session
app.get('/__test__/session', (req, res) => {
  if (!MOCK) return res.status(404).json({ error: 'not found' });
  const email = req.query.email || 'alex@fuzzywumpets.com';
  const displayName = req.query.name || 'Alex (Test)';
  const sid = crypto.randomBytes(32).toString('hex');
  createSession(sid, email, displayName, '');
  res.setHeader('Set-Cookie', sessionCookie(sid));
  res.json({ ok: true, sid, email });
});

// Auth
app.get('/auth/login', (req, res) => {
  if (MOCK) {
    const sid = crypto.randomBytes(32).toString('hex');
    createSession(sid, 'alex@fuzzywumpets.com', 'Alex (Mock)', '');
    res.setHeader('Set-Cookie', sessionCookie(sid));
    return res.redirect('/');
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: 'code', scope: 'openid email profile',
    access_type: 'offline', prompt: 'select_account', state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  if (MOCK) return res.redirect('/');
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/login?error=${encodeURIComponent('Google: ' + error)}`);
  const storedState = getCookie(req, 'oauth_state');
  if (!state || state !== storedState)
    return res.redirect('/login?error=Invalid+OAuth+state+%E2%80%94+please+try+again');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET }),
    });
    if (!tokenRes.ok) return res.redirect('/login?error=OAuth+token+exchange+failed');
    const tokens = await tokenRes.json();
    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!userRes.ok) return res.redirect('/login?error=Failed+to+fetch+user+info');
    const user = await userRes.json();
    if (!user.email_verified) return res.redirect('/login?error=Google+email+not+verified');
    const emailLower = (user.email || '').toLowerCase();
    if (!ALLOWED_EMAILS.some(e => e.toLowerCase() === emailLower))
      return res.status(403).send(renderUnauthorized(user.email));
    const sid = crypto.randomBytes(32).toString('hex');
    createSession(sid, user.email, user.name || user.email, user.picture || '');
    auditLog(user.email, 'login', null, null, { ip: req.ip });
    res.setHeader('Set-Cookie', ['oauth_state=; Path=/; HttpOnly; Max-Age=0', sessionCookie(sid)]);
    res.redirect('/');
  } catch (err) {
    res.redirect(`/login?error=${encodeURIComponent('Authentication error: ' + err.message)}`);
  }
});

app.get('/auth/logout', (req, res) => {
  const sid = getCookie(req, COOKIE_NAME);
  if (sid) {
    const session = getSession(sid);
    if (session) { auditLog(session.email, 'logout', null, null, null); deleteSession(sid); }
  }
  res.setHeader('Set-Cookie', sessionCookie(null, true));
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (getSession(getCookie(req, COOKIE_NAME))) return res.redirect('/');
  res.send(renderLogin(req.query.error || null));
});

// Dashboard
app.get('/', requireAuth, async (req, res) => {
  try {
    const data = await getDashboardData();
    res.send(renderDashboard(req.adminSession, data));
  } catch (err) {
    res.status(500).send(renderDashboard(req.adminSession, { error: err.message, openOrdersCount:0, openOrders:[], weekOrdersCount:0, topCustomers:[], lowStockItems:[] }));
  }
});

// ── Orders ──
// MUST define /orders/new and /orders/bulk BEFORE /orders/:id
app.get('/orders', requireAuth, async (req, res) => {
  const filters = { q: req.query.q || '', source: req.query.source || '', status: req.query.status || '', date: req.query.date || '', after: req.query.after || '', success: req.query.success || '' };
  const data = await getOrdersData(filters);
  res.send(renderOrdersList(req.adminSession, data, filters));
});

app.get('/orders/new', requireAuth, async (req, res) => {
  let prefillCustomer = null;
  if (req.query.customer) {
    prefillCustomer = MOCK ? MOCK_CUSTOMERS.find(c => shopifyNumericId(c.id) === req.query.customer) || null : await getCustomerDetail(req.query.customer);
  }
  res.send(renderNewOrderForm(req.adminSession, prefillCustomer));
});

app.post('/orders/new', requireAuth, async (req, res) => {
  const result = await submitNewOrder(req, req.adminSession);
  if (result.error) {
    res.status(400).send(layout({ title: 'New Order', session: req.adminSession, activePath: '/orders',
      content: `<div class="breadcrumb-row"><a href="/orders">← Orders</a></div>
        <div class="alert alert-error">${h(result.error)}</div>
        <a href="/orders/new" class="btn btn-secondary">← Try again</a>` }));
    return;
  }
  res.redirect(`/orders/${result.orderId}?success=created`);
});

app.post('/orders/bulk', requireAuth, async (req, res) => {
  const { action, ids } = req.body;
  const idList = Array.isArray(ids) ? ids : (ids ? [ids] : []);
  if (!idList.length) return res.redirect('/orders');

  if (action === 'mark-paid') {
    for (const numId of idList) {
      if (MOCK) {
        const prev = mockOrderOverrides.get(numId) || {};
        mockOrderOverrides.set(numId, { ...prev, displayFinancialStatus: 'PAID' });
      } else {
        try {
          await shopifyFetch(`mutation orderMarkAsPaid($input:OrderMarkAsPaidInput!){
            orderMarkAsPaid(input:$input){ order{id displayFinancialStatus} userErrors{field message} }
          }`, { input: { id: shopifyOrderGid(numId) } });
        } catch (err) { console.error('bulk mark-paid error:', err.message); }
      }
      auditLog(req.adminSession.email, 'mark_paid', shopifyOrderGid(numId), null, null);
    }
  }
  res.redirect('/orders?success=marked_paid');
});

// Phase 4: Orders CSV export (must be before /orders/:id to avoid route conflict)
app.get('/orders/export.csv', requireAuth, async (req, res) => {
  const ts = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fww-b2b-orders-${ts}.csv"`);
  res.write(csvLine(['order_number','date','customer','email','financial_status','fulfillment_status','total','tags','note']));
  const orders = MOCK
    ? MOCK_ORDERS
    : await (async () => {
        const all = [];
        let after = null;
        for (let page = 0; page < 20; page++) {
          const result = await shopifyFetch(
            `query($q:String!,$first:Int!,$after:String){orders(first:$first,query:$q,after:$after,sortKey:PROCESSED_AT,reverse:true){edges{cursor node{name processedAt customer{displayName email} displayFinancialStatus displayFulfillmentStatus totalPriceSet{presentmentMoney{amount}} note tags}}pageInfo{hasNextPage endCursor}}}`,
            { q: 'tag:b2b-portal', first: 250, after });
          const edges = result.data?.orders?.edges || [];
          all.push(...edges.map(e => e.node));
          if (!result.data?.orders?.pageInfo?.hasNextPage) break;
          after = result.data.orders.pageInfo.endCursor;
        }
        return all;
      })();
  for (const o of orders) {
    res.write(csvLine([
      o.name,
      o.processedAt ? o.processedAt.slice(0,10) : '',
      o.customer?.displayName || '',
      o.customer?.email || '',
      o.displayFinancialStatus || '',
      o.displayFulfillmentStatus || '',
      o.totalPriceSet?.presentmentMoney?.amount || '',
      Array.isArray(o.tags) ? o.tags.join('|') : (o.tags || ''),
      o.note || '',
    ]));
  }
  res.end();
});

app.get('/orders/:id', requireAuth, async (req, res) => {
  const order = await getOrderDetail(req.params.id);
  if (!order) return res.status(404).send(layout({ title: '404', session: req.adminSession, activePath: '/orders',
    content: '<div class="page-header"><h1>Order not found</h1></div><a href="/orders" class="btn btn-secondary">← Orders</a>' }));
  // Attach visible notes from portal db (readonly)
  const shopifyId = order.id.startsWith('gid://') ? order.id : `gid://shopify/Order/${order.id}`;
  order.visibleNotes = getVisibleNotesForOrder(shopifyId);
  res.send(renderOrderDetail(req.adminSession, order, req.query.success || ''));
});

app.post('/orders/:id/mark-paid', requireAuth, async (req, res) => {
  const numId = req.params.id;
  if (MOCK) {
    const prev = mockOrderOverrides.get(numId) || {};
    mockOrderOverrides.set(numId, { ...prev, displayFinancialStatus: 'PAID' });
  } else {
    try {
      const r = await shopifyFetch(`mutation orderMarkAsPaid($input:OrderMarkAsPaidInput!){
        orderMarkAsPaid(input:$input){ order{id displayFinancialStatus} userErrors{field message} }
      }`, { input: { id: shopifyOrderGid(numId) } });
      const ue = r.data?.orderMarkAsPaid?.userErrors || [];
      if (ue.length) return res.redirect(`/orders/${numId}?error=${encodeURIComponent(ue[0].message)}`);
    } catch (err) {
      return res.redirect(`/orders/${numId}?error=${encodeURIComponent(err.message)}`);
    }
  }
  auditLog(req.adminSession.email, 'mark_paid', shopifyOrderGid(numId), null, null);

  // Trigger Xero payment recording (non-blocking — queue on failure)
  (async () => {
    try {
      const accountMap = getXeroAccountMap();
      const xeroEntry  = getXeroMap(numId);
      let xeroInvoiceId = xeroEntry?.xero_invoice_id;
      if (!xeroInvoiceId) {
        // Try to create invoice first if not yet synced
        const order = await getOrderDetail(numId);
        if (order) xeroInvoiceId = await createXeroInvoice(order, accountMap);
      }
      if (xeroInvoiceId) {
        const order = await getOrderDetail(numId);
        const amount = parseFloat(order?.totalPriceSet?.presentmentMoney?.amount || '0');
        await recordXeroPayment(numId, xeroInvoiceId, amount, null, accountMap.chase_checking);
        auditLog(req.adminSession.email, 'xero:payment_recorded', shopifyOrderGid(numId), null, { xeroInvoiceId, amount });
      }
    } catch (err) {
      console.error('Xero payment record failed (queued):', err.message);
      const xeroEntry = getXeroMap(numId);
      addXeroPending('record_payment', { orderId: numId, xeroInvoiceId: xeroEntry?.xero_invoice_id || null, error: err.message });
    }
  })();

  res.redirect(`/orders/${numId}?success=marked_paid`);
});

app.post('/orders/:id/note', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const note  = String(req.body.note || '').slice(0, 2000);
  if (MOCK) {
    const prev = mockOrderOverrides.get(numId) || {};
    mockOrderOverrides.set(numId, { ...prev, note });
  } else {
    try {
      const r = await shopifyFetch(`mutation orderUpdate($input:OrderInput!){
        orderUpdate(input:$input){ order{id note} userErrors{field message} }
      }`, { input: { id: shopifyOrderGid(numId), note } });
      const ue = r.data?.orderUpdate?.userErrors || [];
      if (ue.length) return res.redirect(`/orders/${numId}?error=${encodeURIComponent(ue[0].message)}`);
    } catch (err) {
      return res.redirect(`/orders/${numId}?error=${encodeURIComponent(err.message)}`);
    }
  }
  auditLog(req.adminSession.email, 'update_note', shopifyOrderGid(numId), null, { note });
  res.redirect(`/orders/${numId}?success=note_saved`);
});

app.post('/orders/:id/send-chase-invoice', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const order = await getOrderDetail(numId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const customerEmail = order.customer?.email || 'unknown';
  // Stub mode: log intent, return success. When Chase API is wired, replace this with real call.
  auditLog(req.adminSession.email, 'chase_invoice_queued', shopifyOrderGid(numId), null, {
    order_name: order.name,
    customer_email: customerEmail,
    note: 'Chase API not yet wired — logged intent only',
  });
  if (req.headers['content-type']?.includes('application/json')) {
    return res.json({ ok: true, status: 'stubbed', message: 'Chase invoice intent logged. Wire Chase API to send real link.' });
  }
  res.redirect(`/orders/${numId}?success=chase_invoice_queued`);
});

app.get('/orders/:id/invoice.pdf', requireAuth, async (req, res) => {
  const order = await getOrderDetail(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  try {
    const pdf = await generateInvoicePdf(order);
    const safeName = (order.name || 'invoice').replace(/[^a-z0-9#-]/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}-invoice.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Phase 16E: Partial invoices ──────────────────────────────────────────────

app.post('/orders/:id/partial-invoice', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const session = req.adminSession;
  const { type = 'full', shipping_handling = 'first' } = req.body;
  const order = await getOrderDetail(numId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const allLineItems = (order.lineItems?.edges || []).map(e => e.node);
  const orderGid     = `gid://shopify/Order/${numId}`;

  // For fulfilled_only: use all line items (fulfillment line detail not tracked in mock/query)
  const lineItems = type === 'fulfilled_only' && (order.fulfillments || []).length > 0
    ? allLineItems  // simplified: treat all items as fulfilled for billing
    : allLineItems;

  const subtotal = lineItems.reduce((sum, item) => {
    const price = parseFloat(item.discountedUnitPriceSet?.presentmentMoney?.amount ?? item.originalUnitPriceSet?.presentmentMoney?.amount ?? 0);
    return sum + price * (item.quantity || 0);
  }, 0);
  const shippingAmt = shipping_handling === 'first'
    ? parseFloat(order.totalShippingPriceSet?.presentmentMoney?.amount || 0)
    : 0;
  const taxAmt  = parseFloat(order.totalTaxSet?.presentmentMoney?.amount || 0);
  const total   = subtotal + shippingAmt + taxAmt;

  const letter = getNextInvoiceLetter(orderGid);
  const invId  = createPartialInvoice({
    orderId: orderGid,
    invoiceLetter: letter,
    invoiceType: type,
    total,
    shipping: shippingAmt,
    tax: taxAmt,
    lineItemsJson: JSON.stringify(lineItems.map(i => ({ id: i.id, title: i.title, quantity: i.quantity, unitPrice: parseFloat(i.discountedUnitPriceSet?.presentmentMoney?.amount || 0) }))),
    createdBy: session.email,
  });
  auditLog(session.email, 'partial_invoice_created', orderGid, null, { invoiceId: invId, letter, type, total });

  try {
    const pdf = await generateInvoicePdf(order, {
      lineItems,
      invoiceSuffix: letter,
      subtotal,
      shipping: shippingAmt,
      total,
    });
    const safeName = (order.name || 'invoice').replace(/[^a-z0-9#-]/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}-${letter}-invoice.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-download a previously generated partial invoice
app.get('/orders/:id/partial-invoice/:letter.pdf', requireAuth, async (req, res) => {
  const numId  = req.params.id;
  const letter = req.params.letter.toUpperCase();
  const orderGid = `gid://shopify/Order/${numId}`;
  const rows = getPartialInvoices(orderGid);
  const inv  = rows.find(r => r.invoice_letter === letter);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });

  const order = await getOrderDetail(numId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const lineItems = JSON.parse(inv.line_items_json || '[]').map(li => ({
    id: li.id, title: li.title, quantity: li.quantity,
    discountedUnitPriceSet: { presentmentMoney: { amount: String(li.unitPrice), currencyCode: 'USD' } },
    originalUnitPriceSet:   { presentmentMoney: { amount: String(li.unitPrice), currencyCode: 'USD' } },
    variant: null,
  }));
  try {
    const pdf = await generateInvoicePdf(order, {
      lineItems,
      invoiceSuffix: letter,
      subtotal: inv.total - inv.shipping - inv.tax,
      shipping: inv.shipping,
      total: inv.total,
    });
    const safeName = (order.name || 'invoice').replace(/[^a-z0-9#-]/gi, '-');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}-${letter}-invoice.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// JSON API — list partial invoices for an order
app.get('/api/admin/orders/:id/partial-invoices', requireAuth, (req, res) => {
  const numId = req.params.id;
  const rows = getPartialInvoices(`gid://shopify/Order/${numId}`);
  res.json({ ok: true, invoices: rows });
});

// ── Phase 16: Order editing, partial fulfillment, backorder ──────────────────

// 16A: Edit order line items (qty changes, remove, add, price override)
app.post('/orders/:id/edit', requireAuth, async (req, res) => {
  const numId   = req.params.id;
  const session = req.adminSession;
  const { qtys, removes, staffNote, discountPct, discountFixed, discountReason } = req.body;
  // qtys: { lineItemId: newQty, ... }   removes: [lineItemId, ...]
  const qtysMap   = Object.fromEntries(Object.entries(qtys || {}).map(([k,v]) => [k, parseInt(v,10) || 0]));
  const removeSet = new Set([removes || []].flat());

  const changes = { qtys: qtysMap, removes: [...removeSet], discountPct, discountFixed, discountReason };

  if (MOCK) {
    const order = getMockOrder(numId);
    if (!order) return res.status(404).json({ error: 'order not found' });
    // Apply changes to mockOrderOverrides
    const overrides = mockOrderOverrides.get(numId) || {};
    const newEdges = (order.lineItems?.edges || []).filter(e => !removeSet.has(e.node.id)).map(e => {
      const newQty = qtysMap[e.node.id] ?? e.node.quantity;
      return { node: { ...e.node, quantity: newQty } };
    });
    overrides.lineItems = { edges: newEdges };
    // Recalculate totals
    let subtotal = 0;
    for (const e of newEdges) {
      const price = parseFloat(e.node.discountedUnitPriceSet?.presentmentMoney?.amount || 0);
      subtotal += price * (e.node.quantity || 0);
    }
    if (discountPct) subtotal = subtotal * (1 - parseFloat(discountPct) / 100);
    if (discountFixed) subtotal = subtotal - parseFloat(discountFixed);
    overrides.subtotalPriceSet = { presentmentMoney: { amount: subtotal.toFixed(2), currencyCode: 'USD' } };
    overrides.totalPriceSet    = { presentmentMoney: { amount: (subtotal + parseFloat(order.totalShippingPriceSet?.presentmentMoney?.amount || 0)).toFixed(2), currencyCode: 'USD' } };
    mockOrderOverrides.set(numId, overrides);
    logOrderEdit(`gid://shopify/Order/${numId}`, session.email, staffNote, changes);
    auditLog(session.email, 'order_edit', `gid://shopify/Order/${numId}`, null, changes);
    return res.redirect(`/orders/${numId}?success=order_edited`);
  }

  // Real mode: use Shopify orderEdit* mutation suite
  try {
    const orderId = `gid://shopify/Order/${numId}`;
    const beginResult = await shopifyFetch(`
      mutation begin($id:ID!){orderEditBegin(id:$id){calculatedOrder{id}userErrors{field message}}}
    `, { id: orderId });
    const calcId = beginResult.data?.orderEditBegin?.calculatedOrder?.id;
    if (!calcId) {
      const errs = beginResult.data?.orderEditBegin?.userErrors || [];
      throw new Error(errs.map(e => e.message).join(', ') || 'orderEditBegin failed');
    }
    // Apply qty changes and removes
    for (const [liId, newQty] of Object.entries(qtysMap)) {
      if (!removeSet.has(liId)) {
        await shopifyFetch(`mutation setQty($id:ID!,$li:ID!,$qty:Int!,$r:Boolean!){
          orderEditSetQuantity(id:$id,lineItemId:$li,quantity:$qty,restock:$r){
            calculatedOrder{id} userErrors{field message}}}`,
          { id: calcId, li: liId, qty: newQty, r: false });
      }
    }
    for (const liId of removeSet) {
      await shopifyFetch(`mutation setQty($id:ID!,$li:ID!,$qty:Int!,$r:Boolean!){
        orderEditSetQuantity(id:$id,lineItemId:$li,quantity:$qty,restock:$r){
          calculatedOrder{id} userErrors{field message}}}`,
        { id: calcId, li: liId, qty: 0, r: true });
    }
    // Apply order-level discount as a custom item
    if ((discountPct || discountFixed) && discountReason) {
      // Fetch current order total to compute discount amount
      const totResult = await shopifyFetch(`query($id:ID!){order(id:$id){subtotalPriceSet{presentmentMoney{amount}}}}`, { id: orderId });
      const subTotal = parseFloat(totResult.data?.order?.subtotalPriceSet?.presentmentMoney?.amount || 0);
      const discAmt = discountPct ? subTotal * parseFloat(discountPct) / 100 : parseFloat(discountFixed || 0);
      await shopifyFetch(`mutation addItem($id:ID!,$title:String!,$price:Money!,$qty:Int!){
        orderEditAddCustomItem(id:$id,title:$title,price:$price,quantity:$qty){
          calculatedOrder{id} userErrors{field message}}}`,
        { id: calcId, title: `Order discount: ${discountReason}`, price: `-${discAmt.toFixed(2)}`, qty: 1 });
    }
    // Commit
    await shopifyFetch(`mutation commit($id:ID!,$notify:Boolean!,$note:String){
      orderEditCommit(id:$id,notifyCustomer:$notify,staffNote:$note){
        order{id} userErrors{field message}}}`,
      { id: calcId, notify: false, note: staffNote || null });
    logOrderEdit(orderId, session.email, staffNote, changes);
    auditLog(session.email, 'order_edit', orderId, null, changes);
    res.redirect(`/orders/${numId}?success=order_edited`);
  } catch (err) {
    console.error('order edit error:', err.message);
    res.redirect(`/orders/${numId}?error=edit_failed`);
  }
});

// 16B: Order-level discount (standalone; can also be triggered via /edit)
app.post('/orders/:id/discount', requireAuth, async (req, res) => {
  const numId  = req.params.id;
  const { type, value, reason } = req.body;
  if (!value || !reason) return res.redirect(`/orders/${numId}?error=discount_missing_fields`);
  const changes = { discountType: type, discountValue: value, reason };
  if (MOCK) {
    const order = getMockOrder(numId);
    if (!order) return res.status(404).json({ error: 'not found' });
    const overrides = mockOrderOverrides.get(numId) || {};
    const sub = parseFloat(order.subtotalPriceSet?.presentmentMoney?.amount || 0);
    const discAmt = type === 'pct' ? sub * parseFloat(value) / 100 : parseFloat(value);
    const newSub = Math.max(0, sub - discAmt);
    overrides.subtotalPriceSet = { presentmentMoney: { amount: newSub.toFixed(2), currencyCode: 'USD' } };
    overrides.totalPriceSet    = { presentmentMoney: { amount: (newSub + parseFloat(order.totalShippingPriceSet?.presentmentMoney?.amount || 0)).toFixed(2), currencyCode: 'USD' } };
    overrides._discountLine    = { type, value, reason, amount: discAmt.toFixed(2) };
    mockOrderOverrides.set(numId, overrides);
    auditLog(req.adminSession.email, 'order_discount', `gid://shopify/Order/${numId}`, null, changes);
    return res.redirect(`/orders/${numId}?success=discount_applied`);
  }
  // Real mode: delegate to /orders/:id/edit with discount fields only
  try {
    const orderId = `gid://shopify/Order/${numId}`;
    const beginResult = await shopifyFetch(`mutation begin($id:ID!){orderEditBegin(id:$id){calculatedOrder{id}userErrors{field message}}}`, { id: orderId });
    const calcId = beginResult.data?.orderEditBegin?.calculatedOrder?.id;
    if (!calcId) throw new Error('begin failed');
    const totResult = await shopifyFetch(`query($id:ID!){order(id:$id){subtotalPriceSet{presentmentMoney{amount}}}}`, { id: orderId });
    const subTotal = parseFloat(totResult.data?.order?.subtotalPriceSet?.presentmentMoney?.amount || 0);
    const discAmt  = type === 'pct' ? subTotal * parseFloat(value) / 100 : parseFloat(value);
    await shopifyFetch(`mutation addItem($id:ID!,$title:String!,$price:Money!,$qty:Int!){
      orderEditAddCustomItem(id:$id,title:$title,price:$price,quantity:$qty){calculatedOrder{id}userErrors{field message}}}`,
      { id: calcId, title: `Order discount: ${reason}`, price: `-${discAmt.toFixed(2)}`, qty: 1 });
    await shopifyFetch(`mutation commit($id:ID!,$notify:Boolean!){orderEditCommit(id:$id,notifyCustomer:$notify){order{id}userErrors{field message}}}`,
      { id: calcId, notify: false });
    auditLog(req.adminSession.email, 'order_discount', orderId, null, changes);
    res.redirect(`/orders/${numId}?success=discount_applied`);
  } catch (err) {
    console.error('discount error:', err.message);
    res.redirect(`/orders/${numId}?error=discount_failed`);
  }
});

// 16C: Partial fulfillment
app.post('/orders/:id/fulfill', requireAuth, async (req, res) => {
  const numId   = req.params.id;
  const session = req.adminSession;
  const { lineItems: liRaw, trackingCompany, trackingNumber, notifyCustomer } = req.body;
  // liRaw: { lineItemId: qty, ... } or { 'li1': '2', 'li2': '3' }
  const lineItemsMap = Object.fromEntries(
    Object.entries(liRaw || {}).map(([k, v]) => [k, parseInt(v, 10) || 0]).filter(([,qty]) => qty > 0)
  );
  if (!Object.keys(lineItemsMap).length) return res.redirect(`/orders/${numId}?error=no_items_selected`);

  if (MOCK) {
    const order = getMockOrder(numId);
    if (!order) return res.status(404).json({ error: 'not found' });
    const overrides = mockOrderOverrides.get(numId) || {};
    const tracking = trackingNumber ? [{ number: trackingNumber, url: null, company: trackingCompany || '' }] : [];
    const existingFulfillments = overrides.fulfillments || order.fulfillments || [];
    overrides.fulfillments = [...existingFulfillments, {
      status: 'SUCCESS', trackingInfo: tracking, createdAt: new Date().toISOString(),
      lineItemIds: Object.keys(lineItemsMap),
    }];
    overrides.displayFulfillmentStatus = 'PARTIALLY_FULFILLED';
    // Mark backorders as fulfilled for matched lines
    for (const liId of Object.keys(lineItemsMap)) {
      fulfillBackorder(`gid://shopify/Order/${numId}`, liId);
    }
    mockOrderOverrides.set(numId, overrides);
    auditLog(session.email, 'order_fulfill', `gid://shopify/Order/${numId}`, null, { lineItems: lineItemsMap, trackingNumber });
    return res.redirect(`/orders/${numId}?success=fulfilled`);
  }

  // Real mode: fulfillmentCreate mutation
  try {
    const orderId    = `gid://shopify/Order/${numId}`;
    const liInputs   = Object.entries(lineItemsMap).map(([id, quantity]) => ({ id, quantity }));
    const trackInput = trackingNumber ? { company: trackingCompany || '', number: trackingNumber, url: null } : null;
    const result = await shopifyFetch(`
      mutation fulfill($input:FulfillmentInput!){fulfillmentCreate(input:$input){
        fulfillment{id status} userErrors{field message}}}`,
      { input: {
          orderId,
          lineItemsByFulfillmentOrder: liInputs.map(li => ({ fulfillmentOrderId: null, lineItemIds: [li.id], quantities: [li.quantity] })),
          trackingInfo: trackInput,
          notifyCustomer: !!notifyCustomer,
        }
      });
    const errs = result.data?.fulfillmentCreate?.userErrors || [];
    if (errs.length) throw new Error(errs.map(e => e.message).join(', '));
    // Mark any matching backorders as fulfilled
    for (const liId of Object.keys(lineItemsMap)) {
      fulfillBackorder(orderId, liId);
    }
    auditLog(session.email, 'order_fulfill', orderId, null, { lineItems: lineItemsMap, trackingNumber });
    res.redirect(`/orders/${numId}?success=fulfilled`);
  } catch (err) {
    console.error('fulfillment error:', err.message);
    res.redirect(`/orders/${numId}?error=fulfillment_failed`);
  }
});

// 16D: Backorder flag per line item
app.post('/orders/:id/backorder', requireAuth, (req, res) => {
  const numId   = req.params.id;
  const { lineItemId, lineItemTitle, quantity, eta } = req.body;
  if (!lineItemId) return res.redirect(`/orders/${numId}?error=missing_line_item`);
  const orderId = `gid://shopify/Order/${numId}`;
  upsertBackorder(orderId, lineItemId, lineItemTitle || '', parseInt(quantity, 10) || 0, eta || null, req.adminSession.email);
  auditLog(req.adminSession.email, 'order_backorder', orderId, null, { lineItemId, lineItemTitle, eta });
  res.redirect(`/orders/${numId}?success=backorder_flagged`);
});

// API: get backorders for an order (used by order detail page)
app.get('/api/orders/:id/backorders', requireAuth, (req, res) => {
  const orderId = `gid://shopify/Order/${req.params.id}`;
  res.json({ backorders: getBackordersForOrder(orderId) });
});

// ── Phase 14D: Visible notes API (proxies to portal internal) ─────────────────

app.post('/api/orders/:id/visible-note', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const shopifyId = `gid://shopify/Order/${numId}`;
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  if (MOCK) {
    return res.json({ ok: true, noteId: 1, mock: true });
  }
  const result = await callPortalInternal('POST', `/__internal__/visible-note`, {
    orderId: shopifyId, body, addedBy: req.adminSession.email,
  });
  if (!result.ok) return res.status(500).json({ error: result.error || 'failed' });
  auditLog(req.adminSession.email, 'visible-note-add', shopifyId, null, { body });
  res.json({ ok: true, noteId: result.noteId });
});

app.get('/api/orders/:id/visible-notes', requireAuth, (req, res) => {
  const shopifyId = `gid://shopify/Order/${req.params.id}`;
  res.json({ notes: getVisibleNotesForOrder(shopifyId) });
});

// ── Phase 14C: Tax exempt admin review page ───────────────────────────────────

app.get('/tax-exempt', requireAuth, (req, res) => {
  const pendingCerts = MOCK ? [] : getPendingTaxCertsFromPortal();
  const flashHtml = req.query.success === 'approved'
    ? `<div class="alert alert-success">Certificate approved — customer is now tax-exempt.</div>`
    : req.query.success === 'rejected'
    ? `<div class="alert alert-success">Certificate rejected.</div>`
    : '';
  const rows = pendingCerts.map(c => `
    <tr>
      <td><a href="/customers/${c.customerId.split('/').pop()}">${h(c.customerId.split('/').pop())}</a></td>
      <td>${h(c.state || '—')}</td>
      <td>${new Date(c.uploadedAt).toLocaleDateString()}</td>
      <td>
        <a href="${h(PORTAL_INTERNAL_URL.replace('127.0.0.1', 'b2b.fuzzyreporting.com'))}/api/admin/tax-exempt/${c.id}/file" target="_blank" class="btn btn-sm btn-secondary">View PDF</a>
        <form method="POST" action="/tax-exempt/${c.id}/approve" style="display:inline">
          <button class="btn btn-sm btn-success" onclick="return confirm('Approve this certificate?')">Approve</button>
        </form>
        <form method="POST" action="/tax-exempt/${c.id}/reject" style="display:inline">
          <input type="hidden" name="reason" value="Certificate does not meet requirements">
          <button class="btn btn-sm" style="border:1px solid var(--danger);color:var(--danger)" onclick="return confirm('Reject this certificate?')">Reject</button>
        </form>
      </td>
    </tr>`).join('');
  res.send(layout({ title: 'Tax Exempt Review', session: req.adminSession, activePath: '/tax-exempt', content: `
    <div class="page-header"><h1>Tax Exemption Certs — Pending Review</h1></div>
    ${flashHtml}
    <div class="card">
      <table class="data-table">
        <thead><tr><th>Customer ID</th><th>State</th><th>Uploaded</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:var(--muted)">No pending certificates.</td></tr>'}</tbody>
      </table>
    </div>` }));
});

app.post('/tax-exempt/:id/approve', requireAuth, async (req, res) => {
  if (MOCK) return res.redirect('/tax-exempt?success=approved');
  const result = await callPortalInternal('POST', `/__internal__/tax-exempt/${req.params.id}/approve`, {
    reviewedBy: req.adminSession.email,
  });
  auditLog(req.adminSession.email, 'tax-cert-approve', `cert:${req.params.id}`, null, { reviewedBy: req.adminSession.email });
  res.redirect(`/tax-exempt?success=${result.ok ? 'approved' : 'error'}`);
});

app.post('/tax-exempt/:id/reject', requireAuth, async (req, res) => {
  if (MOCK) return res.redirect('/tax-exempt?success=rejected');
  const reason = String(req.body?.reason || 'Rejected').slice(0, 500);
  const result = await callPortalInternal('POST', `/__internal__/tax-exempt/${req.params.id}/reject`, {
    reviewedBy: req.adminSession.email, reason,
  });
  auditLog(req.adminSession.email, 'tax-cert-reject', `cert:${req.params.id}`, null, { reason });
  res.redirect(`/tax-exempt?success=${result.ok ? 'rejected' : 'error'}`);
});

// Phase 4: Customers CSV export
app.get('/customers/export.csv', requireAuth, async (req, res) => {
  const ts = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fww-b2b-customers-${ts}.csv"`);
  res.write(csvLine(['customer_id','name','email','phone','tags','lifetime_spend','orders','city','province','country']));
  const customers = MOCK
    ? MOCK_CUSTOMERS
    : await (async () => {
        const all = [];
        let after = null;
        for (let page = 0; page < 10; page++) {
          const result = await shopifyFetch(
            `query($q:String!,$first:Int!,$after:String){customers(first:$first,query:$q,after:$after,sortKey:AMOUNT_SPENT,reverse:true){edges{cursor node{id displayName email phone tags amountSpent{amount} numberOfOrders defaultAddress{city province country}}}pageInfo{hasNextPage endCursor}}}`,
            { q: 'tag:b2b', first: 250, after });
          const edges = result.data?.customers?.edges || [];
          all.push(...edges.map(e => e.node));
          if (!result.data?.customers?.pageInfo?.hasNextPage) break;
          after = result.data.customers.pageInfo.endCursor;
        }
        return all;
      })();
  for (const c of customers) {
    const addr = c.defaultAddress || {};
    res.write(csvLine([
      shopifyNumericId(c.id),
      c.displayName || '',
      c.email || '',
      c.phone || '',
      Array.isArray(c.tags) ? c.tags.join('|') : (c.tags || ''),
      c.amountSpent?.amount || '',
      c.numberOfOrders || '',
      addr.city || '',
      addr.province || '',
      addr.country || '',
    ]));
  }
  res.end();
});

// ── Customers ──
app.get('/customers', requireAuth, async (req, res) => {
  const filters = { q: req.query.q || '', segment: req.query.segment || '', tag: req.query.tag || '', after: req.query.after || '', sort: req.query.sort || '' };
  const data = await getCustomersData(filters);
  res.send(renderCustomersList(req.adminSession, data, filters));
});

app.get('/customers/:id', requireAuth, async (req, res) => {
  const [customer, recentOrders, b2bConfig] = await Promise.all([
    getCustomerDetail(req.params.id),
    getCustomerRecentOrders(req.params.id),
    getB2bConfig(req.params.id),
  ]);
  if (!customer) return res.status(404).send(layout({ title: '404', session: req.adminSession, activePath: '/customers',
    content: '<div class="page-header"><h1>Customer not found</h1></div><a href="/customers" class="btn btn-secondary">← Customers</a>' }));
  const notes    = getCustomerNotes(shopifyCustomerGid(req.params.id));
  const dropship = getDropshipCache(shopifyCustomerGid(req.params.id));
  res.send(renderCustomerDetail(req.adminSession, customer, recentOrders, notes, dropship, b2bConfig, req.query.success || ''));
});

app.post('/customers/:id/notes', requireAuth, (req, res) => {
  const body = String(req.body.body || '').slice(0, 5000);
  const gid  = shopifyCustomerGid(req.params.id);
  setCustomerNotes(gid, body, req.adminSession.email);
  auditLog(req.adminSession.email, 'update_customer_notes', gid, null, { body: body.slice(0, 100) });
  res.redirect(`/customers/${req.params.id}?success=notes_saved`);
});

app.post('/customers/:id/tags/add', requireAuth, async (req, res) => {
  const tag  = String(req.body.tag || '').trim().slice(0, 100);
  const gid  = shopifyCustomerGid(req.params.id);
  if (!tag) return res.redirect(`/customers/${req.params.id}`);
  if (!MOCK) {
    try {
      await shopifyFetch(`mutation tagsAdd($id:ID!,$tags:[String!]!){
        tagsAdd(id:$id,tags:$tags){ node{id} userErrors{field message} }
      }`, { id: gid, tags: [tag] });
    } catch (err) { console.error('tagsAdd error:', err.message); }
  }
  auditLog(req.adminSession.email, 'add_tag', gid, null, { tag });
  // Phase 21C: when b2b tag is added, trigger Xero sync (non-blocking)
  if (tag === 'b2b') {
    syncCustomerToXero(req.params.id, { email: '' }, xeroRequest, { dryRun: MOCK })
      .then(r => { if (r.created) auditLog(req.adminSession.email, 'xero:customer_sync', gid, null, { xeroContactId: r.xeroContactId, via: 'tag_add' }); })
      .catch(e => console.error('[xero-sync] tag add sync failed:', e.message));
  }
  res.redirect(`/customers/${req.params.id}?success=tags_added`);
});

app.post('/customers/:id/tags/remove', requireAuth, async (req, res) => {
  const tag = String(req.body.tag || '').trim().slice(0, 100);
  const gid = shopifyCustomerGid(req.params.id);
  if (!tag) return res.redirect(`/customers/${req.params.id}`);
  if (!MOCK) {
    try {
      await shopifyFetch(`mutation tagsRemove($id:ID!,$tags:[String!]!){
        tagsRemove(id:$id,tags:$tags){ node{id} userErrors{field message} }
      }`, { id: gid, tags: [tag] });
    } catch (err) { console.error('tagsRemove error:', err.message); }
  }
  auditLog(req.adminSession.email, 'remove_tag', gid, null, { tag });
  res.redirect(`/customers/${req.params.id}?success=tags_added`);
});

app.post('/customers/:id/dropship', requireAuth, async (req, res) => {
  const enabled   = req.body.enabled === 'on' || req.body.enabled === 'true';
  const marginPct = Math.max(0, Math.min(100, parseInt(req.body.margin_pct || '0', 10)));
  const gid       = shopifyCustomerGid(req.params.id);
  setDropshipCache(gid, enabled, marginPct);
  if (!MOCK) {
    try {
      await shopifyFetch(`mutation metafieldsSet($metafields:[MetafieldsSetInput!]!){
        metafieldsSet(metafields:$metafields){ metafields{id key value} userErrors{field message} }
      }`, { metafields: [
        { ownerId: gid, namespace: 'b2b', key: 'dropship_enabled', value: String(enabled), type: 'boolean' },
        { ownerId: gid, namespace: 'b2b', key: 'dropship_margin_pct', value: String(marginPct), type: 'number_integer' },
      ]});
    } catch (err) { console.error('metafieldsSet error:', err.message); }
  }
  auditLog(req.adminSession.email, 'update_dropship', gid, null, { enabled, marginPct });
  res.redirect(`/customers/${req.params.id}?success=dropship_saved`);
});

// ── Phase 7/10: B2B config (unified: discount + dropship + allow_order_on_invoice) ──

app.post('/customers/:id/b2b-config', requireAuth, async (req, res) => {
  const numId = req.params.id;
  // Checkboxes: if absent from form body, checkbox was unchecked → explicitly set false
  const body = {
    ...req.body,
    dropship_enabled:       'dropship_enabled'       in req.body ? req.body.dropship_enabled       : 'false',
    allow_order_on_invoice: 'allow_order_on_invoice' in req.body ? req.body.allow_order_on_invoice : 'false',
  };
  const before = await getB2bConfig(numId);
  await applyB2bConfigUpdate(numId, body);
  const after = await getB2bConfig(numId);
  auditLog(req.adminSession.email, 'customer:b2b-config', shopifyCustomerGid(numId), before.overrides, after.overrides);
  res.redirect(`/customers/${numId}?success=b2b_settings_saved`);
});

app.get('/api/admin/customers/:id/b2b-config', requireAuth, async (req, res) => {
  res.json(await getB2bConfig(req.params.id));
});

app.put('/api/admin/customers/:id/b2b-config', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const before = await getB2bConfig(numId);
  await applyB2bConfigUpdate(numId, req.body);
  const after = await getB2bConfig(numId);
  auditLog(req.adminSession.email, 'customer:b2b-config', shopifyCustomerGid(numId), before.overrides, after.overrides);
  res.json({ ok: true, ...after });
});

// ── 19A: Customer spend API ──
app.get('/api/admin/customers/:id/spend', requireAuth, async (req, res) => {
  const numId  = req.params.id;
  const fromTs = req.query.from ? new Date(req.query.from).getTime() : 0;
  const toTs   = req.query.to   ? new Date(req.query.to).getTime()   : Date.now() + 86400000;

  // Phase 24D: try cache first
  if (!MOCK) {
    try {
      const cust = getCustomerFromCache(numId);
      const stats = getOrdersCacheStats();
      if (cust && stats && stats.total > 0) {
        const allOrders = getCustomerOrdersFromCache(numId);
        const rangeOrders = allOrders.filter(o => o.created_at >= fromTs && o.created_at <= toTs);
        const rangeTotal = rangeOrders.reduce((s, o) => s + (o.total_price || 0), 0);
        return res.json({
          lifetimeTotal: String(cust.amount_spent_total || 0),
          lifetimeCount: cust.orders_count || 0,
          rangeTotal: rangeTotal.toFixed(2),
          rangeCount: rangeOrders.length,
          orders: rangeOrders.map(o => ({
            id: o.shopify_id,
            name: o.name,
            processedAt: new Date(o.processed_at || o.created_at).toISOString(),
            total: String(o.total_price || 0),
            financialStatus: o.financial_status || o.display_financial_status,
            fulfillmentStatus: o.fulfillment_status || o.display_fulfillment_status,
          })),
          _fromCache: true,
        });
      }
    } catch (e) {
      console.error('spend cache read failed, falling back to live Shopify:', e.message);
    }
  }
  if (MOCK) {
    const gid = shopifyCustomerGid(numId);
    const all = MOCK_ORDERS.filter(o => o.customer?.id === gid);
    const lifetimeTotal = all.reduce((s, o) => s + parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0), 0);
    const range = all.filter(o => {
      const d = new Date(o.processedAt).getTime();
      return d >= fromTs && d <= toTs;
    });
    const rangeTotal = range.reduce((s, o) => s + parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0), 0);
    return res.json({
      lifetimeTotal: lifetimeTotal.toFixed(2),
      lifetimeCount: all.length,
      rangeTotal: rangeTotal.toFixed(2),
      rangeCount: range.length,
      orders: range.map(o => ({
        id:   shopifyNumericId(o.id),
        name: o.name,
        processedAt: o.processedAt,
        total: o.totalPriceSet?.presentmentMoney?.amount || '0.00',
        financialStatus: o.displayFinancialStatus,
        fulfillmentStatus: o.displayFulfillmentStatus,
      })),
    });
  }

  try {
    const gid = shopifyCustomerGid(numId);
    const fromStr = new Date(fromTs).toISOString().split('T')[0];
    const toStr   = new Date(toTs  ).toISOString().split('T')[0];
    const r = await shopifyFetch(`
      query($id:ID!,$q:String!){
        customer(id:$id){
          amountSpent{amount currencyCode}
          numberOfOrders
          orders(first:250,query:$q,sortKey:PROCESSED_AT,reverse:true){
            edges{node{
              id name processedAt displayFinancialStatus displayFulfillmentStatus
              totalPriceSet{presentmentMoney{amount currencyCode}}
            }}
          }
        }
      }`, { id: gid, q: `processed_at:>=${fromStr} processed_at:<=${toStr}` });
    const cust = r.data?.customer;
    if (!cust) return res.status(404).json({ error: 'not found' });
    const orders = cust.orders.edges.map(e => e.node);
    const rangeTotal = orders.reduce((s, o) => s + parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0), 0);
    res.json({
      lifetimeTotal: cust.amountSpent?.amount || '0.00',
      lifetimeCount: cust.numberOfOrders || 0,
      rangeTotal: rangeTotal.toFixed(2),
      rangeCount: orders.length,
      orders: orders.map(o => ({
        id:   shopifyNumericId(o.id),
        name: o.name,
        processedAt: o.processedAt,
        total: o.totalPriceSet?.presentmentMoney?.amount || '0.00',
        financialStatus: o.displayFinancialStatus,
        fulfillmentStatus: o.displayFulfillmentStatus,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API search ──
app.get('/api/customers/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const customers = MOCK
    ? MOCK_CUSTOMERS.filter(c => c.displayName.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
    : await (async () => {
        try {
          const r = await shopifyFetch(`query($q:String!){ customers(first:10,query:$q){
            edges{node{id displayName email defaultAddress{firstName lastName address1 address2 city province zip country}}}}}`,
            { q: `tag:b2b ${q}` });
          return r.data?.customers?.edges?.map(e => e.node) || [];
        } catch { return []; }
      })();
  res.json(customers.slice(0, 10).map(c => ({
    id:       shopifyNumericId(c.id),
    label:    c.displayName,
    sublabel: c.email,
    address:  c.defaultAddress || null,
  })));
});

app.get('/api/products/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);

  const allVariants = MOCK
    ? MOCK_PRODUCTS.flatMap(p =>
        (p.variants?.edges || []).map(e => ({
          id: shopifyNumericId(p.id),
          productTitle: p.title,
          variantId: shopifyNumericId(e.node.id),
          variantTitle: e.node.title,
          sku: e.node.sku,
          price: e.node.price,
          inventoryQuantity: e.node.inventoryQuantity,
        }))
      ).filter(v =>
        v.productTitle.toLowerCase().includes(q) ||
        (v.sku || '').toLowerCase().includes(q) ||
        v.variantTitle.toLowerCase().includes(q)
      )
    : await (async () => {
        try {
          const r = await shopifyFetch(`query($q:String!){ products(first:10,query:$q){
            edges{node{id title variants(first:5){edges{node{id title sku price inventoryQuantity}}}}}}}`,
            { q });
          return (r.data?.products?.edges || []).flatMap(e =>
            (e.node.variants?.edges || []).map(ve => ({
              id: shopifyNumericId(e.node.id),
              productTitle: e.node.title,
              variantId: shopifyNumericId(ve.node.id),
              variantTitle: ve.node.title,
              sku: ve.node.sku,
              price: ve.node.price,
              inventoryQuantity: ve.node.inventoryQuantity,
            }))
          );
        } catch { return []; }
      })();

  res.json(allVariants.slice(0, 20).map(v => ({
    variantId: v.variantId,
    label:     v.variantTitle === 'Default Title' ? v.productTitle : `${v.productTitle} — ${v.variantTitle}`,
    sublabel:  `${v.sku || '—'} · ${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(parseFloat(v.price||0))} list`,
    sku:       v.sku,
    price:     v.price,
  })));
});

// ── Phase 3 helpers ───────────────────────────────────────────────────────────

function getStyleFromTags(tags) {
  const t = (tags || []).find(t => t.startsWith('Style_'));
  return t ? t.slice(6) : null;
}

function csvLine(cells) {
  return cells.map(c => {
    const s = c == null ? '' : String(c);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',') + '\n';
}

function renderBarChart(data, opts = {}) {
  const { width = 580, height = 110, fill = '#9BBC0E', labelField = 'label', valueField = 'value' } = opts;
  if (!data.length) return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  const max = Math.max(...data.map(d => d[valueField]));
  const barW = Math.max(4, Math.floor((width - 8) / data.length) - 2);
  const bars = data.map((d, i) => {
    const bh = max > 0 ? Math.max(2, Math.round((d[valueField] / max) * (height - 24))) : 2;
    const x = 4 + i * (barW + 2);
    const y = height - 18 - bh;
    const lbl = data.length <= 12 ? `<text x="${x + barW / 2}" y="${height - 3}" text-anchor="middle" font-size="9" fill="#6B7280" font-family="sans-serif">${h(String(d[labelField]))}</text>` : '';
    return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="${fill}" rx="1"><title>${h(String(d[labelField]))}: ${h(String(d[valueField]))}</title></rect>${lbl}`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="max-width:100%;display:block">${bars}</svg>`;
}

function renderSparkline(values, opts = {}) {
  const { width = 80, height = 24, fill = '#9BBC0E' } = opts;
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = Math.round((i / (values.length - 1 || 1)) * (width - 2)) + 1;
    const y = height - 2 - Math.round((v / max) * (height - 4));
    return `${x},${y}`;
  }).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="vertical-align:middle"><polyline points="${pts}" fill="none" stroke="${fill}" stroke-width="1.5"/></svg>`;
}

// ── Catalog ───────────────────────────────────────────────────────────────────

async function getCatalogData({ vendor, style, stock, b2b, status = 'active', page = 1 }) {
  // Phase 25B/F: default to Fuzzywumpets vendor; use vendor='all' to bypass
  const effectiveVendor = (vendor === 'all') ? '' : (vendor || 'Fuzzywumpets');

  if (MOCK) {
    const allProds = MOCK_CATALOG_PRODUCTS.map(p => {
      const ov = mockCatalogOverrides.get(shopifyNumericId(p.id)) || {};
      return { ...p, publishedOnB2B: ov.publishedOnB2B !== undefined ? ov.publishedOnB2B : p.publishedOnB2B };
    });
    const vendorProds = effectiveVendor ? allProds.filter(p => p.vendor === effectiveVendor) : allProds;
    const statusCounts = {
      active:   vendorProds.filter(p => (p.status || 'active') === 'active').length,
      draft:    vendorProds.filter(p => p.status === 'draft').length,
      archived: vendorProds.filter(p => p.status === 'archived').length,
      all:      vendorProds.length,
    };
    let prods = status === 'all' ? vendorProds : vendorProds.filter(p => (p.status || 'active') === status);
    if (style)       prods = prods.filter(p => (p.tags || []).includes(`Style_${style}`));
    if (b2b === '1') prods = prods.filter(p => p.publishedOnB2B);
    if (b2b === '0') prods = prods.filter(p => !p.publishedOnB2B);
    if (stock === 'low')  prods = prods.filter(p => { const t = (p.variants?.edges||[]).reduce((s,e) => s+(e.node.inventoryQuantity||0),0); return t > 0 && t < 10; });
    if (stock === 'out')  prods = prods.filter(p => { const t = (p.variants?.edges||[]).reduce((s,e) => s+(e.node.inventoryQuantity||0),0); return t === 0; });
    const vendors = [...new Set(allProds.map(p => p.vendor))];
    const styles  = [...new Set(vendorProds.flatMap(p => (p.tags||[]).filter(t=>t.startsWith('Style_')).map(t=>t.slice(6))))];
    return { products: prods, vendors, styles, total: prods.length, hasNextPage: false, statusCounts, effectiveVendor };
  }

  try {
    const qParts = [];
    if (effectiveVendor) qParts.push(`vendor:"${effectiveVendor}"`);
    if (status !== 'all') qParts.push(`status:${status}`);
    const result = await shopifyFetch(`
      query($q:String!,$after:String){
        products(first:50,query:$q,after:$after,sortKey:TITLE){
          edges{node{
            id title handle vendor tags status
            publishedOnPublication(publicationId:"${B2B_PUB_ID}")
            variants(first:15){edges{node{sku title inventoryQuantity}}}
          }}
          pageInfo{hasNextPage endCursor}
        }
      }`, { q: qParts.join(' '), after: null });
    let prods = (result.data?.products?.edges || []).map(e => ({
      ...e.node,
      publishedOnB2B: e.node.publishedOnPublication,
    }));
    if (style)       prods = prods.filter(p => (p.tags||[]).includes(`Style_${style}`));
    if (b2b === '1') prods = prods.filter(p => p.publishedOnB2B);
    if (b2b === '0') prods = prods.filter(p => !p.publishedOnB2B);
    if (stock === 'low')  prods = prods.filter(p => { const t=(p.variants?.edges||[]).reduce((s,e)=>s+(e.node.inventoryQuantity||0),0); return t>0&&t<10; });
    if (stock === 'out')  prods = prods.filter(p => { const t=(p.variants?.edges||[]).reduce((s,e)=>s+(e.node.inventoryQuantity||0),0); return t===0; });
    const allVendors = [...new Set(result.data?.products?.edges?.map(e => e.node.vendor).filter(Boolean) || [])];
    const allStyles  = [...new Set((result.data?.products?.edges||[]).flatMap(e => (e.node.tags||[]).filter(t=>t.startsWith('Style_')).map(t=>t.slice(6))))];
    return { products: prods, vendors: allVendors, styles: allStyles, total: prods.length, hasNextPage: result.data?.products?.pageInfo?.hasNextPage, statusCounts: null, effectiveVendor };
  } catch (err) {
    console.error('getCatalogData error:', err.message);
    return { products: [], vendors: [], styles: [], total: 0, hasNextPage: false, error: err.message, statusCounts: null, effectiveVendor };
  }
}

function renderCatalog(session, data, filters) {
  const { products, vendors, styles, error, statusCounts, effectiveVendor } = data;

  // Status filter chips (Phase 19E) — Active is the default
  const statusChips = [
    { value: 'active',   label: 'Active' },
    { value: 'draft',    label: 'Draft' },
    { value: 'archived', label: 'Archived' },
    { value: 'all',      label: 'All' },
  ].map(c => {
    const active = (filters.status || 'active') === c.value;
    const count  = statusCounts ? statusCounts[c.value] : null;
    const badge  = count != null ? ` <span class="chip-count">(${count})</span>` : '';
    const params = new URLSearchParams();
    if (c.value !== 'active') params.set('status', c.value);
    if (filters.vendor) params.set('vendor', filters.vendor);
    if (filters.style)  params.set('style',  filters.style);
    if (filters.stock)  params.set('stock',  filters.stock);
    if (filters.b2b)    params.set('b2b',    filters.b2b);
    const href = params.toString() ? `/catalog?${params}` : '/catalog';
    return `<a href="${href}" class="filter-chip${active ? ' filter-chip-active' : ''}">${h(c.label)}${badge}</a>`;
  }).join('');

  const vendorIsDefault = !filters.vendor || filters.vendor === 'Fuzzywumpets';
  const filterBar = `
    <div class="filter-chips" id="catalog-status-chips">${statusChips}</div>
    <form method="GET" action="/catalog" class="filter-bar">
      ${filters.status && filters.status !== 'active' ? `<input type="hidden" name="status" value="${h(filters.status)}">` : ''}
      <select name="vendor" onchange="this.form.submit()" title="Vendor filter — defaults to Fuzzywumpets">
        <option value=""${vendorIsDefault ? ' selected' : ''}>Fuzzywumpets (default)</option>
        <option value="all"${filters.vendor === 'all' ? ' selected' : ''}>All vendors</option>
        ${(vendors||[]).filter(v => v && v !== 'Fuzzywumpets').map(v => `<option value="${h(v)}"${filters.vendor===v?' selected':''}>${h(v)}</option>`).join('')}
      </select>
      <select name="style" onchange="this.form.submit()">
        <option value="">All styles</option>
        ${(styles||[]).map(s => `<option value="${h(s)}"${filters.style===s?' selected':''}>${h(s)}</option>`).join('')}
      </select>
      <select name="stock" onchange="this.form.submit()">
        <option value="">All stock</option>
        <option value="low"${filters.stock==='low'?' selected':''}>Low stock (&lt;10)</option>
        <option value="out"${filters.stock==='out'?' selected':''}>Out of stock</option>
      </select>
      <select name="b2b" onchange="this.form.submit()">
        <option value="">All B2B status</option>
        <option value="1"${filters.b2b==='1'?' selected':''}>On B2B publication</option>
        <option value="0"${filters.b2b==='0'?' selected':''}>Not on B2B</option>
      </select>
      <button type="submit" class="btn btn-secondary btn-sm">Filter</button>
      <a href="/catalog" class="btn btn-ghost btn-sm">Reset</a>
    </form>`;

  const bulkBar = `
    <form method="POST" action="/catalog/bulk" id="catalog-bulk-form">
      <div class="bulk-bar" id="bulk-bar" style="display:none">
        <span id="bulk-count">0</span> selected
        <button type="submit" name="action" value="publish" class="btn btn-primary btn-sm">Publish to B2B</button>
        <button type="submit" name="action" value="unpublish" class="btn btn-secondary btn-sm">Remove from B2B</button>
        <button type="button" onclick="clearSelection()" class="btn btn-ghost btn-sm">Clear</button>
      </div>`;

  const rows = products.map(p => {
    const style = getStyleFromTags(p.tags);
    const variants = (p.variants?.edges || []);
    const totalQty = variants.reduce((s, e) => s + (e.node.inventoryQuantity || 0), 0);
    const numId = shopifyNumericId(p.id);
    const qtyClass = totalQty === 0 ? 'qty-zero' : totalQty < 10 ? 'qty-critical' : '';
    const b2bBadge = p.publishedOnB2B
      ? `<span class="badge badge-paid">B2B ✓</span>`
      : `<span class="badge badge-pending">Not on B2B</span>`;
    const pStatus = (p.status || 'active').toLowerCase();
    const statusBadge = pStatus === 'draft'
      ? ` <span class="badge badge-draft">DRAFT</span>`
      : pStatus === 'archived'
        ? ` <span class="badge badge-archived">ARCHIVED</span>`
        : '';
    const rowClass = pStatus === 'archived' ? ' class="row-archived"' : '';
    return `<tr data-id="${h(numId)}"${rowClass}>
      <td><input type="checkbox" name="ids" value="${h(numId)}" class="row-check" onchange="updateBulkBar()"></td>
      <td><a href="/catalog/${h(numId)}" class="link-primary">${h(p.title)}</a>${statusBadge}</td>
      <td class="text-muted">${h(p.vendor||'—')}</td>
      <td>${style ? `<span class="tag-chip">${h(style)}</span>` : '—'}</td>
      <td class="mono text-sm">${variants.map(e => h(e.node.sku||'—')).join('<br>')}</td>
      <td class="${qtyClass}">${totalQty}</td>
      <td>${b2bBadge}</td>
      <td>
        ${p.publishedOnB2B
          ? `<form method="POST" action="/catalog/${h(numId)}/unpublish" style="display:inline"><button class="btn btn-ghost btn-sm" onclick="return confirm('Remove from B2B publication?')">Remove</button></form>`
          : `<form method="POST" action="/catalog/${h(numId)}/publish" style="display:inline"><button class="btn btn-primary btn-sm">Add to B2B</button></form>`
        }
      </td>
    </tr>`;
  }).join('');

  const table = products.length ? `
    <div class="table-wrap">
    <table class="data-table" id="catalog-table">
      <thead><tr>
        <th style="width:32px"><input type="checkbox" id="select-all" onchange="selectAll(this)"></th>
        <th>Product</th><th>Vendor</th><th>Style</th><th>SKUs</th>
        <th title="Total inventory across variants">Qty</th>
        <th>B2B Status</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>` : `<p class="empty-state">No products match the current filters.</p>`;

  return layout({ title: 'Catalog', session, activePath: '/catalog', content: `
    <div class="page-header">
      <h1>Catalog</h1>
      <span class="text-muted">${products.length} products</span>
    </div>
    ${error ? `<div class="alert alert-warning">Shopify data unavailable: ${h(error)}</div>` : ''}
    ${filterBar}
    ${bulkBar}
    ${table}
    </form>
    <script>
    function updateBulkBar(){
      const checked=document.querySelectorAll('.row-check:checked');
      const bar=document.getElementById('bulk-bar');
      document.getElementById('bulk-count').textContent=checked.length;
      bar.style.display=checked.length?'flex':'none';
    }
    function selectAll(cb){
      document.querySelectorAll('.row-check').forEach(c=>{c.checked=cb.checked;});
      updateBulkBar();
    }
    function clearSelection(){
      document.querySelectorAll('.row-check').forEach(c=>{c.checked=false;});
      document.getElementById('select-all').checked=false;
      updateBulkBar();
    }
    </script>
  ` });
}

app.get('/catalog', requireAuth, async (req, res) => {
  const filters = {
    vendor: req.query.vendor || '',
    style:  req.query.style  || '',
    stock:  req.query.stock  || '',
    b2b:    req.query.b2b    || '',
    status: req.query.status || 'active',
  };
  const data = await getCatalogData(filters);
  res.send(renderCatalog(req.adminSession, data, filters));
});

app.get('/catalog/:id', requireAuth, async (req, res) => {
  res.redirect(`/products/${req.params.id}`);
});

app.post('/catalog/:id/publish', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const gid = `gid://shopify/Product/${numId}`;
  if (MOCK) {
    mockCatalogOverrides.set(numId, { publishedOnB2B: true });
  } else {
    try {
      await shopifyFetch(`mutation pub($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){userErrors{field message}}}`,
        { id: gid, input: [{ publicationId: B2B_PUB_ID }] });
    } catch (err) {
      console.error('publish error:', err.message);
    }
  }
  auditLog(req.adminSession.email, 'catalog:publish', gid, false, true);
  res.redirect('/catalog');
});

app.post('/catalog/:id/unpublish', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const gid = `gid://shopify/Product/${numId}`;
  if (MOCK) {
    mockCatalogOverrides.set(numId, { publishedOnB2B: false });
  } else {
    try {
      await shopifyFetch(`mutation unpub($id:ID!,$input:[PublicationInput!]!){publishableUnpublish(id:$id,input:$input){userErrors{field message}}}`,
        { id: gid, input: [{ publicationId: B2B_PUB_ID }] });
    } catch (err) {
      console.error('unpublish error:', err.message);
    }
  }
  auditLog(req.adminSession.email, 'catalog:unpublish', gid, true, false);
  res.redirect('/catalog');
});

app.post('/catalog/bulk', requireAuth, async (req, res) => {
  const ids    = [req.body.ids || []].flat().filter(Boolean);
  const action = req.body.action === 'publish' ? 'publish' : 'unpublish';
  for (const numId of ids) {
    const gid = `gid://shopify/Product/${numId}`;
    if (MOCK) {
      mockCatalogOverrides.set(numId, { publishedOnB2B: action === 'publish' });
    } else {
      try {
        if (action === 'publish') {
          await shopifyFetch(`mutation pub($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){userErrors{field message}}}`,
            { id: gid, input: [{ publicationId: B2B_PUB_ID }] });
        } else {
          await shopifyFetch(`mutation unpub($id:ID!,$input:[PublicationInput!]!){publishableUnpublish(id:$id,input:$input){userErrors{field message}}}`,
            { id: gid, input: [{ publicationId: B2B_PUB_ID }] });
        }
      } catch (err) { console.error(`bulk ${action} ${numId}:`, err.message); }
    }
    auditLog(req.adminSession.email, `catalog:bulk:${action}`, gid, null, null);
  }
  res.redirect('/catalog');
});

// ── Phase 19C: Product detail ─────────────────────────────────────────────────

async function getProductDetail(numericId) {
  if (MOCK) {
    const p = MOCK_PRODUCTS.find(x => shopifyNumericId(x.id) === numericId);
    if (!p) return null;
    // Find related orders for this product
    const variantSkus = new Set((p.variants?.edges || []).map(e => e.node.sku));
    const relatedOrders = MOCK_ORDERS.filter(o =>
      (o.lineItems?.edges || []).some(li => variantSkus.has(li.node.variant?.sku))
    ).slice(0, 10).map(o => ({
      id: o.id, name: o.name, processedAt: o.processedAt,
      customer: o.customer,
      displayFinancialStatus: o.displayFinancialStatus,
      total: o.totalPriceSet?.presentmentMoney?.amount,
    }));
    const catalogEntry = MOCK_CATALOG_PRODUCTS.find(x => shopifyNumericId(x.id) === numericId);
    return {
      ...p,
      status: catalogEntry?.status || 'active',
      publishedOnB2B: catalogEntry?.publishedOnB2B ?? true,
      relatedOrders,
    };
  }
  try {
    const result = await shopifyFetch(`
      query($id:ID!){product(id:$id){
        id title handle vendor productType status tags
        featuredImage{url altText}
        images(first:10){edges{node{url altText}}}
        variants(first:50){edges{node{
          id title sku barcode price compareAtPrice inventoryQuantity
          inventoryItem{tracked}
        }}}
        publishedOnPublication(publicationId:"${B2B_PUB_ID}")
      }}`, { id: `gid://shopify/Product/${numericId}` });
    const p = result.data?.product;
    if (!p) return null;
    // Fetch recent orders containing this product
    const ordersResult = await shopifyFetch(`
      query($q:String!){orders(first:10,query:$q,sortKey:PROCESSED_AT,reverse:true){
        edges{node{id name processedAt
          customer{id displayName email}
          displayFinancialStatus
          totalPriceSet{presentmentMoney{amount}}
        }}
      }}`, { q: `sku:${(p.variants?.edges?.[0]?.node?.sku || '')}` });
    const relatedOrders = (ordersResult.data?.orders?.edges || []).map(e => ({
      id: e.node.id, name: e.node.name, processedAt: e.node.processedAt,
      customer: e.node.customer,
      displayFinancialStatus: e.node.displayFinancialStatus,
      total: e.node.totalPriceSet?.presentmentMoney?.amount,
    }));
    return { ...p, publishedOnB2B: p.publishedOnPublication, relatedOrders };
  } catch (err) {
    console.error('getProductDetail error:', err.message);
    return null;
  }
}

function renderProductDetail(session, product) {
  const numId = shopifyNumericId(product.id);
  const variants = (product.variants?.edges || []).map(e => e.node);
  const images   = (product.images?.edges || []).map(e => e.node);
  const tags     = product.tags || [];
  const style    = tags.find(t => t.startsWith('Style_'))?.replace('Style_', '') || '';
  const isB2B    = product.publishedOnB2B;

  const variantRows = variants.map(v => `<tr>
    <td>${h(v.title)}</td>
    <td class="mono">${h(v.sku || '—')}</td>
    <td class="mono">${h(v.barcode || '—')}</td>
    <td class="text-right">${fmtMoney(v.price)}</td>
    <td class="text-right text-muted">${fmtMoney(v.compareAtPrice)}</td>
    <td class="text-right ${v.inventoryQuantity <= 0 ? 'text-danger' : v.inventoryQuantity < 10 ? 'text-warning' : ''}">${v.inventoryQuantity ?? '—'}</td>
  </tr>`).join('');

  const imageThumbs = images.slice(0, 6).map(img =>
    `<img src="${h(img.url)}" alt="${h(img.altText || '')}" style="width:80px;height:80px;object-fit:cover;border-radius:4px;border:1px solid var(--border)">`
  ).join('');

  const relatedOrderRows = (product.relatedOrders || []).map(o => {
    const oNum = shopifyNumericId(o.id);
    const cNum = o.customer ? shopifyNumericId(o.customer.id) : null;
    return `<tr>
      <td><a href="/orders/${oNum}" class="link">${h(o.name)}</a></td>
      <td>${cNum ? `<a href="/customers/${cNum}" class="link">${h(o.customer.displayName)}</a>` : '—'}</td>
      <td class="text-muted">${fmtDate(o.processedAt)}</td>
      <td><span class="badge badge-${(o.displayFinancialStatus||'').toLowerCase()}">${h(o.displayFinancialStatus||'')}</span></td>
      <td class="text-right mono">${fmtMoney(o.total)}</td>
    </tr>`;
  }).join('');

  const shopifyEditUrl = `https://admin.shopify.com/store/fuzzywumpets/products/${numId}`;

  const nonFwwBanner = (product.vendor && product.vendor !== 'Fuzzywumpets')
    ? `<div class="alert alert-info" style="margin-bottom:16px">ℹ This product is from vendor <strong>${h(product.vendor)}</strong> (not Fuzzywumpets). Most catalog operations don't apply.</div>`
    : '';

  return layout({ title: product.title, session, activePath: '/catalog', content: `
    <div class="breadcrumb-row"><a href="/catalog" class="breadcrumb">← Catalog</a></div>
    ${nonFwwBanner}
    <div class="detail-header">
      <div class="detail-header-left">
        <h1>${h(product.title)}</h1>
        <p class="text-muted">
          ${h(product.vendor || '')}${product.productType ? ` · ${h(product.productType)}` : ''}
          ${style ? ` · <strong>${h(style)}</strong>` : ''}
          · <code>${h(product.handle || '')}</code>
        </p>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          <span class="badge badge-${(product.status||'active').toLowerCase()}">${h(product.status||'Active')}</span>
          <span class="badge ${isB2B ? 'badge-success' : 'badge-secondary'}">${isB2B ? 'B2B Published' : 'Not on B2B'}</span>
          ${tags.map(t => tagChip(t)).join('')}
        </div>
      </div>
      <div class="detail-header-actions">
        <a href="${h(shopifyEditUrl)}" target="_blank" rel="noopener" class="btn btn-secondary">Edit in Shopify ↗</a>
        ${isB2B
          ? `<form method="POST" action="/catalog/${numId}/unpublish" style="display:inline">
              <button class="btn btn-ghost btn-sm">Remove from B2B</button></form>`
          : `<form method="POST" action="/catalog/${numId}/publish" style="display:inline">
              <button class="btn btn-primary btn-sm">Publish to B2B</button></form>`}
      </div>
    </div>

    <div class="detail-grid">
      <div class="detail-main">
        ${imageThumbs ? `<div class="card"><div class="card-header"><h2>Images</h2></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">${imageThumbs}</div></div>` : ''}

        <div class="card">
          <div class="card-header"><h2>Variants (${variants.length})</h2></div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr>
                <th>Variant</th><th>SKU</th><th>UPC/Barcode</th>
                <th class="text-right">Price (MSRP)</th>
                <th class="text-right">Compare at</th>
                <th class="text-right">Inventory</th>
              </tr></thead>
              <tbody>${variantRows || '<tr><td colspan="6" class="empty-state">No variants</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        ${product.relatedOrders?.length ? `<div class="card">
          <div class="card-header"><h2>Recent orders with this product</h2></div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Status</th><th class="text-right">Total</th></tr></thead>
              <tbody>${relatedOrderRows}</tbody>
            </table>
          </div>
        </div>` : ''}
      </div>

      <div class="detail-side">
        <div class="card">
          <div class="card-header"><h2>Publication status</h2></div>
          <p>
            <span class="badge ${isB2B ? 'badge-success' : 'badge-secondary'}">
              ${isB2B ? '✓ On B2B catalog' : '✗ Not on B2B catalog'}
            </span>
          </p>
        </div>
        <div class="card">
          <div class="card-header"><h2>Details</h2></div>
          <table class="mini-table">
            <tr><td class="text-muted">Vendor</td><td>${h(product.vendor || '—')}</td></tr>
            <tr><td class="text-muted">Type</td><td>${h(product.productType || '—')}</td></tr>
            <tr><td class="text-muted">Handle</td><td><code>${h(product.handle || '—')}</code></td></tr>
            <tr><td class="text-muted">Style</td><td>${h(style || '—')}</td></tr>
            <tr><td class="text-muted">Shopify ID</td><td><code>${numId}</code></td></tr>
          </table>
        </div>
      </div>
    </div>
  ` });
}

app.get('/products/:id', requireAuth, async (req, res) => {
  const numId = req.params.id;
  const product = await getProductDetail(numId);
  if (!product) {
    return res.status(404).send(layout({ title: 'Product not found', session: req.adminSession, activePath: '/catalog', content: `
      <div class="breadcrumb-row"><a href="/catalog" class="breadcrumb">← Catalog</a></div>
      <div class="empty-state">Product ${h(numId)} not found</div>
    ` }));
  }
  res.send(renderProductDetail(req.adminSession, product));
});

// ── Reports ───────────────────────────────────────────────────────────────────

async function getReportsData() {
  if (MOCK) {
    return {
      monthly:    MOCK_MONTHLY_REVENUE,
      customers:  MOCK_CUSTOMER_REVENUE,
      products:   MOCK_PRODUCT_REVENUE,
      totalRevenue: MOCK_MONTHLY_REVENUE.reduce((s, d) => s + d.revenue, 0),
      totalOrders:  MOCK_MONTHLY_REVENUE.reduce((s, d) => s + d.orders, 0),
      aov: Math.round(MOCK_MONTHLY_REVENUE.reduce((s,d)=>s+d.revenue,0) / MOCK_MONTHLY_REVENUE.reduce((s,d)=>s+d.orders,0)),
    };
  }
  try {
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const allOrders = [];
    let after = null;
    let pageCount = 0;
    while (pageCount < 10) {
      const result = await shopifyFetch(`
        query($q:String!,$first:Int!,$after:String){
          orders(first:$first,query:$q,after:$after,sortKey:PROCESSED_AT,reverse:true){
            edges{cursor node{
              id processedAt
              customer{id displayName email}
              totalPriceSet{presentmentMoney{amount}}
              lineItems(first:50){edges{node{
                title quantity
                variant{sku}
                discountedUnitPriceSet{presentmentMoney{amount}}
              }}}
            }}
            pageInfo{hasNextPage endCursor}
          }
        }`, { q: `tag:b2b-portal created_at:>${cutoff}`, first: 250, after });
      const edges = result.data?.orders?.edges || [];
      allOrders.push(...edges.map(e => e.node));
      if (!result.data?.orders?.pageInfo?.hasNextPage) break;
      after = result.data?.orders?.pageInfo?.endCursor;
      pageCount++;
    }

    // Aggregate monthly
    const monthMap = new Map();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      monthMap.set(key, { month: key, revenue: 0, orders: 0 });
    }
    const customerMap = new Map();
    const productMap  = new Map();
    for (const o of allOrders) {
      const m = (o.processedAt || '').slice(0, 7);
      if (monthMap.has(m)) {
        const d = monthMap.get(m);
        d.revenue += parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0);
        d.orders++;
      }
      if (o.customer) {
        const { id, displayName, email } = o.customer;
        const amt = parseFloat(o.totalPriceSet?.presentmentMoney?.amount || 0);
        if (!customerMap.has(id)) customerMap.set(id, { id: shopifyNumericId(id), name: displayName, email, revenue: 0, orders: 0 });
        const c = customerMap.get(id); c.revenue += amt; c.orders++;
      }
      for (const li of (o.lineItems?.edges || [])) {
        const { title, quantity, variant, discountedUnitPriceSet: dp } = li.node;
        const sku = variant?.sku || '';
        const rev = parseFloat(dp?.presentmentMoney?.amount || 0) * quantity;
        const key = sku || title;
        if (!productMap.has(key)) productMap.set(key, { title, sku, revenue: 0, units: 0 });
        const p = productMap.get(key); p.revenue += rev; p.units += quantity;
      }
    }
    const monthly   = [...monthMap.values()];
    const customers = [...customerMap.values()].sort((a,b)=>b.revenue-a.revenue).slice(0,20).map(c => ({ ...c, aov: c.orders ? Math.round(c.revenue/c.orders) : 0 }));
    const products  = [...productMap.values()].sort((a,b)=>b.revenue-a.revenue).slice(0,50);
    const totalRevenue = monthly.reduce((s,d)=>s+d.revenue,0);
    const totalOrders  = monthly.reduce((s,d)=>s+d.orders,0);
    return { monthly, customers, products, totalRevenue, totalOrders, aov: totalOrders ? Math.round(totalRevenue/totalOrders) : 0 };
  } catch (err) {
    console.error('getReportsData error:', err.message);
    return { monthly: [], customers: [], products: [], totalRevenue: 0, totalOrders: 0, aov: 0, error: err.message };
  }
}

function renderReports(session, data) {
  const { monthly, customers, products, totalRevenue, totalOrders, aov, error } = data;

  const chartData = monthly.map(d => ({ label: d.month.slice(5), value: d.revenue }));
  const chart = renderBarChart(chartData, { width: 580, height: 110 });

  const customerRows = (customers||[]).map((c, i) => {
    const spark = renderSparkline([c.revenue], { width: 64, height: 20 });
    return `<tr>
      <td class="text-muted">${i+1}</td>
      <td><a href="/customers/${h(c.id)}">${h(c.name)}</a><br><small class="text-muted">${h(c.email)}</small></td>
      <td>${fmtMoney(c.revenue)}</td>
      <td>${c.orders}</td>
      <td>${fmtMoney(c.aov)}</td>
      <td>${spark}</td>
    </tr>`;
  }).join('');

  const productRows = (products||[]).map((p, i) => `<tr>
    <td class="text-muted">${i+1}</td>
    <td>${h(p.title)}</td>
    <td class="mono text-sm">${h(p.sku||'—')}</td>
    <td>${fmtMoney(p.revenue)}</td>
    <td>${p.units}</td>
    <td>${p.units ? fmtMoney(p.revenue / p.units) : '—'}</td>
  </tr>`).join('');

  return layout({ title: 'Reports', session, activePath: '/reports', content: `
    <div class="page-header">
      <h1>Reports</h1>
      <span class="text-muted">Last 12 months</span>
    </div>
    ${error ? `<div class="alert alert-warning">Shopify data unavailable: ${h(error)}</div>` : ''}
    <div class="report-stats">
      <div class="stat-card"><div class="stat-value">${fmtMoney(totalRevenue)}</div><div class="stat-label">Total Revenue</div></div>
      <div class="stat-card"><div class="stat-value">${totalOrders}</div><div class="stat-label">Total Orders</div></div>
      <div class="stat-card"><div class="stat-value">${fmtMoney(aov)}</div><div class="stat-label">Avg Order Value</div></div>
    </div>

    <div class="report-section">
      <div class="report-section-header">
        <h2>Monthly Revenue (last 12 months)</h2>
        <a href="/reports/csv/monthly" class="btn btn-ghost btn-sm">↓ CSV</a>
      </div>
      <div class="chart-container">${chart}</div>
      <table class="data-table data-table-sm">
        <thead><tr><th>Month</th><th>Revenue</th><th>Orders</th><th>AOV</th></tr></thead>
        <tbody>
        ${(monthly||[]).map(d => `<tr>
          <td>${h(d.month)}</td>
          <td>${fmtMoney(d.revenue)}</td>
          <td>${d.orders}</td>
          <td>${d.orders ? fmtMoney(d.revenue / d.orders) : '—'}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="report-section">
      <div class="report-section-header">
        <h2>Sales by Customer (top ${customers?.length||0})</h2>
        <a href="/reports/csv/customers" class="btn btn-ghost btn-sm">↓ CSV</a>
      </div>
      <table class="data-table data-table-sm">
        <thead><tr><th>#</th><th>Customer</th><th>Revenue</th><th>Orders</th><th>AOV</th><th>Trend</th></tr></thead>
        <tbody>${customerRows||'<tr><td colspan="6" class="empty-state">No data</td></tr>'}</tbody>
      </table>
    </div>

    <div class="report-section">
      <div class="report-section-header">
        <h2>Sales by Product (top ${products?.length||0})</h2>
        <a href="/reports/csv/products" class="btn btn-ghost btn-sm">↓ CSV</a>
      </div>
      <table class="data-table data-table-sm">
        <thead><tr><th>#</th><th>Product</th><th>SKU</th><th>Revenue</th><th>Units</th><th>Avg Price</th></tr></thead>
        <tbody>${productRows||'<tr><td colspan="6" class="empty-state">No data</td></tr>'}</tbody>
      </table>
    </div>
  ` });
}

app.get('/reports', requireAuth, async (req, res) => {
  const data = await getReportsData();
  res.send(renderReports(req.adminSession, data));
});

app.get('/reports/csv/:type', requireAuth, async (req, res) => {
  const data = await getReportsData();
  const ts   = new Date().toISOString().slice(0, 10);
  const type = req.params.type;

  if (type === 'monthly') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fww-revenue-monthly-${ts}.csv"`);
    res.write(csvLine(['month','revenue','orders','aov']));
    for (const d of (data.monthly||[])) {
      res.write(csvLine([d.month, d.revenue.toFixed(2), d.orders, d.orders ? (d.revenue/d.orders).toFixed(2) : '0']));
    }
    return res.end();
  }
  if (type === 'customers') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fww-revenue-customers-${ts}.csv"`);
    res.write(csvLine(['rank','name','email','revenue','orders','aov']));
    (data.customers||[]).forEach((c, i) => res.write(csvLine([i+1, c.name, c.email, c.revenue.toFixed(2), c.orders, c.aov])));
    return res.end();
  }
  if (type === 'products') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fww-revenue-products-${ts}.csv"`);
    res.write(csvLine(['rank','title','sku','revenue','units','avg_price']));
    (data.products||[]).forEach((p, i) => res.write(csvLine([i+1, p.title, p.sku||'', p.revenue.toFixed(2), p.units, p.units ? (p.revenue/p.units).toFixed(2) : '0'])));
    return res.end();
  }
  res.status(404).send('Unknown CSV type');
});

// ── Settings ──────────────────────────────────────────────────────────────────

function getSettingsData(flash) {
  const settings = {
    b2b_discount_pct:    getSetting('b2b_discount_pct')    ?? '50',
    order_minimum:       getSetting('order_minimum')       ?? '0',
    payment_terms:       getSetting('payment_terms')       ?? 'Net 30',
    catalog_private_tags: getSetting('catalog_private_tags') ?? '',
  };
  const allowlist = MOCK
    ? ['alex@fuzzywumpets.com', 'alexa@fuzzywumpets.com']
    : (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
  return { settings, allowlist, flash };
}

function renderSettings(session, { settings, allowlist, flash }) {
  const flashHtml = flash
    ? `<div class="alert ${flash.ok ? 'alert-success' : 'alert-error'}" style="margin-bottom:1rem">${h(flash.msg)}</div>`
    : '';
  return layout({ title: 'Settings', session, activePath: '/settings', content: `
    <div class="page-header"><h1>Settings</h1></div>
    ${flashHtml}

    <div class="settings-grid">
      <section class="settings-section">
        <h2>B2B Config</h2>
        <form method="POST" action="/settings" class="settings-form">
          <div class="form-row">
            <label>B2B Discount %</label>
            <input type="number" name="b2b_discount_pct" value="${h(settings.b2b_discount_pct)}" min="0" max="100" step="1" class="form-input" style="width:80px">
            <small class="text-muted">Applied to all B2B orders (default 50%)</small>
          </div>
          <div class="form-row">
            <label>Order Minimum ($)</label>
            <input type="number" name="order_minimum" value="${h(settings.order_minimum)}" min="0" step="0.01" class="form-input" style="width:100px">
            <small class="text-muted">Minimum order value for B2B checkout (0 = no minimum)</small>
          </div>
          <div class="form-row">
            <label>Payment Terms</label>
            <input type="text" name="payment_terms" value="${h(settings.payment_terms)}" maxlength="100" class="form-input" style="width:200px">
            <small class="text-muted">Shown on invoices (e.g. "Net 30", "Due on receipt")</small>
          </div>
          <div class="form-row">
            <label>Private catalog tags</label>
            <input type="text" name="catalog_private_tags" value="${h(settings.catalog_private_tags || '')}" maxlength="500" class="form-input" style="width:300px">
            <small class="text-muted">Comma-separated Shopify product tags treated as "private." Products with these tags are only visible to customers whose Custom catalog tags (on their B2B settings) include a match.</small>
          </div>
          <button type="submit" class="btn btn-primary">Save Config</button>
        </form>
      </section>

      <section class="settings-section">
        <h2>Admin Allowlist</h2>
        <p class="text-muted" style="font-size:0.85rem;margin-bottom:0.75rem">Emails that may log in to this admin panel.</p>
        <ul class="allowlist">
          ${allowlist.map(e => `<li>${h(e)}</li>`).join('')}
        </ul>
        <form method="POST" action="/settings/allowlist/add" class="settings-form" style="margin-top:0.75rem;display:flex;gap:0.5rem;align-items:center">
          <input type="email" name="email" placeholder="new@fuzzywumpets.com" class="form-input" style="width:240px" required>
          <button type="submit" class="btn btn-secondary">+ Add</button>
        </form>
      </section>

      <section class="settings-section settings-readonly">
        <h2>Read-only Info</h2>
        <dl class="info-grid">
          <dt>B2B Publication ID</dt><dd class="mono">${h(B2B_PUB_ID)}</dd>
          <dt>OAuth Redirect URI</dt><dd class="mono">${h(REDIRECT_URI)}</dd>
          <dt>Environment</dt><dd>${MOCK ? '<span class="badge badge-pending">MOCK</span>' : '<span class="badge badge-paid">PRODUCTION</span>'}</dd>
        </dl>
      </section>
    </div>
  ` });
}

app.get('/settings', requireAuth, (req, res) => {
  const flash = req.query.flash ? { ok: req.query.flash === 'ok', msg: req.query.msg || (req.query.flash === 'ok' ? 'Settings saved.' : 'Error saving settings.') } : null;
  res.send(renderSettings(req.adminSession, getSettingsData(flash)));
});

app.post('/settings', requireAuth, (req, res) => {
  const { b2b_discount_pct, order_minimum, payment_terms, catalog_private_tags } = req.body;
  try {
    if (b2b_discount_pct    !== undefined) setSetting('b2b_discount_pct',    String(Number(b2b_discount_pct) || 50));
    if (order_minimum       !== undefined) setSetting('order_minimum',        String(Number(order_minimum)    || 0));
    if (payment_terms       !== undefined) setSetting('payment_terms',        String(payment_terms).slice(0, 100));
    if (catalog_private_tags !== undefined) setSetting('catalog_private_tags', String(catalog_private_tags || '').slice(0, 500));
    auditLog(req.adminSession.email, 'settings:update', null, null, { b2b_discount_pct, order_minimum, payment_terms, catalog_private_tags });
    res.redirect('/settings?flash=ok&msg=Settings+saved.');
  } catch (err) {
    res.redirect(`/settings?flash=err&msg=${encodeURIComponent(err.message)}`);
  }
});

app.post('/settings/allowlist/add', requireAuth, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email)) {
    return res.redirect('/settings?flash=err&msg=Invalid+email+address.');
  }
  if (MOCK) {
    return res.redirect(`/settings?flash=ok&msg=${encodeURIComponent(`${email} added (mock mode — not persisted).`)}`);
  }
  try {
    const current = (process.env.B2B_ADMIN_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (current.includes(email)) {
      return res.redirect(`/settings?flash=ok&msg=${encodeURIComponent(`${email} is already on the allowlist.`)}`);
    }
    const newList = [...current, email].join(',');
    const result = spawnSync('doppler', ['secrets', 'set', `B2B_ADMIN_ALLOWED_EMAILS=${newList}`], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error(result.stderr || 'doppler command failed');
    process.env.B2B_ADMIN_ALLOWED_EMAILS = newList;
    auditLog(req.adminSession.email, 'settings:allowlist:add', email, null, null);
    res.redirect(`/settings?flash=ok&msg=${encodeURIComponent(`${email} added to allowlist.`)}`);
  } catch (err) {
    res.redirect(`/settings?flash=err&msg=${encodeURIComponent(err.message)}`);
  }
});

// ── SparkLayer Migration ───────────────────────────────────────────────────────

async function getMigrateData() {
  if (MOCK) {
    const candidates = MOCK_SPARKLAYER_CUSTOMERS.map(c => ({
      ...c, numId: shopifyNumericId(c.id),
      alreadyB2B: c.tags.includes('b2b') || mockSparkLayerMigrated.has(shopifyNumericId(c.id)),
    }));
    return { candidates, total: candidates.length, alreadyMigrated: candidates.filter(c => c.alreadyB2B).length };
  }
  try {
    const result = await shopifyFetch(`
      query($q:String!,$after:String){
        customers(first:50,query:$q,after:$after){
          edges{node{id displayName email tags}}
          pageInfo{hasNextPage endCursor}
        }
      }`, { q: 'tag:sparklayer', after: null });
    const candidates = (result.data?.customers?.edges || []).map(e => ({
      ...e.node, numId: shopifyNumericId(e.node.id),
      alreadyB2B: (e.node.tags || []).includes('b2b'),
    }));
    return { candidates, total: candidates.length, alreadyMigrated: candidates.filter(c => c.alreadyB2B).length };
  } catch (err) {
    console.error('getMigrateData error:', err.message);
    return { candidates: [], total: 0, alreadyMigrated: 0, error: err.message };
  }
}

function renderMigrate(session, data, flash) {
  const { candidates, total, alreadyMigrated, error } = data;
  const flashHtml = flash ? `<div class="alert ${flash.ok?'alert-success':'alert-error'}" style="margin-bottom:1rem">${h(flash.msg)}</div>` : '';
  const pending = candidates.filter(c => !c.alreadyB2B);
  const done    = candidates.filter(c => c.alreadyB2B);

  const rows = candidates.map(c => `<tr class="${c.alreadyB2B ? 'row-done' : ''}">
    <td>${c.alreadyB2B ? '✓' : '<input type="checkbox" name="ids" value="'+h(c.numId)+'" checked>'}</td>
    <td><a href="/customers/${h(c.numId)}">${h(c.displayName)}</a></td>
    <td>${h(c.email)}</td>
    <td class="text-sm">${(c.tags||[]).map(t => `<span class="tag-chip">${h(t)}</span>`).join(' ')}</td>
    <td>${c.alreadyB2B ? '<span class="badge badge-paid">Already b2b</span>' : '<span class="badge badge-pending">Needs migration</span>'}</td>
  </tr>`).join('');

  return layout({ title: 'SparkLayer Migration', session, activePath: '/migrate', content: `
    <div class="page-header">
      <h1>SparkLayer Migration</h1>
      <span class="text-muted">Tag legacy SparkLayer customers with <code>b2b</code></span>
    </div>
    ${flashHtml}
    ${error ? `<div class="alert alert-warning">Shopify data unavailable: ${h(error)}</div>` : ''}

    <div class="report-stats" style="margin-bottom:1.5rem">
      <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">SparkLayer Customers Found</div></div>
      <div class="stat-card"><div class="stat-value">${alreadyMigrated}</div><div class="stat-label">Already Have b2b Tag</div></div>
      <div class="stat-card"><div class="stat-value">${pending.length}</div><div class="stat-label">Pending Migration</div></div>
    </div>

    ${pending.length === 0 ? `<div class="alert alert-success">All SparkLayer customers are already tagged <code>b2b</code>. Nothing to migrate.</div>` : `
    <form method="POST" action="/migrate/run">
      <div style="margin-bottom:1rem">
        <strong>${pending.length} customers</strong> will receive the <code>b2b</code> tag. This is idempotent — re-running is safe.
      </div>
      <button type="submit" class="btn btn-primary" onclick="return confirm('Tag ${pending.length} customers with b2b? This writes to Shopify.')">
        Run Migration (${pending.length} customers)
      </button>
    </form>`}

    ${candidates.length ? `
    <div class="report-section" style="margin-top:2rem">
      <h2>All SparkLayer Customers</h2>
      <table class="data-table data-table-sm">
        <thead><tr><th>Select</th><th>Name</th><th>Email</th><th>Current Tags</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : ''}
  ` });
}

app.get('/migrate', requireAuth, async (req, res) => {
  const flash = req.query.flash ? { ok: req.query.flash === 'ok', msg: req.query.msg || '' } : null;
  const data = await getMigrateData();
  res.send(renderMigrate(req.adminSession, data, flash));
});

app.post('/migrate/run', requireAuth, async (req, res) => {
  const data = await getMigrateData();
  const pending = data.candidates.filter(c => !c.alreadyB2B);
  let migrated = 0;
  let errors   = 0;
  for (const c of pending) {
    try {
      if (MOCK) {
        mockSparkLayerMigrated.add(c.numId);
      } else {
        await shopifyFetch(`mutation tagsAdd($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){node{id} userErrors{field message}}}`,
          { id: c.id, tags: ['b2b'] });
      }
      auditLog(req.adminSession.email, 'migrate:sparklayer:tag_b2b', c.id, JSON.stringify(c.tags), JSON.stringify([...c.tags, 'b2b']));
      migrated++;
    } catch (err) {
      console.error(`migrate ${c.id}:`, err.message);
      errors++;
    }
  }
  const msg = errors
    ? `Migrated ${migrated}, errors on ${errors}. Check logs.`
    : `Successfully tagged ${migrated} customer${migrated!==1?'s':''} with b2b.`;
  res.redirect(`/migrate?flash=${errors?'err':'ok'}&msg=${encodeURIComponent(msg)}`);
});

// ── Audit log ─────────────────────────────────────────────────────────────────

app.get('/audit', requireAuth, (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 100;
  const offset = (page - 1) * limit;
  const rows  = getAuditLog({ limit, offset });
  const total = getAuditLogCount();
  const pages = Math.ceil(total / limit);

  function auditTargetLink(target) {
    if (!target) return '—';
    // Shopify GID: gid://shopify/Order/123, gid://shopify/Customer/456
    const gidM = /^gid:\/\/shopify\/(Order|Customer)\/(\d+)$/.exec(target);
    if (gidM) {
      const [, type, id] = gidM;
      const url = type === 'Order' ? `/orders/${id}` : `/customers/${id}`;
      const label = `${type} #${id}`;
      return `<a href="${url}" class="link">${h(label)}</a>`;
    }
    // Short patterns: "lead:5"
    const shortM = /^lead:(\d+)$/.exec(target);
    if (shortM) {
      return `<a href="/leads/${shortM[1]}" class="link">${h(target)}</a>`;
    }
    return `<span title="${h(target)}" style="max-width:200px;display:inline-block;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom">${h(target)}</span>`;
  }

  const tableRows = rows.map(r => `<tr>
    <td class="mono text-sm">${new Date(r.ts).toISOString().replace('T',' ').slice(0,19)}</td>
    <td><a href="mailto:${h(r.email)}" class="link">${h(r.email)}</a></td>
    <td class="mono">${h(r.action)}</td>
    <td class="text-sm text-muted">${auditTargetLink(r.target)}</td>
    <td class="text-sm mono" style="max-width:150px;overflow:hidden;text-overflow:ellipsis">${h(r.after_val||'')}</td>
  </tr>`).join('');

  const pagination = pages > 1 ? `<div class="pagination">
    ${page > 1 ? `<a href="/audit?page=${page-1}" class="btn btn-ghost btn-sm">← Prev</a>` : ''}
    <span class="text-muted">Page ${page} of ${pages} (${total} entries)</span>
    ${page < pages ? `<a href="/audit?page=${page+1}" class="btn btn-ghost btn-sm">Next →</a>` : ''}
  </div>` : `<p class="text-muted">${total} entries</p>`;

  res.send(layout({ title: 'Audit Log', session: req.adminSession, activePath: '/audit', content: `
    <div class="page-header"><h1>Audit Log</h1></div>
    ${pagination}
    <table class="data-table data-table-sm">
      <thead><tr><th>Time (UTC)</th><th>User</th><th>Action</th><th>Target</th><th>After</th></tr></thead>
      <tbody>${tableRows || '<tr><td colspan="5" class="empty-state">No audit entries yet.</td></tr>'}</tbody>
    </table>
    ${pagination}
  ` }));
});

// ── Phase 5: Labels ───────────────────────────────────────────────────────────

// Mock data for labels (products with barcodes for test/demo)
const MOCK_LABEL_PRODUCTS = MOCK_PRODUCTS;

async function getProductsForLabels(ids) {
  if (MOCK) {
    if (ids && ids.length) return MOCK_LABEL_PRODUCTS.filter(p => ids.includes(shopifyNumericId(p.id)));
    return MOCK_LABEL_PRODUCTS;
  }
  const gids = ids.map(id => `gid://shopify/Product/${id}`);
  const result = await shopifyFetch(`
    query($ids:[ID!]!){nodes(ids:$ids){... on Product{
      id handle title vendor productType tags barcode
      variants(first:30){edges{node{id title sku price compareAtPrice barcode inventoryQuantity}}}
    }}}`, { ids: gids });
  return (result.data?.nodes || []).filter(Boolean);
}

async function getOrderForLabels(numericId) {
  if (MOCK) {
    const o = MOCK_ORDERS.find(o => shopifyNumericId(o.id) === numericId);
    if (!o) return null;
    return { order: o, items: o.lineItems.edges.map(e => {
      const v = e.node.variant || {};
      return {
        barcode:      v.barcode || '',
        title:        e.node.title,
        variantTitle: v.displayName || v.sku || 'Default Title',
        sku:          v.sku || '',
        price:        v.price || '0.00',
        qty:          e.node.quantity,
      };
    })};
  }
  const result = await shopifyFetch(`
    query($id:ID!){order(id:$id){
      name
      lineItems(first:50){edges{node{
        title quantity
        variant{id sku price barcode displayName}
      }}}
    }}`, { id: `gid://shopify/Order/${numericId}` });
  const o = result.data?.order;
  if (!o) return null;
  return {
    order: o,
    items: o.lineItems.edges.map(e => ({
      barcode:      e.node.variant?.barcode || '',
      title:        e.node.title,
      variantTitle: e.node.variant?.displayName || e.node.variant?.sku || '',
      sku:          e.node.variant?.sku || '',
      price:        e.node.variant?.price || '0.00',
      qty:          e.node.quantity,
    })),
  };
}

function renderLabelsPage(session, { source, orderData, productItems, flash, savedTemplate, savedFields, queryOrder = '', queryQ = '' }) {
  const sf = savedFields || DEFAULT_FIELDS;
  const templateOptions = Object.entries(LABEL_TEMPLATES)
    .map(([k, v]) => `<option value="${h(k)}"${k === (savedTemplate || 'avery-5160') ? ' selected' : ''}>${h(v.name)}</option>`)
    .join('');

  const fieldCheckboxes = [
    { key: 'productName', label: 'Product name' },
    { key: 'variantName', label: 'Variant name' },
    { key: 'msrp',        label: 'Retail price (MSRP)' },
    { key: 'sku',         label: 'SKU' },
    { key: 'upcBarcode',  label: 'UPC barcode (graphic)' },
    { key: 'upcDigits',   label: 'UPC digits (text)' },
  ].map(f => `<label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer;white-space:nowrap">
      <input type="checkbox" name="field_${h(f.key)}" value="1"${sf[f.key] !== false ? ' checked' : ''} class="field-sel">
      ${h(f.label)}
    </label>`).join('');

  const optionsForm = `
    <div class="settings-section" style="margin-top:1rem">
      <h3 style="font-size:0.9rem;margin-bottom:0.75rem">Options</h3>
      <div class="form-row">
        <label>Label size</label>
        <select name="template" class="form-input">${templateOptions}</select>
      </div>
      <div class="form-row" style="align-items:flex-start">
        <label style="min-width:120px;padding-top:2px">Include on label</label>
        <div style="display:flex;flex-wrap:wrap;gap:0.5rem 1rem">${fieldCheckboxes}</div>
      </div>
    </div>`;

  const flashHtml = flash ? `<div class="alert ${flash.ok ? 'alert-success' : 'alert-error'}" style="margin-bottom:1rem">${h(flash)}</div>` : '';

  // Build items table if we have data
  let itemsTable = '';
  let hiddenItems = '';
  const allItems = source === 'order' ? (orderData?.items || []) : (productItems || []);
  const skippedCount = allItems.filter(i => !i.barcode || !/^\d{12,13}$/.test(String(i.barcode))).length;

  if (allItems.length) {
    const skippedWarn = skippedCount > 0
      ? `<div class="alert alert-error" style="margin-bottom:0.75rem">${skippedCount} variant${skippedCount > 1 ? 's have' : ' has'} no valid UPC barcode and will be skipped.</div>`
      : '';
    const rows = allItems.map((item, idx) => {
      const hasBarcode = item.barcode && /^\d{12,13}$/.test(String(item.barcode));
      return `<tr class="${hasBarcode ? '' : 'row-muted'}">
        <td><input type="checkbox" name="sel" value="${idx}"${hasBarcode ? ' checked' : ' disabled'} class="item-sel"></td>
        <td>${h(item.title)}</td>
        <td class="text-sm text-muted">${h(item.variantTitle || '')}</td>
        <td class="mono text-sm">${hasBarcode ? h(item.barcode) : '<span class="text-muted">—</span>'}</td>
        <td><input type="number" name="item_qty_${idx}" value="${item.qty || 1}" min="1" max="999" style="width:60px" class="form-input form-input-sm"></td>
        <td class="text-sm">${item.price ? '$' + h(String(item.price)) : '—'}</td>
      </tr>
      <input type="hidden" name="item_barcode_${idx}" value="${h(item.barcode || '')}">
      <input type="hidden" name="item_title_${idx}" value="${h(item.title || '')}">
      <input type="hidden" name="item_variant_${idx}" value="${h(item.variantTitle || '')}">
      <input type="hidden" name="item_sku_${idx}" value="${h(item.sku || '')}">
      <input type="hidden" name="item_price_${idx}" value="${h(item.price || '')}">`;
    }).join('');
    itemsTable = `
      <input type="hidden" name="item_count" value="${allItems.length}">
      ${skippedWarn}
      <div class="table-wrap" style="margin-top:0.75rem">
        <table class="data-table data-table-sm">
          <thead><tr><th style="width:30px"></th><th>Product</th><th>Variant</th><th>UPC</th><th style="width:70px">Qty</th><th>Price</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:1rem;display:flex;gap:0.75rem;flex-wrap:wrap">
        <button type="submit" formaction="/labels/preview" formtarget="_blank" class="btn btn-secondary">Preview PDF</button>
        <button type="submit" formaction="/labels/print" class="btn btn-primary">Download PDF</button>
      </div>`;
  }

  // Order tab: optionsForm always visible; items table conditional
  const orderItemsSection = source === 'order' && allItems.length
    ? `<form method="POST">${optionsForm}${itemsTable}</form>`
    : `<div>${optionsForm}</div>`;

  const fromOrderTab = `
    <div>
      <form method="GET" action="/labels" style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.75rem">
        <input type="hidden" name="source" value="order">
        <input type="text" name="order" placeholder="Order # (e.g. 1001)" class="form-input search-input" style="width:220px" value="${h(queryOrder)}">
        <button type="submit" class="btn btn-secondary">Load Order</button>
      </form>
      ${source === 'order' && orderData ? `<p class="text-muted text-sm">Loaded order ${h(orderData.order?.name || '')}</p>` : ''}
      ${source === 'order' && !orderData && queryOrder ? '<p class="alert alert-error">Order not found.</p>' : ''}
      ${orderItemsSection}
    </div>`;

  // Products tab: optionsForm always visible; items table conditional
  const productItemsSection = source === 'products' && productItems !== null && allItems.length
    ? `<form method="POST">${optionsForm}${itemsTable}</form>`
    : `<div>${optionsForm}</div>`;

  const fromProductsTab = `
    <div>
      <form method="GET" action="/labels" id="product-search-form" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem">
        <input type="hidden" name="source" value="products">
        <input type="text" name="q" placeholder="Search products..." class="form-input search-input" style="width:240px" value="${h(queryQ)}">
        <button type="submit" class="btn btn-secondary">Search</button>
      </form>
      ${productItemsSection}
    </div>`;

  return layout({ title: 'Labels', session, activePath: '/labels', content: `
    <div class="page-header"><h1>Barcode Labels</h1></div>
    ${flashHtml}
    <div class="tab-bar">
      <button class="tab${source !== 'products' ? ' active' : ''}" data-tab="from-order">From an Order</button>
      <button class="tab${source === 'products' ? ' active' : ''}" data-tab="from-products">From Products</button>
    </div>
    <div class="tab-content${source !== 'products' ? '' : ' hidden'}" id="from-order">${fromOrderTab}</div>
    <div class="tab-content${source === 'products' ? '' : ' hidden'}" id="from-products">${fromProductsTab}</div>
    <script>
    document.querySelectorAll('.tab').forEach(function(t) {
      t.addEventListener('click', function() {
        document.querySelectorAll('.tab').forEach(function(x) { x.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(x) { x.classList.add('hidden'); });
        this.classList.add('active');
        document.getElementById(this.dataset.tab).classList.remove('hidden');
      });
    });
    </script>
  ` });
}

app.get('/labels', requireAuth, async (req, res) => {
  const source = req.query.source || 'order';
  const savedTemplate = getSetting('last_label_template', req.adminSession.email) || 'avery-5160';
  const savedFieldsStr = getSetting('last_label_fields', req.adminSession.email);
  const savedFields = savedFieldsStr ? JSON.parse(savedFieldsStr) : { ...DEFAULT_FIELDS };
  const queryOrder = req.query.order || '';
  const queryQ = req.query.q || '';

  if (source === 'order' && queryOrder) {
    const orderData = await getOrderForLabels(queryOrder);
    return res.send(renderLabelsPage(req.adminSession, { source: 'order', orderData, productItems: null, flash: null, savedTemplate, savedFields, queryOrder, queryQ }));
  }

  if (source === 'products') {
    const q = queryQ.toLowerCase();
    const rawProducts = await getProductsForLabels(null);
    const filtered = q
      ? rawProducts.filter(p => p.title.toLowerCase().includes(q) || (p.handle || '').includes(q))
      : rawProducts;
    const productItems = filtered.flatMap(p =>
      p.variants.edges.map(e => ({
        barcode:      e.node.barcode || '',
        title:        p.title,
        variantTitle: e.node.title !== 'Default Title' ? e.node.title : '',
        sku:          e.node.sku || '',
        price:        e.node.price || '0.00',
        qty:          1,
      }))
    );
    return res.send(renderLabelsPage(req.adminSession, { source: 'products', orderData: null, productItems, flash: null, savedTemplate, savedFields, queryOrder, queryQ }));
  }

  res.send(renderLabelsPage(req.adminSession, { source: 'order', orderData: null, productItems: null, flash: null, savedTemplate, savedFields, queryOrder, queryQ }));
});

// Shared label PDF generator for preview + print
async function handleLabelsPdf(req, res, disposition) {
  const itemCount = parseInt(req.body.item_count) || 0;
  const template  = req.body.template || 'avery-5160';

  // Phase 8: 6-checkbox field selection
  const fields = {
    productName: req.body.field_productName === '1',
    variantName: req.body.field_variantName === '1',
    msrp:        req.body.field_msrp        === '1',
    sku:         req.body.field_sku         === '1',
    upcBarcode:  req.body.field_upcBarcode  === '1',
    upcDigits:   req.body.field_upcDigits   === '1',
  };
  if (!Object.values(fields).some(Boolean)) return res.status(400).json({ error: 'Select at least one field.' });

  const items = [];
  for (let i = 0; i < itemCount; i++) {
    const sel = [req.body.sel || []].flat();
    if (!sel.includes(String(i))) continue;
    items.push({
      barcode:      String(req.body[`item_barcode_${i}`] || ''),
      title:        String(req.body[`item_title_${i}`]   || ''),
      variantTitle: String(req.body[`item_variant_${i}`] || ''),
      sku:          String(req.body[`item_sku_${i}`]     || ''),
      price:        String(req.body[`item_price_${i}`]   || ''),
      qty:          parseInt(req.body[`item_qty_${i}`])  || 1,
    });
  }

  if (!items.length) return res.status(400).json({ error: 'No items selected.' });

  try {
    const { pdf, skipped } = await renderLabelSheet({ template, items, fields });
    const { labels } = expandItems(items);

    setSetting('last_label_template', template, req.adminSession.email);
    setSetting('last_label_fields', JSON.stringify(fields), req.adminSession.email);
    logLabelBatch(req.adminSession.email, template, items.length, labels.length);
    auditLog(req.adminSession.email, 'label:generate', template, null, { items: items.length, labels: labels.length });

    const ts = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="fww-labels-${ts}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('Label PDF error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

app.post('/labels/preview', requireAuth, (req, res) => handleLabelsPdf(req, res, 'inline'));
app.post('/labels/print',   requireAuth, (req, res) => handleLabelsPdf(req, res, 'attachment'));

// ── Phase 6: Exports ──────────────────────────────────────────────────────────

async function getProductsForExport(ids) {
  if (MOCK) {
    if (ids && ids.length) return MOCK_PRODUCTS.filter(p => ids.includes(shopifyNumericId(p.id)));
    return MOCK_PRODUCTS;
  }
  const gids = ids.map(id => `gid://shopify/Product/${id}`);
  const result = await shopifyFetch(`
    query($ids:[ID!]!){nodes(ids:$ids){... on Product{
      id handle title vendor productType tags
      featuredImage{url altText}
      images(first:30){edges{node{url altText}}}
      variants(first:50){edges{node{
        id title sku barcode price compareAtPrice inventoryQuantity inventoryPolicy
        createdAt updatedAt
      }}}
      createdAt updatedAt
    }}}`, { ids: gids });
  return (result.data?.nodes || []).filter(Boolean);
}

async function getAllB2bProductIds() {
  if (MOCK) return MOCK_PRODUCTS.map(p => shopifyNumericId(p.id));
  const ids = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const result = await shopifyFetch(
      `query($q:String!,$first:Int!,$after:String){products(first:$first,query:$q,after:$after){edges{node{id}}pageInfo{hasNextPage endCursor}}}`,
      { q: `publication_id:${B2B_PUB_ID.split('/').pop()}`, first: 250, after });
    const edges = result.data?.products?.edges || [];
    ids.push(...edges.map(e => shopifyNumericId(e.node.id)));
    if (!result.data?.products?.pageInfo?.hasNextPage) break;
    after = result.data.products.pageInfo.endCursor;
  }
  return ids;
}

function renderExportsLanding(session) {
  return layout({ title: 'Exports', session, activePath: '/exports', content: `
    <div class="page-header"><h1>Exports</h1></div>
    <div class="exports-cards">
      <a href="/exports/csv" class="export-card">
        <div class="export-card-icon">CSV</div>
        <h3>Product CSV</h3>
        <p>Export product + variant data (handle, SKU, UPC, price, inventory) as CSV. One row per variant.</p>
      </a>
      <a href="/exports/images" class="export-card">
        <div class="export-card-icon">ZIP</div>
        <h3>Product Images</h3>
        <p>Download main photos or full image galleries as a ZIP file. Original resolution from Shopify CDN.</p>
      </a>
    </div>
  ` });
}

function renderExportsCsv(session, { products, selectedIds, columns, flash }) {
  const ALL_COLS = [
    ['product_handle','Handle'], ['product_title','Title'], ['vendor','Vendor'], ['product_type','Type'],
    ['style','Style'], ['tags','Tags'], ['variant_id','Variant ID'], ['variant_title','Variant Title'],
    ['sku','SKU'], ['barcode','UPC/Barcode'], ['price','Price (MSRP)'], ['b2b_price','B2B Price'],
    ['compare_at_price','Compare At'], ['inventory_qty','Inventory'], ['inventory_policy','Inv. Policy'],
    ['created_at','Created'], ['updated_at','Updated'],
  ];
  const selCols = columns || ALL_COLS.map(([k]) => k);
  const colChecks = ALL_COLS.map(([k, label]) =>
    `<label class="col-check"><input type="checkbox" name="cols" value="${k}"${selCols.includes(k) ? ' checked' : ''}> ${h(label)}</label>`
  ).join('');
  const productRows = products.map(p => {
    const numId = shopifyNumericId(p.id);
    const selected = selectedIds.includes(numId);
    return `<tr>
      <td><input type="checkbox" name="ids" value="${numId}"${selected ? ' checked' : ''} class="item-sel"></td>
      <td>${h(p.title)}</td>
      <td class="text-sm text-muted">${h(p.vendor || '')}</td>
      <td class="text-sm">${p.variants.edges.length} variant${p.variants.edges.length !== 1 ? 's' : ''}</td>
    </tr>`;
  }).join('');
  const selectedCount = selectedIds.length || products.length;
  const estRows = MOCK ? selectedCount * 2 : selectedCount * 3;

  return layout({ title: 'CSV Export', session, activePath: '/exports', content: `
    <div class="page-header">
      <h1>Product CSV Export</h1>
      <a href="/exports" class="btn btn-ghost btn-sm">← Exports</a>
    </div>
    ${flash ? `<div class="alert alert-error" style="margin-bottom:1rem">${h(flash)}</div>` : ''}
    <form method="POST" action="/exports/csv">
      <div class="exports-layout">
        <section class="settings-section">
          <h3>Select Products</h3>
          <div style="margin-bottom:0.5rem;display:flex;gap:0.5rem;align-items:center">
            <a href="/exports/csv?select=all" class="btn btn-ghost btn-sm">Select all B2B (${products.length})</a>
            <a href="/exports/csv?select=none" class="btn btn-ghost btn-sm">Clear</a>
          </div>
          <div class="table-wrap" style="max-height:360px;overflow-y:auto">
            <table class="data-table data-table-sm">
              <thead><tr><th style="width:30px"></th><th>Product</th><th>Vendor</th><th>Variants</th></tr></thead>
              <tbody>${productRows || '<tr><td colspan="4" class="empty-state">No products.</td></tr>'}</tbody>
            </table>
          </div>
        </section>
        <section class="settings-section">
          <h3>Columns</h3>
          <div class="col-checks">${colChecks}</div>
          <div style="margin-top:1.25rem">
            <p class="text-muted text-sm">~${estRows} rows (1 per variant)</p>
            <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">Download CSV</button>
          </div>
        </section>
      </div>
    </form>
  ` });
}

function renderExportsImages(session, { products, selectedIds, mode, flash }) {
  const productRows = products.map(p => {
    const numId = shopifyNumericId(p.id);
    const selected = selectedIds.includes(numId);
    const imgCount = mode === 'gallery' ? (p.images?.edges?.length || 1) : 1;
    return `<tr>
      <td><input type="checkbox" name="ids" value="${numId}"${selected ? ' checked' : ''} class="item-sel"></td>
      <td>${h(p.title)}</td>
      <td class="text-sm text-muted">${h(p.vendor || '')}</td>
      <td class="text-sm" id="img-count-${numId}">${imgCount} image${imgCount !== 1 ? 's' : ''}</td>
    </tr>`;
  }).join('');
  const totalImgs = selectedIds.length
    ? products.filter(p => selectedIds.includes(shopifyNumericId(p.id))).reduce((s, p) => s + (mode === 'gallery' ? (p.images?.edges?.length || 1) : 1), 0)
    : products.reduce((s, p) => s + (mode === 'gallery' ? (p.images?.edges?.length || 1) : 1), 0);

  return layout({ title: 'Image Export', session, activePath: '/exports', content: `
    <div class="page-header">
      <h1>Product Image Export</h1>
      <a href="/exports" class="btn btn-ghost btn-sm">← Exports</a>
    </div>
    ${flash ? `<div class="alert alert-error" style="margin-bottom:1rem">${h(flash)}</div>` : ''}
    <form method="POST" action="/exports/images" id="images-form">
      <div class="exports-layout">
        <section class="settings-section">
          <h3>Select Products</h3>
          <div style="margin-bottom:0.5rem;display:flex;gap:0.5rem;align-items:center">
            <a href="/exports/images?select=all" class="btn btn-ghost btn-sm">Select all B2B (${products.length})</a>
            <a href="/exports/images?select=none" class="btn btn-ghost btn-sm">Clear</a>
          </div>
          <div class="table-wrap" style="max-height:360px;overflow-y:auto">
            <table class="data-table data-table-sm">
              <thead><tr><th style="width:30px"></th><th>Product</th><th>Vendor</th><th>Images</th></tr></thead>
              <tbody>${productRows || '<tr><td colspan="4" class="empty-state">No products.</td></tr>'}</tbody>
            </table>
          </div>
        </section>
        <section class="settings-section">
          <h3>Image Mode</h3>
          <div style="display:flex;flex-direction:column;gap:0.5rem">
            <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer">
              <input type="radio" name="mode" value="main-only"${mode !== 'gallery' ? ' checked' : ''}> Main photo only
            </label>
            <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer">
              <input type="radio" name="mode" value="gallery"${mode === 'gallery' ? ' checked' : ''}> Main + all gallery images
            </label>
          </div>
          <div style="margin-top:1.25rem">
            <p class="text-muted text-sm" id="img-total-est">~${totalImgs} image${totalImgs !== 1 ? 's' : ''} estimated</p>
            <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">Download ZIP</button>
          </div>
        </section>
      </div>
    </form>
  ` });
}

app.get('/exports', requireAuth, (req, res) => {
  res.send(renderExportsLanding(req.adminSession));
});

app.get('/exports/csv', requireAuth, async (req, res) => {
  const allIds = await getAllB2bProductIds();
  const products = await getProductsForExport(allIds);
  const select = req.query.select;
  const selectedIds = select === 'none' ? [] : select === 'all' ? allIds : allIds;
  const savedCols = getSetting('last_export_csv_cols', req.adminSession.email);
  const columns = savedCols ? savedCols.split(',') : null;
  res.send(renderExportsCsv(req.adminSession, { products, selectedIds, columns, flash: null }));
});

app.post('/exports/csv', requireAuth, async (req, res) => {
  const ids = [req.body.ids || []].flat().filter(Boolean);
  const cols = [req.body.cols || []].flat().filter(Boolean);
  if (!ids.length) {
    const allIds = await getAllB2bProductIds();
    const products = await getProductsForExport(allIds);
    return res.send(renderExportsCsv(req.adminSession, { products, selectedIds: [], columns: cols, flash: 'Select at least one product.' }));
  }
  if (!cols.length) {
    const products = await getProductsForExport(ids);
    return res.send(renderExportsCsv(req.adminSession, { products, selectedIds: ids, columns: null, flash: 'Select at least one column.' }));
  }

  // Save prefs
  setSetting('last_export_csv_cols', cols.join(','), req.adminSession.email);

  const products = await getProductsForExport(ids);
  const ts = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fww-products-${ts}.csv"`);
  res.write(csvLine(cols));

  let totalRows = 0;
  for (const p of products) {
    const style = (p.tags || []).find(t => t.startsWith('Style_'))?.slice(6) || '';
    const tagStr = (p.tags || []).join('|');
    for (const ve of p.variants.edges) {
      const v = ve.node;
      const b2bPrice = (parseFloat(v.price || 0) * 0.5).toFixed(2);
      const rowData = {
        product_handle: p.handle || '',
        product_title: p.title || '',
        vendor: p.vendor || '',
        product_type: p.productType || '',
        style,
        tags: tagStr,
        variant_id: shopifyNumericId(v.id || ''),
        variant_title: v.title || '',
        sku: v.sku || '',
        barcode: v.barcode || '',
        price: v.price || '',
        b2b_price: b2bPrice,
        compare_at_price: v.compareAtPrice || '',
        inventory_qty: v.inventoryQuantity ?? '',
        inventory_policy: v.inventoryPolicy || '',
        created_at: (v.createdAt || p.createdAt || '').slice(0, 10),
        updated_at: (v.updatedAt || p.updatedAt || '').slice(0, 10),
      };
      res.write(csvLine(cols.map(c => rowData[c] ?? '')));
      totalRows++;
    }
  }
  res.end();
  logExportBatch(req.adminSession.email, 'csv', products.length, totalRows, 0);
  auditLog(req.adminSession.email, 'export:csv', null, null, { products: products.length, rows: totalRows, cols: cols.length });
});

app.get('/exports/images', requireAuth, async (req, res) => {
  const allIds = await getAllB2bProductIds();
  const products = await getProductsForExport(allIds);
  const select = req.query.select;
  const selectedIds = select === 'none' ? [] : allIds;
  const savedMode = getSetting('last_export_img_mode', req.adminSession.email) || 'main-only';
  res.send(renderExportsImages(req.adminSession, { products, selectedIds, mode: savedMode, flash: null }));
});

app.post('/exports/images', requireAuth, async (req, res) => {
  const ids = [req.body.ids || []].flat().filter(Boolean);
  const mode = req.body.mode === 'gallery' ? 'gallery' : 'main-only';
  if (!ids.length) {
    const allIds = await getAllB2bProductIds();
    const products = await getProductsForExport(allIds);
    return res.send(renderExportsImages(req.adminSession, { products, selectedIds: [], mode, flash: 'Select at least one product.' }));
  }

  setSetting('last_export_img_mode', mode, req.adminSession.email);
  const products = await getProductsForExport(ids);
  const ts = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="fww-images-${ts}.zip"`);

  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.pipe(res);
  zip.on('error', err => { console.error('zip error:', err.message); });

  let totalImages = 0;
  for (const p of products) {
    let images = [];
    if (mode === 'gallery') {
      images = (p.images?.edges || []).map(e => e.node);
      if (!images.length && p.featuredImage) images = [p.featuredImage];
    } else {
      if (p.featuredImage) images = [p.featuredImage];
      else if (p.images?.edges?.length) images = [p.images.edges[0].node];
    }
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const url = img.url || '';
      const ext = path.extname(new URL(url, 'https://cdn.shopify.com').pathname) || '.jpg';
      const name = mode === 'gallery'
        ? `${p.handle}_${String(i + 1).padStart(2, '0')}${ext}`
        : `${p.handle}${ext}`;
      try {
        if (MOCK) {
          zip.append(Buffer.from(`mock image: ${url}`), { name });
        } else {
          const r = await fetch(url);
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            zip.append(buf, { name });
          }
        }
        totalImages++;
      } catch (err) {
        console.error(`image fetch error ${url}:`, err.message);
      }
    }
  }
  zip.finalize();
  logExportBatch(req.adminSession.email, 'images', products.length, totalImages, 0);
  auditLog(req.adminSession.email, 'export:images', mode, null, { products: products.length, images: totalImages });
});

// ── Phase 17: Wholesale Leads CRM ─────────────────────────────────────────────

const LEAD_STATUSES = {
  new:                 { label: 'New',                 color: 'blue',    terminal: false },
  under_review:        { label: 'Under Review',         color: 'warning', terminal: false },
  waiting_on_docs:     { label: 'Waiting on Docs',      color: 'orange',  terminal: false },
  waiting_on_sales_tax:{ label: 'Waiting on Tax Cert',  color: 'orange',  terminal: false },
  waiting_on_w9:       { label: 'Waiting on W9',        color: 'orange',  terminal: false },
  approved:            { label: 'Approved',             color: 'success', terminal: false },
  converted:           { label: 'Converted',            color: 'lime',    terminal: true  },
  rejected:            { label: 'Rejected',             color: 'danger',  terminal: true  },
  dormant:             { label: 'Dormant',              color: 'muted',   terminal: false },
};

const LEAD_TRANSITIONS = {
  new:                  ['under_review', 'rejected'],
  under_review:         ['waiting_on_docs','waiting_on_sales_tax','waiting_on_w9','approved','rejected','dormant'],
  waiting_on_docs:      ['under_review','dormant','rejected'],
  waiting_on_sales_tax: ['under_review','dormant','rejected'],
  waiting_on_w9:        ['under_review','dormant','rejected'],
  approved:             ['converted','rejected'],
  converted:            [],
  rejected:             [],
  dormant:              ['under_review','rejected'],
};

function renderLeadsList(session, { leads, counts, flash, q, status }) {
  const allCount = Object.values(counts).reduce((s, n) => s + n, 0);
  const chipList = [
    { value: 'all', label: `All (${allCount})` },
    ...Object.entries(LEAD_STATUSES).map(([k, v]) => ({ value: k, label: `${v.label} (${counts[k] || 0})` })),
  ];
  const chipBar = chipList.map(c =>
    `<a href="/leads?status=${h(c.value)}${q ? '&q=' + encodeURIComponent(q) : ''}" class="filter-chip${(status || 'all') === c.value ? ' filter-chip-active' : ''}">${h(c.label)}</a>`
  ).join('');

  const rows = leads.map(l => {
    const st = LEAD_STATUSES[l.status] || { label: l.status, color: 'muted' };
    const followUp = l.next_followup_due
      ? `<span class="${l.next_followup_due < new Date().toISOString().split('T')[0] ? 'text-danger' : 'text-muted'}">${h(l.next_followup_due)}</span>`
      : '<span class="text-muted">—</span>';
    return `<tr>
      <td><a href="/leads/${l.id}" class="link-strong">${h(l.business_name || '—')}</a><br><small class="text-muted">${h(l.email)}</small></td>
      <td>${h(l.contact_name || '—')}</td>
      <td><span class="badge badge-${st.color}">${h(st.label)}</span></td>
      <td class="text-muted small-text">${fmtDate(new Date(l.updated_at).toISOString())}</td>
      <td>${followUp}</td>
      <td><a href="/leads/${l.id}" class="table-action">View →</a></td>
    </tr>`;
  }).join('');

  const flashHtml = flash ? `<div class="alert alert-success">${h(flash)}</div>` : '';

  return layout({ title: 'Wholesale Leads', session, activePath: '/leads', content: `
    <div class="page-header-row">
      <h1>Wholesale Leads</h1>
      <a href="/leads/new" class="btn btn-primary">+ New Lead</a>
    </div>
    ${flashHtml}
    <div class="filter-bar" style="margin-bottom:0.75rem">
      <form method="GET" action="/leads" style="display:flex;gap:0.5rem;align-items:center;flex:1">
        <input type="hidden" name="status" value="${h(status || 'all')}">
        <input type="text" name="q" value="${h(q || '')}" class="input search-input" placeholder="Search name, email, business…" style="max-width:320px">
        <button type="submit" class="btn btn-secondary btn-sm">Search</button>
        ${q ? `<a href="/leads?status=${h(status || 'all')}" class="btn btn-ghost btn-sm">Clear</a>` : ''}
      </form>
    </div>
    <div class="filter-chips-row" style="margin-bottom:1rem;display:flex;flex-wrap:wrap;gap:0.35rem">${chipBar}</div>
    ${leads.length === 0
      ? `<div class="empty-state card" style="padding:2rem;text-align:center"><p class="text-muted">No leads found.</p><a href="/leads/new" class="btn btn-primary" style="margin-top:0.75rem">Create first lead</a></div>`
      : `<div class="table-wrap"><table class="data-table">
          <thead><tr><th>Business</th><th>Contact</th><th>Status</th><th>Last Activity</th><th>Follow-up</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
    }
  ` });
}

function renderLeadNew(session, { flash, prefill = {} }) {
  const flashHtml = flash ? `<div class="alert alert-danger">${h(flash)}</div>` : '';
  return layout({ title: 'New Lead', session, activePath: '/leads', content: `
    <div class="breadcrumb-row"><a href="/leads" class="breadcrumb">← Leads</a></div>
    <div class="page-header-row"><h1>New Lead</h1></div>
    ${flashHtml}
    <div class="card" style="max-width:640px">
      <form method="POST" action="/leads/new">
        <div class="settings-grid">
          <label>Email *</label>
          <input type="email" name="email" value="${h(prefill.email||'')}" required class="input" placeholder="buyer@boutique.com">
          <label>Business name</label>
          <input type="text" name="business_name" value="${h(prefill.business_name||'')}" class="input" placeholder="Paws & Co.">
          <label>Contact name</label>
          <input type="text" name="contact_name" value="${h(prefill.contact_name||'')}" class="input">
          <label>Phone</label>
          <input type="tel" name="phone" value="${h(prefill.phone||'')}" class="input">
          <label>Website</label>
          <input type="url" name="website" value="${h(prefill.website||'')}" class="input" placeholder="https://…">
          <label>Business type</label>
          <select name="business_type" class="input">
            <option value="">— select —</option>
            ${['boutique','trainer','kennel','show-vendor','groomer','other'].map(t =>
              `<option value="${t}"${prefill.business_type===t?' selected':''}>${h(t)}</option>`
            ).join('')}
          </select>
          <label>Est. monthly volume ($)</label>
          <input type="number" name="estimated_monthly_volume_usd" value="${h(String(prefill.estimated_monthly_volume_usd||''))}" class="input" min="0" step="100">
          <label>Source</label>
          <select name="source" class="input">
            <option value="">— select —</option>
            ${['tradeshow','website-form','instagram','referral','cold-outreach','other'].map(s =>
              `<option value="${s}"${prefill.source===s?' selected':''}>${h(s)}</option>`
            ).join('')}
          </select>
          <label>Source detail</label>
          <input type="text" name="source_detail" value="${h(prefill.source_detail||'')}" class="input" placeholder="IKC 2026, @petboutique referred…">
          <label>Follow-up date</label>
          <input type="date" name="next_followup_due" value="${h(prefill.next_followup_due||'')}" class="input">
        </div>
        <div style="margin-top:1.25rem;display:flex;gap:0.75rem">
          <button type="submit" class="btn btn-primary">Create Lead</button>
          <a href="/leads" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </div>
  ` });
}

function renderLeadDetail(session, { lead, notes, history, flash }) {
  const st = LEAD_STATUSES[lead.status] || { label: lead.status, color: 'muted' };
  const transitions = LEAD_TRANSITIONS[lead.status] || [];
  const flashHtml = flash ? `<div class="alert alert-success">${h(flash)}</div>` : '';

  // Merge notes + history into a single timeline, sorted by created_at
  const timeline = [
    ...notes.map(n => ({ ts: n.created_at, type: 'note', data: n })),
    ...history.map(h2 => ({ ts: h2.changed_at, type: 'status', data: h2 })),
  ].sort((a, b) => a.ts - b.ts);

  const timelineHtml = timeline.length === 0
    ? '<p class="text-muted small-text">No activity yet.</p>'
    : timeline.map(item => {
        if (item.type === 'note') {
          const n = item.data;
          const noteColor = { call:'blue', email:'green', meeting:'lime', system:'muted', general:'' }[n.note_type] || '';
          return `<div class="timeline-item">
            <div class="timeline-meta"><span class="badge badge-${noteColor} badge-xs">${h(n.note_type)}</span> <span class="text-muted small-text">${h(n.author_email)} · ${fmtDate(new Date(n.created_at).toISOString())}</span></div>
            <div class="timeline-body">${h(n.body)}</div>
          </div>`;
        } else {
          const s = item.data;
          const newSt = LEAD_STATUSES[s.to_status] || { label: s.to_status, color: 'muted' };
          return `<div class="timeline-item timeline-status">
            <div class="timeline-meta"><span class="text-muted small-text">Status changed by ${h(s.changed_by || '—')} · ${fmtDate(new Date(s.changed_at).toISOString())}</span></div>
            <div class="timeline-body">${s.from_status ? `<span class="badge badge-muted badge-xs">${h(LEAD_STATUSES[s.from_status]?.label || s.from_status)}</span> → ` : ''}<span class="badge badge-${newSt.color} badge-xs">${h(newSt.label)}</span>${s.note ? ` — ${h(s.note)}` : ''}</div>
          </div>`;
        }
      }).join('');

  const transitionOpts = transitions.map(t => {
    const ts2 = LEAD_STATUSES[t] || { label: t };
    return `<option value="${h(t)}">${h(ts2.label)}</option>`;
  }).join('');

  const convertBtn = lead.status === 'approved'
    ? `<a href="/leads/${lead.id}/convert" class="btn btn-primary">Convert to Customer</a>`
    : '';

  return layout({ title: (lead.business_name || lead.email) + ' — Lead', session, activePath: '/leads',
    extraHead: `<style>
      .timeline-item{padding:0.6rem 0;border-bottom:1px solid #f0f0f0;}
      .timeline-item:last-child{border-bottom:none;}
      .timeline-meta{margin-bottom:0.2rem;}
      .timeline-status .timeline-body{font-size:0.85rem;}
      .badge-xs{font-size:0.7rem;padding:0.15rem 0.4rem;}
      .badge-lime{background:#9BBC0E;color:#fff;}
      .badge-orange{background:#F97316;color:#fff;}
    </style>`,
    content: `
    <div class="breadcrumb-row"><a href="/leads" class="breadcrumb">← Leads</a></div>
    ${flashHtml}
    <div class="detail-header">
      <div class="detail-header-left">
        <h1>${h(lead.business_name || lead.email)}</h1>
        <p class="text-muted">${h(lead.contact_name || '')}${lead.contact_name && lead.email ? ' · ' : ''}${h(lead.email)} <span class="badge badge-${st.color}" style="margin-left:0.5rem">${h(st.label)}</span></p>
      </div>
      <div class="detail-header-actions">
        ${convertBtn}
      </div>
    </div>
    <div class="detail-grid">
      <div class="detail-main">
        <!-- Status change -->
        ${transitions.length > 0 ? `<div class="card">
          <div class="card-header"><h2>Change Status</h2></div>
          <form method="POST" action="/leads/${lead.id}/status" style="display:flex;gap:0.5rem;align-items:flex-end;flex-wrap:wrap">
            <div>
              <label class="field-label">New status</label>
              <select name="new_status" class="input input-sm">${transitionOpts}</select>
            </div>
            <div style="flex:1;min-width:160px">
              <label class="field-label">Note (optional)</label>
              <input type="text" name="note" class="input input-sm" placeholder="Reason or context…">
            </div>
            <button type="submit" class="btn btn-secondary btn-sm">Update</button>
          </form>
        </div>` : ''}

        <!-- Timeline -->
        <div class="card">
          <div class="card-header"><h2>Activity</h2></div>
          <div id="timeline">${timelineHtml}</div>
        </div>

        <!-- Add note -->
        <div class="card">
          <div class="card-header"><h2>Add Note</h2></div>
          <form method="POST" action="/leads/${lead.id}/note">
            <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;align-items:center">
              <label class="field-label" style="margin:0">Type:</label>
              <select name="note_type" class="input input-sm" style="width:auto">
                ${['general','call','email','meeting'].map(t => `<option value="${t}">${h(t)}</option>`).join('')}
              </select>
            </div>
            <textarea name="body" class="textarea" rows="3" placeholder="Note about this lead…" required></textarea>
            <div style="margin-top:0.5rem"><button type="submit" class="btn btn-secondary btn-sm">Add Note</button></div>
          </form>
        </div>
      </div>
      <div class="detail-side">
        <div class="card">
          <div class="card-header"><h2>Profile</h2></div>
          <form method="POST" action="/leads/${lead.id}/profile">
            <div class="kv-list">
              <div class="kv-row"><span>Email</span><strong><a href="mailto:${h(lead.email)}" class="link">${h(lead.email)}</a></strong></div>
              ${lead.phone ? `<div class="kv-row"><span>Phone</span><strong>${h(lead.phone)}</strong></div>` : ''}
              ${lead.website ? `<div class="kv-row"><span>Website</span><strong><a href="${h(lead.website)}" target="_blank" class="link">${h(lead.website)}</a></strong></div>` : ''}
              ${lead.business_type ? `<div class="kv-row"><span>Type</span><strong>${h(lead.business_type)}</strong></div>` : ''}
              ${lead.source ? `<div class="kv-row"><span>Source</span><strong>${h(lead.source)}${lead.source_detail ? ' — ' + h(lead.source_detail) : ''}</strong></div>` : ''}
              ${lead.estimated_monthly_volume_usd ? `<div class="kv-row"><span>Est. volume</span><strong>${fmtMoney(lead.estimated_monthly_volume_usd)}/mo</strong></div>` : ''}
              <div class="kv-row"><span>Created</span><strong class="text-muted">${fmtDate(new Date(lead.created_at).toISOString())}</strong></div>
            </div>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><h2>Follow-up</h2></div>
          <form method="POST" action="/leads/${lead.id}/followup" style="display:flex;gap:0.5rem;align-items:center">
            <input type="date" name="next_followup_due" value="${h(lead.next_followup_due||'')}" class="input input-sm" style="flex:1">
            <button type="submit" class="btn btn-secondary btn-sm">Save</button>
          </form>
          ${lead.next_followup_due && lead.next_followup_due < new Date().toISOString().split('T')[0]
            ? `<p class="text-danger small-text" style="margin-top:0.35rem">⚠ Overdue</p>` : ''}
        </div>
        ${lead.shopify_customer_id ? `<div class="card"><div class="card-header"><h2>Customer</h2></div>
          <p><a href="/customers/${lead.shopify_customer_id.split('/').pop()}" class="link">View customer →</a></p>
        </div>` : ''}
      </div>
    </div>
  ` });
}

function renderLeadConvert(session, { lead, flash, settings }) {
  const discountDefault = settings.b2b_discount_pct || '50';
  const flashHtml = flash ? `<div class="alert alert-danger">${h(flash)}</div>` : '';
  return layout({ title: 'Convert Lead to Customer', session, activePath: '/leads', content: `
    <div class="breadcrumb-row"><a href="/leads/${lead.id}" class="breadcrumb">← ${h(lead.business_name || lead.email)}</a></div>
    <div class="page-header-row"><h1>Convert to B2B Customer</h1></div>
    ${flashHtml}
    <div class="card" style="max-width:640px">
      <p class="text-muted" style="margin-bottom:1rem">This will create a Shopify customer with the <strong>b2b</strong> tag and configure their B2B settings. The lead will be marked as converted.</p>
      <form method="POST" action="/leads/${lead.id}/convert">
        <div class="settings-grid">
          <label>Display name *</label>
          <input type="text" name="display_name" value="${h(lead.contact_name || lead.business_name || '')}" required class="input">
          <label>Email *</label>
          <input type="email" name="email" value="${h(lead.email)}" required class="input">
          <label>Phone</label>
          <input type="tel" name="phone" value="${h(lead.phone||'')}" class="input">
          <label>B2B discount %</label>
          <input type="number" name="discount_pct" value="${h(discountDefault)}" min="0" max="95" class="input" style="width:100px">
          <label>Allow order on invoice</label>
          <label class="toggle-label"><input type="checkbox" name="allow_order_on_invoice" class="toggle" checked></label>
          <label>Drop-ship allowed</label>
          <label class="toggle-label"><input type="checkbox" name="dropship_enabled" class="toggle"></label>
        </div>
        <div style="margin-top:1.25rem;display:flex;gap:0.75rem">
          <button type="submit" class="btn btn-primary">Convert to Customer</button>
          <a href="/leads/${lead.id}" class="btn btn-ghost">Cancel</a>
        </div>
      </form>
    </div>
  ` });
}

// Leads routes
app.get('/leads', requireAuth, (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null;
  const q      = String(req.query.q || '').trim();
  const leads  = getLeads({ status, search: q || undefined });
  const counts = getLeadCounts();
  const flash  = req.query.flash === 'created' ? 'Lead created.' : req.query.flash === 'saved' ? 'Lead updated.' : null;
  res.send(renderLeadsList(req.adminSession, { leads, counts, flash, q, status: req.query.status || 'all' }));
});

app.get('/leads/new', requireAuth, (req, res) => {
  res.send(renderLeadNew(req.adminSession, { flash: null }));
});

app.post('/leads/new', requireAuth, (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!email) return res.send(renderLeadNew(req.adminSession, { flash: 'Email is required.', prefill: req.body }));
  try {
    const id = createLead(req.body);
    addLeadStatusHistory(id, null, 'new', 'Lead created', req.adminSession.email);
    auditLog(req.adminSession.email, 'lead:create', String(id), null, { email });
    res.redirect('/leads/' + id + '?flash=created');
  } catch (err) {
    const msg = err.message.includes('UNIQUE') ? 'A lead with that email already exists.' : err.message;
    res.send(renderLeadNew(req.adminSession, { flash: msg, prefill: req.body }));
  }
});

app.get('/leads/:id', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).send(layout({ title: '404', session: req.adminSession, activePath: '/leads',
    content: '<h1>Lead not found</h1><a href="/leads" class="btn btn-secondary">← Leads</a>' }));
  const notes   = getLeadNotes(lead.id);
  const history = getLeadStatusHistory(lead.id);
  const flash   = req.query.flash === 'created' ? 'Lead created.' : req.query.flash === 'saved' ? 'Saved.' : req.query.flash === 'status_changed' ? 'Status updated.' : null;
  res.send(renderLeadDetail(req.adminSession, { lead, notes, history, flash }));
});

app.post('/leads/:id/status', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  const newStatus = req.body.new_status;
  const allowed = LEAD_TRANSITIONS[lead.status] || [];
  if (!allowed.includes(newStatus)) return res.redirect('/leads/' + lead.id + '?flash=invalid_status');
  const note = String(req.body.note || '').trim();
  addLeadStatusHistory(lead.id, lead.status, newStatus, note || null, req.adminSession.email);
  addLeadNote(lead.id, req.adminSession.email, `Status changed to ${LEAD_STATUSES[newStatus]?.label || newStatus}${note ? ': ' + note : ''}`, 'system');
  updateLead(lead.id, { status: newStatus });
  auditLog(req.adminSession.email, 'lead:status', String(lead.id), lead.status, newStatus);
  res.redirect('/leads/' + lead.id + '?flash=status_changed');
});

app.post('/leads/:id/note', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  const body = String(req.body.body || '').trim();
  if (!body) return res.redirect('/leads/' + lead.id);
  const noteType = ['general','call','email','meeting'].includes(req.body.note_type) ? req.body.note_type : 'general';
  addLeadNote(lead.id, req.adminSession.email, body, noteType);
  updateLead(lead.id, { status: lead.status });
  res.redirect('/leads/' + lead.id + '?flash=saved');
});

app.post('/leads/:id/followup', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  const date = String(req.body.next_followup_due || '').trim();
  updateLead(lead.id, { next_followup_due: date || null });
  res.redirect('/leads/' + lead.id + '?flash=saved');
});

app.get('/leads/:id/convert', requireAuth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  if (lead.status !== 'approved') return res.redirect('/leads/' + lead.id);
  res.send(renderLeadConvert(req.adminSession, { lead, flash: null, settings: getGlobalSettings() }));
});

app.post('/leads/:id/convert', requireAuth, async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.redirect('/leads');
  if (lead.status !== 'approved') return res.redirect('/leads/' + lead.id);

  const email   = String(req.body.email || lead.email).trim();
  const name    = String(req.body.display_name || '').trim();
  const phone   = String(req.body.phone || '').trim();
  const discPct = parseInt(req.body.discount_pct || '50', 10);
  const allowInv = req.body.allow_order_on_invoice === 'on';
  const dropship = req.body.dropship_enabled === 'on';

  let shopifyCustomerId = null;

  if (!MOCK) {
    try {
      // Create Shopify customer with b2b tag
      const createResult = await shopifyFetch(`
        mutation customerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id }
            userErrors { field message }
          }
        }`, {
        input: {
          email, firstName: name.split(' ')[0] || name, lastName: name.split(' ').slice(1).join(' ') || '',
          phone: phone || undefined,
          tags: ['b2b'],
          emailMarketingConsent: { marketingState: 'NOT_SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN' },
        }
      });
      const errors = createResult.data?.customerCreate?.userErrors || [];
      if (errors.length > 0) {
        return res.send(renderLeadConvert(req.adminSession, { lead, flash: errors[0].message, settings: getGlobalSettings() }));
      }
      shopifyCustomerId = createResult.data?.customerCreate?.customer?.id;

      // Set B2B metafields
      if (shopifyCustomerId) {
        const metafields = [
          { ownerId: shopifyCustomerId, namespace: 'b2b', key: 'discount_pct',           value: String(discPct), type: 'number_integer' },
          { ownerId: shopifyCustomerId, namespace: 'b2b', key: 'allow_order_on_invoice',  value: String(allowInv), type: 'boolean' },
          { ownerId: shopifyCustomerId, namespace: 'b2b', key: 'dropship_enabled',        value: String(dropship), type: 'boolean' },
        ];
        await shopifyFetch(`mutation metafieldsSet($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{field message} } }`, { m: metafields });
      }
    } catch (err) {
      return res.send(renderLeadConvert(req.adminSession, { lead, flash: 'Shopify error: ' + err.message, settings: getGlobalSettings() }));
    }
  } else {
    shopifyCustomerId = 'gid://shopify/Customer/MOCK_' + lead.id;
  }

  // Phase 21C: sync new B2B customer to Xero (non-blocking)
  const numIdForXero = shopifyCustomerId ? shopifyCustomerId.split('/').pop() : null;
  if (numIdForXero) {
    syncCustomerToXero(numIdForXero, {
      email: email, firstName: name.split(' ')[0] || name,
      lastName: name.split(' ').slice(1).join(' ') || '',
      displayName: name,
    }, xeroRequest, { dryRun: MOCK }).then(r => {
      if (r.created) auditLog(req.adminSession.email, 'xero:customer_sync', shopifyCustomerId, null, { xeroContactId: r.xeroContactId, via: 'lead_convert' });
    }).catch(e => console.error('[xero-sync] lead convert sync failed:', e.message));
  }

  updateLead(lead.id, { status: 'converted', converted_at: Date.now(), shopify_customer_id: shopifyCustomerId });
  addLeadStatusHistory(lead.id, 'approved', 'converted', 'Customer created', req.adminSession.email);
  addLeadNote(lead.id, req.adminSession.email, 'Converted to Shopify customer ' + shopifyCustomerId, 'system');
  auditLog(req.adminSession.email, 'lead:convert', String(lead.id), { status: 'approved' }, { status: 'converted', shopifyCustomerId });

  const numId = shopifyCustomerId ? shopifyCustomerId.split('/').pop() : null;
  if (numId) return res.redirect('/customers/' + numId);
  res.redirect('/leads/' + lead.id);
});

// ── Xero accounting routes ────────────────────────────────────────────────────

function renderXeroSettings(session, flash) {
  const accountMap = getXeroAccountMap();
  const flashHtml  = flash ? `<div class="alert ${flash.ok ? 'alert-success' : 'alert-error'}" style="margin-bottom:1rem">${h(flash.msg)}</div>` : '';
  const field = (key, label, help = '') => `
    <div class="settings-field">
      <label class="settings-label">${h(label)}</label>
      <input type="text" name="${key}" value="${h(accountMap[key])}" class="filter-input" style="width:160px">
      ${help ? `<span class="text-muted" style="font-size:12px;margin-left:8px">${h(help)}</span>` : ''}
    </div>`;
  const pendingCount = getXeroPendingCount();
  return layout({ title: 'Xero Settings', session, activePath: '/settings', content: `
    <div class="page-header">
      <h1>Xero Integration Settings</h1>
      <a href="/settings" class="btn btn-ghost btn-sm">← Back to Settings</a>
    </div>
    ${flashHtml}
    ${pendingCount > 0 ? `<div class="alert alert-warning" style="margin-bottom:1rem">⚠ ${pendingCount} Xero action(s) pending retry. <a href="/accounting" class="link">View in Accounting →</a></div>` : ''}
    <div class="card" style="max-width:640px">
      <div class="card-header"><h2>Account Code Mapping</h2></div>
      <p class="text-muted" style="margin-bottom:1rem;font-size:13px">Map FWW concepts to your Xero account codes. These are the numeric codes from your chart of accounts (e.g., "200" for Sales).</p>
      <form method="POST" action="/settings/xero">
        <div class="settings-grid" style="gap:12px">
          ${field('sales_revenue',       'Sales Revenue',           'Default: 200')}
          ${field('accounts_receivable', 'Accounts Receivable (A/R)', 'Default: 610')}
          ${field('chase_checking',      'Chase Business Checking', 'Default: 1110')}
          ${field('stripe_clearing',     'Stripe Clearing',         'Default: 1120')}
          ${field('processing_fees',     'Payment Processing Fees', 'Default: 6100')}
          ${field('discounts',           'Discounts Given',         'Default: 400')}
          ${field('payment_terms_days',  'Default Payment Terms (days)', 'Default: 30 (NET 30)')}
        </div>
        <div style="margin-top:1.5rem;display:flex;gap:8px">
          <button type="submit" class="btn btn-primary">Save account mapping</button>
          <a href="/accounting" class="btn btn-ghost">View reconciliation →</a>
        </div>
      </form>
    </div>
    <div class="card" style="max-width:640px;margin-top:1rem">
      <div class="card-header"><h2>Connection</h2></div>
      <p class="text-muted" style="font-size:13px">Bridge: <code>fww-xero-bridge.alex-037.workers.dev</code></p>
      <p class="text-muted" style="font-size:13px">Bearer: ${XERO_BEARER ? '<span class="badge badge-paid">Configured</span>' : '<span class="badge badge-pending">Not configured (XERO_BRIDGE_BEARER)</span>'}</p>
      <div style="margin-top:12px;display:flex;gap:8px">
        <form method="POST" action="/api/admin/xero/test" id="xero-test-form">
          <button type="submit" class="btn btn-secondary btn-sm" onclick="testXeroConnection(event)">Test connection</button>
        </form>
        <span id="xero-test-result" style="font-size:13px;line-height:32px"></span>
      </div>
    </div>
    <script>
    async function testXeroConnection(e) {
      e.preventDefault();
      const el = document.getElementById('xero-test-result');
      el.textContent = 'Testing…';
      try {
        const r = await fetch('/api/admin/xero/test', { method: 'POST' });
        const j = await r.json();
        el.textContent = j.ok ? '✓ Connected — ' + j.accounts + ' accounts found' : '✗ ' + (j.error || 'Failed');
        el.style.color = j.ok ? 'var(--lime)' : 'var(--danger)';
      } catch (err) { el.textContent = '✗ ' + err.message; el.style.color = 'var(--danger)'; }
    }
    </script>
  ` });
}

function renderAccounting(session, data) {
  const { invoiceMaps, pendingActions, pendingCount } = data;
  const pendingCountBadge = pendingCount > 0 ? `<span class="badge badge-pending">${pendingCount}</span>` : '<span class="badge badge-paid">0</span>';

  const invoiceRows = invoiceMaps.map(r => `<tr>
    <td><span class="mono">${h(r.order_id)}</span></td>
    <td>${r.xero_invoice_id ? `<span class="mono">${h(r.xero_invoice_id)}</span>` : '<span class="text-muted">—</span>'}</td>
    <td><span class="badge badge-${r.status === 'synced' ? 'paid' : r.status === 'pending_retry' ? 'warning' : 'pending'}">${h(r.status)}</span></td>
    <td class="text-muted">${r.synced_at ? fmtDate(new Date(r.synced_at).toISOString()) : '—'}</td>
    <td class="text-sm" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${r.error_text ? h(r.error_text.slice(0,80)) : '—'}</td>
    <td><a href="/orders/${h(r.order_id)}" class="link">View order</a></td>
  </tr>`).join('') || '<tr><td colspan="6" class="text-muted text-center">No orders synced to Xero yet.</td></tr>';

  const pendingRows = pendingActions.map(r => {
    const payload = JSON.parse(r.payload_json || '{}');
    return `<tr>
      <td>${h(r.action_type)}</td>
      <td>${r.retries}</td>
      <td><span class="badge badge-${r.status === 'done' ? 'paid' : r.status === 'failed' ? 'danger' : 'pending'}">${h(r.status)}</span></td>
      <td class="text-muted">${fmtDate(new Date(r.created_at).toISOString())}</td>
      <td class="text-sm" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${r.error_text ? h(r.error_text.slice(0,60)) : '—'}</td>
      <td>${payload.orderId ? `<a href="/orders/${h(payload.orderId)}" class="link">#${h(payload.orderId)}</a>` : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="text-muted text-center">No pending actions.</td></tr>';

  return layout({ title: 'Accounting', session, activePath: '/accounting', content: `
    <div class="page-header">
      <h1>Accounting Reconciliation</h1>
      <div style="display:flex;gap:8px">
        <form method="POST" action="/api/admin/xero/sync">
          <button class="btn btn-primary btn-sm" onclick="this.textContent='Syncing…'">Retry pending actions</button>
        </form>
        <a href="/settings/xero" class="btn btn-ghost btn-sm">Xero settings →</a>
      </div>
    </div>
    <div class="report-stats" style="margin-bottom:1.5rem">
      <div class="stat-card">
        <div class="stat-value">${invoiceMaps.filter(r => r.status === 'synced').length}</div>
        <div class="stat-label">Synced to Xero</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${pendingCountBadge}</div>
        <div class="stat-label">Pending retry</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${invoiceMaps.length}</div>
        <div class="stat-label">Total tracked</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:1rem">
      <div class="card-header"><h2>Xero Invoice Map</h2></div>
      <div class="table-wrap">
        <table class="data-table data-table-sm">
          <thead><tr><th>Order ID</th><th>Xero Invoice ID</th><th>Status</th><th>Last Synced</th><th>Error</th><th></th></tr></thead>
          <tbody>${invoiceRows}</tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
        <h2>Pending Actions</h2>
        ${pendingCount > 0 ? `<form method="POST" action="/api/admin/xero/sync" style="display:inline"><button class="btn btn-primary btn-xs">Retry all</button></form>` : ''}
      </div>
      <div class="table-wrap">
        <table class="data-table data-table-sm">
          <thead><tr><th>Action</th><th>Retries</th><th>Status</th><th>Created</th><th>Error</th><th>Order</th></tr></thead>
          <tbody>${pendingRows}</tbody>
        </table>
      </div>
    </div>
  ` });
}

app.get('/settings/xero', requireAuth, (req, res) => {
  const flash = req.query.flash ? { ok: req.query.flash === 'ok', msg: req.query.msg || '' } : null;
  res.send(renderXeroSettings(req.adminSession, flash));
});

app.post('/settings/xero', requireAuth, (req, res) => {
  const fields = ['sales_revenue','accounts_receivable','chase_checking','stripe_clearing','processing_fees','discounts','payment_terms_days'];
  try {
    for (const f of fields) {
      if (req.body[f] !== undefined) setSetting('xero_' + f, String(req.body[f]).trim().slice(0, 20));
    }
    auditLog(req.adminSession.email, 'settings:xero', null, null, Object.fromEntries(fields.map(f => ['xero_'+f, req.body[f]])));
    res.redirect('/settings/xero?flash=ok&msg=Xero+settings+saved.');
  } catch (err) {
    res.redirect(`/settings/xero?flash=err&msg=${encodeURIComponent(err.message)}`);
  }
});

app.get('/accounting', requireAuth, (req, res) => {
  const invoiceMaps = getXeroInvoiceMaps();
  const pendingActions = getXeroPending('pending').concat(getXeroPending('failed'));
  const pendingCount = getXeroPendingCount();
  res.send(renderAccounting(req.adminSession, { invoiceMaps, pendingActions, pendingCount }));
});

app.post('/api/admin/xero/test', requireAuth, async (req, res) => {
  try {
    const result = await xeroRequest('GET', '/api.xro/2.0/Accounts');
    const accounts = result.body?.Accounts?.length || 0;
    res.json({ ok: true, accounts, message: `Connected — ${accounts} accounts found` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/xero/sync', requireAuth, async (req, res) => {
  try {
    const results = await retryXeroPending();
    auditLog(req.adminSession.email, 'xero:sync', null, null, results);
    if (req.accepts('json') && !req.body._redirect) {
      return res.json({ ok: true, ...results });
    }
    res.redirect(`/accounting?flash=ok&msg=${encodeURIComponent(`Sync complete: ${results.done} done, ${results.failed} failed, ${results.skipped} skipped.`)}`);
  } catch (err) {
    if (req.accepts('json')) return res.json({ ok: false, error: err.message });
    res.redirect(`/accounting?flash=err&msg=${encodeURIComponent(err.message)}`);
  }
});

app.post('/orders/:id/xero/sync', requireAuth, async (req, res) => {
  const numId = req.params.id;
  try {
    const result = await syncOrderToXero(numId, req.adminSession.email);
    res.redirect(`/orders/${numId}?success=xero_synced`);
  } catch (err) {
    res.redirect(`/orders/${numId}?success=xero_failed`);
  }
});

// ── Phase 21: Xero customer sync endpoints ────────────────────────────────────

app.get('/api/admin/customers/:id/xero-status', requireAuth, async (req, res) => {
  try {
    const status = await getXeroSyncStatus(req.params.id, xeroRequest, { dryRun: MOCK });
    res.json({ ...status, ok: true });
  } catch (e) {
    res.json({ ok: false, state: 'error', error: e.message });
  }
});

app.post('/api/admin/customers/:id/xero-sync', requireAuth, async (req, res) => {
  const numId = req.params.id;
  try {
    let customer;
    if (MOCK) {
      const c = MOCK_CUSTOMERS.find(c => shopifyNumericId(c.id) === numId);
      customer = c ? { ...c, firstName: (c.displayName||'').split(' ')[0], lastName: (c.displayName||'').split(' ').slice(1).join(' ') } : null;
    } else {
      const r = await shopifyFetch(`query($id:ID!){customer(id:$id){id displayName email firstName lastName
        defaultAddress{company address1 city province zip country}}}`, { id: shopifyCustomerGid(numId) });
      customer = r.data?.customer;
    }
    if (!customer) return res.status(404).json({ ok: false, error: 'Customer not found' });
    const result = await syncCustomerToXero(numId, customer, xeroRequest, { dryRun: MOCK });
    if (result.skipped) return res.json({ ok: true, skipped: result.skipped });
    auditLog(req.adminSession.email, 'xero:customer_sync', shopifyCustomerGid(numId), null, { xeroContactId: result.xeroContactId, created: result.created });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Impersonation ─────────────────────────────────────────────────────────────

function makeImpersonationToken({ nonce, customerId, customerEmail, customerDisplayName, adminEmail, readOnly, exp }) {
  const payload = Buffer.from(JSON.stringify({ v: 1, nonce, cid: customerId, email: customerEmail, name: customerDisplayName, ae: adminEmail, ro: readOnly ? 1 : 0, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', IMPERSONATION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

app.post('/api/admin/customers/:id/impersonate', requireAuth, async (req, res) => {
  if (!IMPERSONATION_SECRET) return res.status(503).json({ ok: false, error: 'B2B_IMPERSONATION_SECRET not configured' });
  const numId = req.params.id;
  const readOnly = req.body.read_only !== 'false' && req.body.read_only !== false;
  const session = req.adminSession;

  let customerEmail = '';
  let customerDisplayName = '';
  if (MOCK) {
    const mc = MOCK_CUSTOMERS.find(c => shopifyNumericId(c.id) === numId);
    if (!mc) return res.status(404).json({ ok: false, error: 'Customer not found' });
    customerEmail = mc.email || '';
    customerDisplayName = mc.displayName || '';
  } else {
    try {
      const r = await shopifyFetch('query($id:ID!){customer(id:$id){id displayName email tags}}', { id: shopifyCustomerGid(numId) });
      const c = r.data?.customer;
      if (!c) return res.status(404).json({ ok: false, error: 'Customer not found' });
      if ((c.tags || []).some(t => ALLOWED_EMAILS.includes(t))) {
        return res.status(403).json({ ok: false, error: 'Cannot impersonate insider accounts' });
      }
      customerEmail = c.email || '';
      customerDisplayName = c.displayName || '';
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  const nonce = crypto.randomBytes(20).toString('hex');
  const exp = Date.now() + 60 * 60 * 1000; // 1 hour
  const customerId = shopifyCustomerGid(numId);

  createImpersonationNonce({ nonce, customerId, customerEmail, customerDisplayName, adminEmail: session.email, readOnly, expiresAt: exp });
  gcImpersonationNonces();

  const token = makeImpersonationToken({ nonce, customerId, customerEmail, customerDisplayName, adminEmail: session.email, readOnly, exp });
  const url = `${PORTAL_BASE_URL}/__impersonate__?tok=${encodeURIComponent(token)}`;

  auditLog(session.email, 'impersonate:token_issued', customerId, null, { customerEmail, customerDisplayName, readOnly, exp: new Date(exp).toISOString() });

  res.json({ ok: true, url, customerDisplayName, readOnly });
});

// ── Phase 23: Customer activity warehouse viewer ──────────────────────────────

app.get('/api/admin/customers/:id/activity', requireAuth, (req, res) => {
  const data = getCustomerActivityFromPortal(req.params.id, req.query);
  res.json({ ok: true, ...data });
});

app.get('/api/admin/customers/:id/activity/lookup', requireAuth, (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  const dayStart = new Date(date + 'T00:00:00Z').getTime();
  const dayEnd   = new Date(date + 'T23:59:59Z').getTime();
  const data = getCustomerActivityFromPortal(req.params.id, {
    from: new Date(date), to: new Date(date),
    type: 'order',
    limit: 10,
  });
  const placed = data.rows.filter(r => r.eventSubtype === 'placed' && r.ts >= dayStart && r.ts <= dayEnd);
  if (placed.length > 0) {
    return res.json({ ok: true, found: true, events: placed });
  }
  // Not found — return context (last login, last cart)
  const context = getCustomerActivityFromPortal(req.params.id, { limit: 1 });
  res.json({ ok: true, found: false, lastLogin: context.lastLogin, lastCart: context.lastCart, date });
});

app.get('/api/admin/customers/:id/active-cart', requireAuth, (req, res) => {
  const cart = getActiveCartFromPortal(req.params.id);
  res.json({ ok: true, ...cart });
});

app.get('/customers/:id/activity', requireAuth, async (req, res) => {
  const numId = req.params.id;
  let customerName = `Customer ${numId}`;
  if (MOCK) {
    customerName = 'Mock Customer';
  } else {
    try {
      const r = await shopifyFetch(`query($id:ID!){customer(id:$id){displayName}}`, { id: `gid://shopify/Customer/${numId}` });
      customerName = r.data?.customer?.displayName || customerName;
    } catch (_) {}
  }

  const now = new Date();
  const ymd = d => d.toISOString().split('T')[0];
  const daysAgo = n => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };

  const fromParam = req.query.from || ymd(daysAgo(7));
  const toParam   = req.query.to   || ymd(now);
  const typeParam = req.query.type  || 'all';
  const qParam    = req.query.q     || '';
  const pageParam = Number(req.query.page) || 1;

  const data = getCustomerActivityFromPortal(numId, {
    from: fromParam, to: toParam, type: typeParam, q: qParam, page: pageParam, limit: 50,
  });

  function fmtTs(ts) {
    return ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : '—';
  }
  function eventBadge(type, subtype) {
    const colors = { auth:'#2086ba', page_view:'#555', api_call:'#777', cart:'#9BBC0E',
      checkout:'#e07b00', order:'#2086ba', account:'#555', error:'#c00', impersonation:'#900' };
    const color = colors[type] || '#666';
    const label = subtype ? `${type}.${subtype}` : type;
    return `<span style="font-size:0.78rem;padding:2px 6px;border-radius:3px;background:${color}1a;color:${color};font-family:monospace">${h(label)}</span>`;
  }

  const typeOptions = ['all','page_view','api_call','auth','cart','checkout','order','account','error','impersonation'];
  const datePresets = [
    { label: 'Today',      from: ymd(now),        to: ymd(now) },
    { label: 'Last 24h',   from: ymd(daysAgo(1)), to: ymd(now) },
    { label: 'Last 7d',    from: ymd(daysAgo(7)), to: ymd(now) },
    { label: 'Last 30d',   from: ymd(daysAgo(30)),to: ymd(now) },
    { label: 'Last 90d',   from: ymd(daysAgo(90)),to: ymd(now) },
  ];

  const rows = data.rows.map(r => `
    <tr class="activity-row" data-detail='${h(JSON.stringify({
      eventData: r.eventData, ipHash: r.ipHash, ipCountry: r.ipCountry,
      userAgent: r.userAgent, impersonationAdmin: r.impersonationAdmin,
      sessionId: r.sessionId ? r.sessionId.slice(0, 12) : null,
    }))}'>
      <td class="text-muted mono" style="font-size:0.8rem;white-space:nowrap">${fmtTs(r.ts)}</td>
      <td>${eventBadge(r.eventType, r.eventSubtype)}</td>
      <td class="mono" style="font-size:0.85rem">${h(r.path || '—')}</td>
      <td class="text-muted mono" style="font-size:0.8rem">${r.httpStatus || '—'}</td>
      <td class="text-muted mono" style="font-size:0.8rem">${r.durationMs != null ? r.durationMs + 'ms' : '—'}</td>
    </tr>
    <tr class="activity-detail-row" style="display:none">
      <td colspan="5" style="padding:0.5rem 1rem;background:#f8f9fa;font-size:0.82rem;border-top:none">
        <span class="text-muted">Loading…</span>
      </td>
    </tr>`).join('');

  const totalPages = Math.ceil(data.total / 50) || 1;
  const pagination = totalPages > 1 ? `
    <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.75rem">
      ${pageParam > 1 ? `<a href="?from=${h(fromParam)}&to=${h(toParam)}&type=${h(typeParam)}&q=${h(qParam)}&page=${pageParam - 1}" class="btn btn-sm btn-secondary">← Prev</a>` : ''}
      <span class="text-muted" style="font-size:0.85rem">Page ${pageParam} / ${totalPages}</span>
      ${pageParam < totalPages ? `<a href="?from=${h(fromParam)}&to=${h(toParam)}&type=${h(typeParam)}&q=${h(qParam)}&page=${pageParam + 1}" class="btn btn-sm btn-secondary">Next →</a>` : ''}
    </div>` : '';

  res.send(layout({ title: `Activity — ${customerName}`, session: req.adminSession, activePath: '/customers',
    extraHead: `<style>
      .activity-row{cursor:pointer;transition:background 0.1s}
      .activity-row:hover{background:#f0f4ff}
      .activity-row.expanded + .activity-detail-row{display:table-row!important}
      .activity-detail-row td{color:#333}
      .quick-lookup-box{background:#f8f9fa;border:1px solid #e0e0e0;border-radius:8px;padding:1rem;margin-bottom:1rem}
      .quick-lookup-result{margin-top:0.75rem;font-size:0.9rem}
    </style>`,
    content: `
    <div class="breadcrumb-row">
      <a href="/customers" class="breadcrumb">← Customers</a>
      <span class="breadcrumb-sep"> / </span>
      <a href="/customers/${h(numId)}" class="breadcrumb">${h(customerName)}</a>
    </div>
    <div class="page-header"><h1>Activity log — ${h(customerName)}</h1>
      <a href="/customers/${h(numId)}" class="btn btn-secondary btn-sm">← Profile</a>
    </div>

    <!-- Quick lookup -->
    <div class="quick-lookup-box">
      <strong style="font-size:0.9rem">Quick lookup: did customer place an order on…</strong>
      <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem">
        <input type="date" id="lookup-date" class="input input-sm" value="${ymd(daysAgo(1))}">
        <button class="btn btn-secondary btn-sm" id="lookup-btn">Check</button>
      </div>
      <div id="lookup-result" class="quick-lookup-result"></div>
    </div>

    <!-- Filters -->
    <div class="filter-bar" style="margin-bottom:1rem">
      <form method="GET" style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
        <select name="from" class="input input-sm" title="From date" onchange="this.form.submit()">
          ${datePresets.map(p => `<option value="${h(p.from)}"${p.from === fromParam && p.to === toParam ? ' selected' : ''}>${h(p.label)}</option>`).join('')}
          <option value="${h(fromParam)}"${!datePresets.some(p => p.from === fromParam) ? ' selected' : ''}>Custom</option>
        </select>
        <input type="date" name="from" class="input input-sm" value="${h(fromParam)}" style="width:130px">
        <span style="font-size:0.85rem;color:#666">to</span>
        <input type="date" name="to"   class="input input-sm" value="${h(toParam)}"   style="width:130px">
        <select name="type" class="input input-sm" onchange="this.form.submit()">
          ${typeOptions.map(t => `<option${t === typeParam ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <input type="text" name="q" class="input input-sm" placeholder="Search path…" value="${h(qParam)}" style="width:160px">
        <button type="submit" class="btn btn-secondary btn-sm">Filter</button>
        <a href="/customers/${h(numId)}/activity" class="btn btn-ghost btn-sm">Reset</a>
      </form>
      <!-- Canned views -->
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap">
        <a href="?type=order&from=${h(ymd(daysAgo(30)))}&to=${h(ymd(now))}" class="btn btn-ghost btn-sm">Orders placed</a>
        <a href="?type=checkout&q=failed&from=${h(ymd(daysAgo(30)))}&to=${h(ymd(now))}" class="btn btn-ghost btn-sm">Failed checkouts</a>
        <a href="?type=error&from=${h(ymd(daysAgo(30)))}&to=${h(ymd(now))}" class="btn btn-ghost btn-sm">Errors</a>
        <a href="?type=auth&from=${h(ymd(daysAgo(30)))}&to=${h(ymd(now))}" class="btn btn-ghost btn-sm">Recent logins</a>
      </div>
    </div>

    <div class="card" style="padding:0">
      <div style="padding:0.75rem 1rem;border-bottom:1px solid #eee;font-size:0.85rem;color:#555">
        Showing ${data.rows.length} of ${data.total} events
        ${data.lastLogin ? `· Last login: ${fmtTs(data.lastLogin.ts)}` : ''}
      </div>
      <table class="data-table">
        <thead><tr><th>Timestamp</th><th>Event</th><th>Path</th><th>Status</th><th>Duration</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:2rem">No activity in this range.</td></tr>'}</tbody>
      </table>
      ${pagination}
    </div>

    <script>
    (function(){
      // Row expand/collapse
      document.querySelectorAll('.activity-row').forEach(function(row){
        row.addEventListener('click', function(){
          row.classList.toggle('expanded');
          var detail = row.nextElementSibling;
          if (!detail) return;
          if (row.classList.contains('expanded') && detail.querySelector('span.text-muted')) {
            try {
              var d = JSON.parse(row.dataset.detail || '{}');
              var parts = [];
              if (d.eventData) parts.push('<strong>Data:</strong> <code style="word-break:break-all">' + JSON.stringify(d.eventData) + '</code>');
              if (d.ipHash)    parts.push('<strong>IP hash:</strong> <code>' + d.ipHash + '</code>');
              if (d.ipCountry) parts.push('<strong>Country:</strong> ' + d.ipCountry);
              if (d.userAgent) parts.push('<strong>UA:</strong> <span style="color:#666">' + d.userAgent.slice(0,100) + '</span>');
              if (d.sessionId) parts.push('<strong>Session:</strong> <code>' + d.sessionId + '…</code>');
              if (d.impersonationAdmin) parts.push('<strong style="color:#900">Impersonated by:</strong> ' + d.impersonationAdmin);
              detail.querySelector('td').innerHTML = parts.length ? parts.join(' &nbsp;·&nbsp; ') : '<em>No extra data</em>';
            } catch(e) { detail.querySelector('td').textContent = 'Parse error'; }
          }
        });
      });

      // Quick lookup
      document.getElementById('lookup-btn').addEventListener('click', function(){
        var date = document.getElementById('lookup-date').value;
        var resultEl = document.getElementById('lookup-result');
        if (!date) return;
        resultEl.innerHTML = '<em>Checking…</em>';
        fetch('/api/admin/customers/${h(numId)}/activity/lookup?date=' + encodeURIComponent(date))
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (d.found) {
              resultEl.innerHTML = '<span style="color:#2a7;font-weight:600">✓ Order placed on ' + date + '</span>: ' +
                d.events.map(function(e){ return '<a href="/orders/' + (e.eventData && e.eventData.order_id ? e.eventData.order_id : '') + '">' +
                  (e.eventData && e.eventData.order_name ? e.eventData.order_name : 'Order') + '</a>' +
                  ' at ' + new Date(e.ts).toISOString().replace('T',' ').slice(0,19);
                }).join(', ');
            } else {
              var msg = '<span style="color:#b00">✗ No order placed on ' + date + '</span>';
              if (d.lastLogin) msg += ' &nbsp;·&nbsp; Last login: ' + new Date(d.lastLogin.ts).toISOString().replace('T',' ').slice(0,16);
              if (d.lastCart)  msg += ' &nbsp;·&nbsp; Last cart activity: ' + new Date(d.lastCart.ts).toISOString().replace('T',' ').slice(0,16);
              resultEl.innerHTML = msg;
            }
          })
          .catch(function(e){ resultEl.textContent = 'Error: ' + e.message; });
      });
    })();
    </script>
  ` }));
});

// ── Phase 24C: Shopify webhook receiver ───────────────────────────────────────

app.post('/webhooks/shopify', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const sig = req.headers['x-shopify-hmac-sha256'];
  if (SHOPIFY_WEBHOOK_SECRET && sig) {
    const expected = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest('base64');
    if (sig !== expected) return res.status(401).json({ error: 'HMAC mismatch' });
  } else if (!MOCK) {
    return res.status(401).json({ error: 'No webhook secret configured' });
  }
  const topic = req.headers['x-shopify-topic'] || '';
  let payload;
  try { payload = JSON.parse(rawBody.toString()); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  // Dispatch to cache upsert (non-blocking)
  setImmediate(() => {
    try {
      if (topic.startsWith('customers/')) {
        const c = payload;
        const shopifyId = String(c.id);
        const tags = Array.isArray(c.tags) ? c.tags : (c.tags || '').split(',').map(s => s.trim()).filter(Boolean);
        upsertCustomerCache({
          shopify_id: shopifyId,
          gid: `gid://shopify/Customer/${shopifyId}`,
          email: c.email, first_name: c.first_name, last_name: c.last_name,
          display_name: c.first_name && c.last_name ? `${c.first_name} ${c.last_name}` : (c.email || shopifyId),
          company: c.default_address?.company || null,
          tags,
          amount_spent_total: parseFloat(c.total_spent) || 0,
          orders_count: c.orders_count || 0,
          default_address_json: c.default_address || null,
          created_at: c.created_at ? new Date(c.created_at).getTime() : null,
          updated_at: c.updated_at ? new Date(c.updated_at).getTime() : null,
        });
      } else if (topic.startsWith('orders/')) {
        const o = payload;
        const shopifyId = String(o.id);
        const custId = o.customer?.id ? String(o.customer.id) : null;
        upsertOrderCache({
          shopify_id: shopifyId,
          gid: `gid://shopify/Order/${shopifyId}`,
          name: o.name, customer_shopify_id: custId,
          created_at: o.created_at ? new Date(o.created_at).getTime() : Date.now(),
          updated_at: o.updated_at ? new Date(o.updated_at).getTime() : null,
          processed_at: o.processed_at ? new Date(o.processed_at).getTime() : null,
          cancelled_at: o.cancelled_at ? new Date(o.cancelled_at).getTime() : null,
          financial_status: o.financial_status, fulfillment_status: o.fulfillment_status,
          display_financial_status: o.financial_status?.toUpperCase(),
          display_fulfillment_status: o.fulfillment_status?.toUpperCase(),
          total_price: parseFloat(o.total_price) || 0,
          subtotal_price: parseFloat(o.subtotal_price) || 0,
          total_tax: parseFloat(o.total_tax) || 0,
          total_shipping: parseFloat(o.total_shipping_price_set?.shop_money?.amount || o.total_shipping_price || 0),
          total_discounts: parseFloat(o.total_discounts) || 0,
          currency: o.currency || 'USD',
          tags: Array.isArray(o.tags) ? o.tags : (o.tags || '').split(',').map(s => s.trim()).filter(Boolean),
          source_name: o.source_name || null,
          note: o.note || null,
          customer_email: o.email || o.customer?.email || null,
          customer_phone: o.phone || o.customer?.phone || null,
        });
        if (o.line_items?.length) {
          upsertOrderLineItemsCache(shopifyId, o.line_items.map(li => ({
            line_id: String(li.id),
            variant_shopify_id: li.variant_id ? String(li.variant_id) : null,
            product_shopify_id: li.product_id ? String(li.product_id) : null,
            sku: li.sku, title: li.title, variant_title: li.variant_title,
            quantity: li.quantity, price: parseFloat(li.price) || 0,
            total_discount: parseFloat(li.total_discount) || 0,
            taxable: li.taxable ? 1 : 0, vendor: li.vendor || null,
          })));
        }
      } else if (topic === 'products/update' || topic === 'products/create') {
        const p = payload;
        const shopifyId = String(p.id);
        upsertProductCache({
          shopify_id: shopifyId, gid: `gid://shopify/Product/${shopifyId}`,
          handle: p.handle, title: p.title, vendor: p.vendor,
          product_type: p.product_type, status: p.status,
          tags: Array.isArray(p.tags) ? p.tags : (p.tags || '').split(',').map(s => s.trim()).filter(Boolean),
          variants_json: p.variants || [],
          created_at: p.created_at ? new Date(p.created_at).getTime() : null,
          updated_at: p.updated_at ? new Date(p.updated_at).getTime() : null,
        });
      }
      auditLog('webhook', `webhook:${topic}`, String(payload.id || ''), null, null);
    } catch (err) {
      console.error('[webhook] cache upsert error:', err.message);
    }
  });

  res.status(200).json({ ok: true, topic });
});

// ── Phase 24C: Background polling sync ────────────────────────────────────────

async function syncRecentFromShopify() {
  if (MOCK || !SHOPIFY_BEARER) return;
  try {
    const state = getSyncState('orders_recent');
    const since = state?.last_synced_at
      ? new Date(state.last_synced_at - 60000).toISOString()
      : new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const result = await shopifyFetch(`
      query($q:String!){
        orders(first:50,query:$q,sortKey:UPDATED_AT,reverse:true){
          edges{node{
            id name processedAt updatedAt createdAt cancelledAt
            displayFinancialStatus displayFulfillmentStatus
            totalPriceSet{shopMoney{amount}}
            subtotalPriceSet{shopMoney{amount}}
            totalTaxSet{shopMoney{amount}}
            customer{id email firstName lastName}
            tags sourceName note
          }}
          pageInfo{hasNextPage}
        }
      }`, { q: `updated_at:>${since}` });
    const edges = result.data?.orders?.edges || [];
    for (const { node: o } of edges) {
      const shopifyId = shopifyNumericId(o.id);
      const custId = o.customer?.id ? shopifyNumericId(o.customer.id) : null;
      upsertOrderCache({
        shopify_id: shopifyId, gid: o.id, name: o.name,
        customer_shopify_id: custId,
        created_at: o.createdAt ? new Date(o.createdAt).getTime() : Date.now(),
        updated_at: o.updatedAt ? new Date(o.updatedAt).getTime() : null,
        processed_at: o.processedAt ? new Date(o.processedAt).getTime() : null,
        cancelled_at: o.cancelledAt ? new Date(o.cancelledAt).getTime() : null,
        financial_status: o.displayFinancialStatus || null,
        fulfillment_status: o.displayFulfillmentStatus || null,
        display_financial_status: o.displayFinancialStatus,
        display_fulfillment_status: o.displayFulfillmentStatus,
        total_price: parseFloat(o.totalPriceSet?.shopMoney?.amount) || 0,
        subtotal_price: parseFloat(o.subtotalPriceSet?.shopMoney?.amount) || 0,
        total_tax: parseFloat(o.totalTaxSet?.shopMoney?.amount) || 0,
        currency: 'USD',
        tags: o.tags || [], source_name: o.sourceName || null, note: o.note || null,
        customer_email: o.customer?.email || null,
      });
    }
    setSyncState('orders_recent', { lastSyncedAt: Date.now(), totalSynced: edges.length });
  } catch (err) {
    console.error('[sync] polling error:', err.message);
    setSyncState('orders_recent', { lastSyncedAt: Date.now(), lastError: err.message });
  }
}

// Start polling every 5 minutes (skips if MOCK or no bearer)
if (!MOCK) {
  setInterval(syncRecentFromShopify, 5 * 60 * 1000);
}

// ── Phase 24E: Unified invoices page ──────────────────────────────────────────

app.get('/invoices', requireAuth, (req, res) => {
  const partials  = getPartialInvoicesAll();
  const xeroMaps  = getXeroInvoiceMaps();
  const cacheOrds = getAllInvoicesForList();
  const xeroSet   = new Set(xeroMaps.map(x => x.order_id));

  const rows = cacheOrds.map(o => {
    const ordNum     = o.shopify_id;
    const hasXero    = xeroSet.has(`gid://shopify/Order/${ordNum}`);
    const xero       = hasXero ? xeroMaps.find(x => x.order_id === `gid://shopify/Order/${ordNum}`) : null;
    const partialInvs = partials.filter(p => p.order_id === `gid://shopify/Order/${ordNum}`);
    return `<tr>
      <td><a href="/orders/${h(ordNum)}" class="link">${h(o.name || `#${ordNum}`)}</a></td>
      <td>${o.customer_name ? `<a href="/customers/${h(o.customer_shopify_id)}" class="link">${h(o.customer_name)}</a>` : h(o.customer_email || '—')}</td>
      <td class="text-muted">${fmtDate(o.created_at ? new Date(o.created_at).toISOString() : null)}</td>
      <td class="text-right mono">${fmtMoney(o.total_price)}</td>
      <td><span class="badge badge-${(o.financial_status||'').toLowerCase()}">${h(o.display_financial_status||o.financial_status||'—')}</span></td>
      <td>${hasXero ? `<span class="badge badge-success">Xero ✓</span> <small class="text-muted">${(xero?.xero_invoice_id||'').slice(0,8)}…</small>` : '<span class="badge badge-secondary">No Xero</span>'}</td>
      <td>${partialInvs.length ? partialInvs.map(p => `<a href="/orders/${h(ordNum)}/invoice.pdf?letter=${p.invoice_letter}" class="link">#${ordNum}-${p.invoice_letter}</a>`).join(' ') : `<a href="/orders/${h(ordNum)}/invoice.pdf" class="link btn btn-ghost btn-xs">PDF</a>`}</td>
    </tr>`;
  });

  const emptyState = cacheOrds.length === 0
    ? '<tr><td colspan="7" class="empty-state">No invoices cached yet. Run the backfill script to import order history.</td></tr>'
    : '';

  res.send(layout({ title: 'Invoices', session: req.adminSession, activePath: '/invoices', content: `
    <h1>Invoices</h1>
    <p class="text-muted">Unified view across all orders, Xero invoices, and partial invoices.</p>
    <div class="table-wrap">
      <table class="data-table" id="invoices-table">
        <thead><tr>
          <th>Order</th><th>Customer</th><th>Date</th>
          <th class="text-right">Total</th><th>Status</th><th>Xero</th><th>Invoice PDF</th>
        </tr></thead>
        <tbody>${rows.join('') || emptyState}</tbody>
      </table>
    </div>
  ` }));
});

// Static
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`fww-b2b-admin listening on http://127.0.0.1:${PORT} (MOCK=${MOCK})`);
});
